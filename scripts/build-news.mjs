#!/usr/bin/env node
/**
 * Builds the weekly 3D printing news roundup for the RENDR FARM storefront.
 *
 * Reads scripts/feeds.json, fetches every source, keeps the items published in
 * the last N days, dedupes them, and writes data/3d-printing-news.json.
 *
 *   node scripts/build-news.mjs                  # build the roundup
 *   node scripts/build-news.mjs --days 14        # widen the window
 *   node scripts/build-news.mjs --verify         # report per-source health, write nothing
 *
 * No dependencies — Node 18+ (global fetch) is all it needs.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so the test harness can point at fixtures.
const FEEDS_FILE = process.env.NEWS_FEEDS_FILE
  ? resolve(process.env.NEWS_FEEDS_FILE)
  : resolve(ROOT, 'scripts/feeds.json');
const OUT_FILE = process.env.NEWS_OUT_FILE
  ? resolve(process.env.NEWS_OUT_FILE)
  : resolve(ROOT, 'data/3d-printing-news.json');

const USER_AGENT =
  'Mozilla/5.0 (compatible; RENDRFarmNewsBot/1.0; +https://rendrfarm.com)';
const FETCH_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------- CLI options

function parseArgs(argv) {
  const opts = {
    days: 7,
    maxItems: 12,
    maxPerSource: 3,
    minItems: 6,
    verify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify') opts.verify = true;
    else if (arg === '--days') opts.days = Number(argv[++i]);
    else if (arg === '--max-items') opts.maxItems = Number(argv[++i]);
    else if (arg === '--max-per-source') opts.maxPerSource = Number(argv[++i]);
    else if (arg === '--min-items') opts.minItems = Number(argv[++i]);
  }
  return opts;
}

// ------------------------------------------------------------- XML/text utils

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', trade: '™',
  reg: '®', copy: '©', deg: '°', euro: '€', pound: '£',
};

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key)
        ? ENTITIES[key]
        : match;
    });
}

function stripCdata(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/**
 * Turn raw feed markup into clean single-line plain text.
 *
 * Entities are decoded before tags are stripped, because Atom feeds routinely
 * carry escaped markup (<summary type="html">&lt;p&gt;…). Decoding afterwards
 * would leave those tags behind as literal text. A second decode pass handles
 * entities that were themselves escaped inside that markup.
 */
