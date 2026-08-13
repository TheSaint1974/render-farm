# 3D Printing News section

A self-updating section for the RENDR FARM storefront. Every Monday morning a
GitHub Action reads the major additive-manufacturing publications, keeps the
past week's headlines, and publishes them to the store. Nobody has to touch it.

## How it works

```
  9 RSS/Atom feeds
        │
        ▼
  scripts/build-news.mjs      last 7 days, deduped, max 3 per outlet
        │
        ├──► data/3d-printing-news.json          (committed to this repo)
        │
        ▼
  scripts/push-to-shopify.mjs
        │
        ▼
  shop metafield  rendr.news_3d_printing
        │
        ▼
  shopify/sections/3d-printing-news.liquid       renders on the storefront
```

The section reads the metafield in Liquid, so headlines are in the HTML on
first paint — fast, and visible to search engines. No app subscription and no
third-party script.

## One-time setup

### 1. Add the section to your theme

In Shopify admin: **Online Store → Themes → ⋯ → Edit code → Sections →
Add a new section**, name it `3d-printing-news`, and paste the contents of
[`shopify/sections/3d-printing-news.liquid`](../shopify/sections/3d-printing-news.liquid),
replacing the starter content. Save.

Then open the theme editor, go to the page you want it on, click
**Add section**, and pick **3D Printing News**. Heading, colours, column count,
and how many headlines to show are all editable there. The defaults use the
RENDR FARM blue (`#29ABE2`) on the dark background.

### 2. Create a Shopify access token

In Shopify admin: **Settings → Apps and sales channels → Develop apps →
Create an app**. Name it something like `RENDR News Bot`, then under
**Configuration → Admin API integration** enable these scopes:

- `write_metaobject_definitions` and `read_metaobject_definitions`
- `write_metafield_definitions` and `read_metafield_definitions`
- `write_shop_metafields` (listed as **Shop metafields** if your admin groups it that way)

Install the app and copy the **Admin API access token** (starts with `shpat_`).
It is shown once.

### 3. Add the repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Value |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | `your-store.myshopify.com` (the `.myshopify.com` domain, not `rendrfarm.com`) |
| `SHOPIFY_ADMIN_TOKEN` | the `shpat_…` token from step 2 |

Without these the workflow still refreshes `data/3d-printing-news.json` — it
just skips the storefront push and says so in the log.

### 4. Kick off the first run

GitHub → **Actions → Weekly 3D printing news → Run workflow**. After it
finishes, reload your storefront page and the headlines appear.

## Day-to-day

**Change the schedule.** Edit the `cron` line in
`.github/workflows/3d-printing-news.yml`. It is currently `12 7 * * 1` —
Mondays at 07:12 UTC, about 3:12 am Toronto time. Cron there is always UTC.

**Add or remove a publication.** Edit `scripts/feeds.json`. Each source can
list several candidate URLs; the builder uses the first that parses, so a site
reorganising its feed does not break the section. Nothing else needs changing.

**Check feed health.**

```bash
npm run news:verify
```

Prints one line per source and exits non-zero if every source is down. Worth
running after editing `scripts/feeds.json`.

**Build locally without publishing.**

```bash
npm run news:build          # writes data/3d-printing-news.json
npm run news:build -- --days 14 --max-items 9
```

**Run the parser tests.**

```bash
npm test
```

These run offline against fixtures — no network needed. CI runs them before
every refresh.

## Editorial rules baked in

- **Last 7 days only.** If the week is quiet the window widens to 14 then 28
  days, and stops there. It will show fewer headlines rather than pass off
  month-old articles as this week's news.
- **Max 3 per outlet**, so one prolific publisher cannot fill the whole grid.
- **Deduped** by URL and by headline, since the same story often runs in
  several feeds. Tracking parameters are stripped before comparing.
- **Newest first**, capped at 12 items (6 shown by default).
- Outbound links are `rel="noopener noreferrer nofollow"` and open in a new tab,
  so you are not passing link equity to other publications or losing the visitor.

## If something looks wrong

**Section is empty.** The metafield has not been written yet. Run the workflow
manually, and check the "Publish to the Shopify storefront" step in the log.

**Section is empty but the workflow succeeded.** The metafield definition needs
storefront read access — `scripts/push-to-shopify.mjs` sets this when it creates
the definition. If the definition already existed without it, open **Settings →
Custom data → Shop** in Shopify admin, find *3D Printing News*, and enable
storefront access.

**One publication stopped appearing.** Run `npm run news:verify`. If that source
reports `FAIL`, find its current feed URL and add it to the front of that
source's `candidates` list in `scripts/feeds.json`.

**Workflow cannot push.** The repository needs **Settings → Actions → General →
Workflow permissions** set to *Read and write permissions*.

## The fallback path

The section also accepts a **Fallback JSON URL** in the theme editor. If you set
it and leave the metafield empty, the section fetches that URL in the browser
instead. This exists for the case where you would rather not create a Shopify
token — point it at the raw
`data/3d-printing-news.json` on a public GitHub Pages site or
`raw.githubusercontent.com` URL, both of which send permissive CORS headers.

It is the weaker option: the headlines are not in the server-rendered HTML, so
they are invisible to search engines and appear a beat later for the visitor.
Prefer the metafield unless you have a reason not to. Note that the raw-URL
route only works if the repository is public.
