#!/usr/bin/env node
/**
 * Publishes data/3d-printing-news.json into a Shopify shop metafield so the
 * theme section can render it server-side (fast, and visible to crawlers).
 *
 *   SHOPIFY_STORE_DOMAIN=rendrfarm.myshopify.com \
 *   SHOPIFY_ADMIN_TOKEN=shpat_… \
 *   node scripts/push-to-shopify.mjs
 *
 * The metafield lands at shop.metafields.rendr.news_3d_printing, readable in
 * Liquid. The definition is created on first run and reused after that.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IN_FILE = resolve(ROOT, 'data/3d-printing-news.json');

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';

const NAMESPACE = 'rendr';
const KEY = 'news_3d_printing';

if (!STORE || !TOKEN) {
  console.error(
    'Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN — skipping Shopify push.',
  );
  process.exit(1);
}

const ENDPOINT = `https://${STORE.replace(/^https?:\/\//, '')}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Admin API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const body = JSON.parse(text);
  if (body.errors) {
    throw new Error(`Admin API errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

/**
 * Create the metafield definition with storefront read access. Without a
 * definition the value exists but Liquid can't see it. Re-running is a no-op.
 */
async function ensureDefinition() {
  const data = await gql(
    `mutation CreateDef($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }`,
    {
      definition: {
        name: '3D Printing News',
        namespace: NAMESPACE,
        key: KEY,
        description: 'Weekly 3D printing news roundup, generated automatically.',
        type: 'json',
        ownerType: 'SHOP',
        access: { storefront: 'PUBLIC_READ' },
      },
    },
  );

  const errors = data.metafieldDefinitionCreate.userErrors || [];
  const alreadyExists = errors.some((e) => e.code === 'TAKEN');
  if (alreadyExists) {
    console.log('Metafield definition already exists.');
    return;
  }
  if (errors.length > 0) {
    throw new Error(`Could not create definition: ${JSON.stringify(errors)}`);
  }
  console.log('Created metafield definition rendr.news_3d_printing.');
}

async function main() {
  const payload = await readFile(IN_FILE, 'utf8');
  const parsed = JSON.parse(payload);

  await ensureDefinition();

  const { shop } = await gql('{ shop { id myshopifyDomain } }');
  console.log(`Pushing to ${shop.myshopifyDomain}…`);

  const data = await gql(
    `mutation SetNews($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id updatedAt }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: shop.id,
          namespace: NAMESPACE,
          key: KEY,
          type: 'json',
          value: JSON.stringify(parsed),
        },
      ],
    },
  );

  const errors = data.metafieldsSet.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`metafieldsSet failed: ${JSON.stringify(errors)}`);
  }

  console.log(
    `Published ${parsed.itemCount} news items to shop.metafields.${NAMESPACE}.${KEY}.`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