function toPlainText(str) {
  if (!str) return '';
  return decodeEntities(
    decodeEntities(stripCdata(str))
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** First value for any of the given tag names, as raw inner markup. */
function tagValue(block, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
    const match = block.match(re);
    if (match && match[1].trim()) return match[1];
  }
  return '';
}

function attrValue(tagMarkup, attr) {
  const match = tagMarkup.match(
    new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i'),
  );
  return match ? decodeEntities(match[1]) : '';
}

function truncate(str, max) {
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// ------------------------------------------------------------- link handling

/** Strip tracking junk so the same article from two feeds dedupes cleanly. */
function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.protocol = 'https:';
    url.hostname = url.hostname.replace(/^www\./i, '');
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function extractLink(block) {
  // Atom: <link rel="alternate" href="..."/> — prefer alternate, then any href.
  const linkTags = block.match(/<link\b[^>]*\/?>/gi) || [];
  let fallbackHref = '';
  for (const tag of linkTags) {
    const href = attrValue(tag, 'href');
    if (!href) continue;
    const rel = attrValue(tag, 'rel');
    if (!rel || rel.toLowerCase() === 'alternate') return href;
    if (!fallbackHref) fallbackHref = href;
  }

  // RSS: <link>https://…</link>
  const inner = toPlainText(tagValue(block, 'link'));
  if (/^https?:\/\//i.test(inner)) return inner;

  const guid = toPlainText(tagValue(block, 'guid', 'id'));
  if (/^https?:\/\//i.test(guid)) return guid;

  return fallbackHref;
}

function extractImage(block) {
  for (const tagName of ['media:content', 'media:thumbnail', 'enclosure']) {
    const tags = block.match(
      new RegExp(`<${tagName}\\b[^>]*\\/?>`, 'gi'),
    ) || [];
    for (const tag of tags) {
      const type = attrValue(tag, 'type');
      const medium = attrValue(tag, 'medium');
      const url = attrValue(tag, 'url');
      if (!url) continue;
      const looksLikeImage =
        /^image\//i.test(type) ||
        medium.toLowerCase() === 'image' ||
        (!type && !medium && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url));
      if (looksLikeImage) return url;
    }
  }

  const content = stripCdata(
    tagValue(block, 'content:encoded', 'content', 'description', 'summary'),
  );
  const img = content.match(/<img\b[^>]*>/i);
  if (img) {
    const src = attrValue(img[0], 'src');
    if (src) return src;
  }
  return '';
}

function extractDate(block) {
  const raw = toPlainText(
    tagValue(block, 'pubDate', 'published', 'updated', 'dc:date', 'date'),
  );
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// --------------------------------------------------------------- feed parsing

function parseFeed(xml, source) {
  const blocks =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) ||
    xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ||
    [];

  const items = [];
  for (const block of blocks) {
    const title = toPlainText(tagValue(block, 'title'));
    const link = extractLink(block);
    if (!title || !link) continue;

    const summary = toPlainText(
      tagValue(block, 'description', 'summary', 'content:encoded', 'content'),
    );
    const publishedAt = extractDate(block);

    items.push({
      title: truncate(title, 160),
      url: normalizeUrl(link),
      summary: summary ? truncate(summary, 220) : '',
      image: extractImage(block),
      source: source.name,
      sourceSite: source.site,
      publishedAt: publishedAt ? publishedAt.toISOString() : null,
    });
  }
  return items;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Try each candidate URL for a source; first one that yields items wins. */
async function loadSource(source) {
  const attempts = [];
  for (const url of source.candidates) {
    try {
      const xml = await fetchText(url);
      const items = parseFeed(xml, source);
      if (items.length === 0) {
        attempts.push({ url, error: 'parsed 0 items' });
        continue;
      }
      return { source, url, items, attempts };
    } catch (err) {
      attempts.push({ url, error: err.message || String(err) });
    }
  }
  return { source, url: null, items: [], attempts };
}

// ----------------------------------------------------------------- selection

function dedupe(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const out = [];
  for (const item of items) {
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seenUrls.has(item.url) || seenTitles.has(titleKey)) continue;
    seenUrls.add(item.url);
    seenTitles.add(titleKey);
    out.push(item);
  }
  return out;
}

/**
 * Pick the roundup: newest first, at most `maxPerSource` per outlet so one
 * prolific site can't crowd out the rest, capped at `maxItems`.
 */
function selectItems(items, { maxItems, maxPerSource }) {
  const perSource = new Map();
  const picked = [];
  const overflow = [];

  for (const item of items) {
    const used = perSource.get(item.source) || 0;
    if (used < maxPerSource) {
      perSource.set(item.source, used + 1);
      picked.push(item);
    } else {
      overflow.push(item);
    }
    if (picked.length >= maxItems) break;
  }

  // Backfill from overflow if the per-source cap left us short.
  for (const item of overflow) {
    if (picked.length >= maxItems) break;
    picked.push(item);
  }

  return picked.slice(0, maxItems).sort(byDateDesc);
}

function byDateDesc(a, b) {
  const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
  const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
  return bt - at;
}

// ---------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(FEEDS_FILE, 'utf8'));
  const sources = config.sources || [];

  console.log(`Fetching ${sources.length} feeds…`);
  const results = await Promise.all(sources.map(loadSource));

  const status = results.map((r) => ({
    source: r.source.name,
    ok: r.items.length > 0,
    feedUrl: r.url,
    itemsFound: r.items.length,
    errors: r.attempts,
  }));

  for (const entry of status) {
    if (entry.ok) {
      console.log(`  ok    ${entry.source} — ${entry.itemsFound} items (${entry.feedUrl})`);
    } else {
      const why = entry.errors.map((e) => `${e.url}: ${e.error}`).join('; ');
      console.warn(`  FAIL  ${entry.source} — ${why || 'no candidates'}`);
    }
  }

  const healthy = status.filter((s) => s.ok).length;

  if (opts.verify) {
    console.log(`\n${healthy}/${sources.length} sources healthy.`);
    process.exit(healthy === 0 ? 1 : 0);
  }

  if (healthy === 0) {
    console.error('\nNo sources returned items — refusing to overwrite the existing roundup.');
    process.exit(1);
  }

  const all = dedupe(
    results.flatMap((r) => r.items).filter((i) => i.publishedAt).sort(byDateDesc),
  );

  // Start at the requested window and widen only if the week was quiet. The
  // ladder stops at 4x rather than reaching back indefinitely — a short section
  // beats presenting months-old articles as this week's news.
  let windowDays = opts.days;
  let selected = [];
  for (const days of [opts.days, opts.days * 2, opts.days * 4]) {
    windowDays = days;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const inWindow = all.filter((i) => Date.parse(i.publishedAt) >= cutoff);
    selected = selectItems(inWindow, opts);
    if (selected.length >= opts.minItems) break;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays,
    itemCount: selected.length,
    sourcesHealthy: healthy,
    sourcesTotal: sources.length,
    items: selected,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(
    `\nWrote ${selected.length} items to data/3d-printing-news.json ` +
      `(${windowDays}-day window, ${healthy}/${sources.length} sources healthy).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
