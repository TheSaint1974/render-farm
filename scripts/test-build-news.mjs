#!/usr/bin/env node
/**
 * Offline check for the news builder: serves RSS and Atom fixtures over
 * localhost, runs scripts/build-news.mjs against them, and asserts the output.
 *
 *   node scripts/test-build-news.mjs
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const iso = (daysAgo) =>
  new Date(Date.now() - daysAgo * 86400000).toUTCString();

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Fixture Wire</title>
    <item>
      <title><![CDATA[Bambu Lab ships an H2D &amp; friends]]></title>
      <link>https://www.example-news.com/a/bambu-h2d/?utm_source=rss&amp;utm_medium=feed</link>
      <pubDate>${iso(1)}</pubDate>
      <description><![CDATA[<p>A <b>very</b> big printer &mdash; details inside.</p>]]></description>
      <media:content url="https://cdn.example-news.com/h2d.jpg" medium="image"/>
    </item>
    <item>
      <title>Duplicate headline test</title>
      <link>https://example-news.com/a/dupe</link>
      <pubDate>${iso(2)}</pubDate>
      <content:encoded><![CDATA[<img src="https://cdn.example-news.com/dupe.png"/>Body text.]]></content:encoded>
    </item>
    <item>
      <title>Way too old to matter</title>
      <link>https://www.example-news.com/a/ancient</link>
      <pubDate>${iso(400)}</pubDate>
    </item>
    <item>
      <title>Missing link is skipped</title>
      <pubDate>${iso(1)}</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fixture Atom</title>
  <entry>
    <title>Atom entry about metal AM</title>
    <link rel="edit" href="https://other.example.org/edit/1"/>
    <link rel="alternate" href="https://other.example.org/posts/metal-am"/>
    <published>${new Date(Date.now() - 3 * 86400000).toISOString()}</published>
    <summary type="html">&lt;p&gt;Laser powder bed fusion news.&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Duplicate headline test</title>
    <link rel="alternate" href="https://other.example.org/posts/dupe-again"/>
    <published>${new Date(Date.now() - 4 * 86400000).toISOString()}</published>
  </entry>
</feed>`;

const routes = {
  '/rss': { body: RSS, type: 'application/rss+xml' },
  '/atom': { body: ATOM, type: 'application/atom+xml' },
  '/broken': { status: 500, body: 'boom', type: 'text/plain' },
  '/empty': { body: '<rss><channel></channel></rss>', type: 'application/xml' },
};

const server = createServer((req, res) => {
  const route = routes[req.url];
  if (!route) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(route.status || 200, { 'Content-Type': route.type });
  res.end(route.body);
});

function run(cmd, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolvePromise({ code, out }));
  });
}

let tmp;
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  tmp = await mkdtemp(join(tmpdir(), 'rf-news-'));
  const feedsFile = join(tmp, 'feeds.json');
  const outFile = join(tmp, 'out.json');

  await writeFile(
    feedsFile,
    JSON.stringify({
      sources: [
        // First candidate 500s — the builder must fall through to the second.
        {
          name: 'Fixture Wire',
          site: 'https://example-news.com/',
          candidates: [`${base}/broken`, `${base}/rss`],
        },
        {
          name: 'Fixture Atom',
          site: 'https://other.example.org/',
          candidates: [`${base}/atom`],
        },
        // Every candidate fails — must be tolerated, not fatal.
        {
          name: 'Fixture Dead',
          site: 'https://dead.example.net/',
          candidates: [`${base}/empty`, `${base}/nope`],
        },
      ],
    }),
  );

  const env = { NEWS_FEEDS_FILE: feedsFile, NEWS_OUT_FILE: outFile };

  const build = await run('node', ['scripts/build-news.mjs', '--days', '7'], env);
  assert.equal(build.code, 0, `builder exited ${build.code}\n${build.out}`);

  const data = JSON.parse(await readFile(outFile, 'utf8'));
  const titles = data.items.map((i) => i.title);
  const urls = data.items.map((i) => i.url);

  assert.equal(data.sourcesHealthy, 2, 'two of three sources should be healthy');
  assert.equal(data.sourcesTotal, 3);

  // Entities and CDATA decoded, HTML stripped from the summary.
  const bambu = data.items.find((i) => i.title.startsWith('Bambu'));
  assert.ok(bambu, 'RSS item missing — fallback candidate did not kick in');
  assert.equal(bambu.title, 'Bambu Lab ships an H2D & friends');
  assert.equal(bambu.summary, 'A very big printer — details inside.');
  assert.equal(bambu.image, 'https://cdn.example-news.com/h2d.jpg');
  assert.equal(bambu.source, 'Fixture Wire');

  // utm params stripped, www dropped, trailing slash normalized.
  assert.equal(bambu.url, 'https://example-news.com/a/bambu-h2d');

  // Atom <link rel="alternate"> wins over rel="edit".
  const atomItem = data.items.find((i) => i.source === 'Fixture Atom');
  assert.equal(atomItem.url, 'https://other.example.org/posts/metal-am');
  assert.equal(atomItem.summary, 'Laser powder bed fusion news.');

  // content:encoded <img> used as the fallback image.
  const dupe = data.items.find((i) => i.title === 'Duplicate headline test');
  assert.equal(dupe.image, 'https://cdn.example-news.com/dupe.png');

  // Same headline from two feeds collapses to one entry.
  assert.equal(
    titles.filter((t) => t === 'Duplicate headline test').length,
    1,
    'duplicate headline was not deduped',
  );

  // Out-of-window and malformed items dropped.
  assert.ok(!titles.includes('Way too old to matter'), 'stale item leaked in');
  assert.ok(!titles.includes('Missing link is skipped'), 'linkless item leaked in');

  // Newest first.
  const times = data.items.map((i) => Date.parse(i.publishedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'items not sorted newest-first');

  assert.equal(new Set(urls).size, urls.length, 'duplicate URLs in output');
  assert.equal(data.itemCount, data.items.length);

  // --verify writes nothing and reports health.
  const verify = await run('node', ['scripts/build-news.mjs', '--verify'], {
    ...env,
    NEWS_OUT_FILE: join(tmp, 'should-not-exist.json'),
  });
  assert.equal(verify.code, 0, `verify exited ${verify.code}\n${verify.out}`);
  assert.match(verify.out, /2\/3 sources healthy/);

  // Total feed failure must not clobber a good existing roundup.
  const deadFeeds = join(tmp, 'dead.json');
  await writeFile(
    deadFeeds,
    JSON.stringify({
      sources: [{ name: 'Dead', site: 'https://x.test/', candidates: [`${base}/nope`] }],
    }),
  );
  const dead = await run('node', ['scripts/build-news.mjs'], {
    NEWS_FEEDS_FILE: deadFeeds,
    NEWS_OUT_FILE: outFile,
  });
  assert.equal(dead.code, 1, 'builder should fail when every source is down');
  const untouched = JSON.parse(await readFile(outFile, 'utf8'));
  assert.equal(untouched.itemCount, data.itemCount, 'existing roundup was overwritten');

  console.log(`All checks passed — ${data.itemCount} items from ${data.sourcesHealthy} sources.`);
} finally {
  server.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
}
