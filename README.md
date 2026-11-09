# H5 Games Site Builder

Builds Poki-style game portals from one shared catalogue of Unity WebGL games stored in Cloudflare R2
(`gamewhame-files`, served at `https://games.gamewhame.com`). One repo, many sites: each site is a
folder in `sites/` and its own Cloudflare Pages project.

```
sites/<key>/site.json        one file per portal: name, domain, colours, games, ad settings
catalog/games.json           titles, descriptions, how-to-play, categories (synced from R2)
build.mjs                    static site generator (no dependencies)
src/styles.css, src/app.js   design + tiny runtime (search, player, recently played, GPT)
functions/play/[[path]].js   serves /play/<slug>/ on the site's own domain with the site's ad units
scripts/sync-catalog.mjs     add new games to catalog/games.json from R2
```

## How a site works

| URL | What it is |
|---|---|
| `/` | Home: tile grid with big featured tiles, an ad tile, categories |
| `/game/<slug>/` | Game page: player surrounded by tiles, description, how to play, screenshots |
| `/category/<name>/` | Category grid |
| `/play/<slug>/` | The game itself (loaded in the page's iframe, `noindex`) |
| `/media/<slug>/…` | WebP icons, tiles, covers, screenshots, copied from R2 at build time |

Speed choices: pages are pre-rendered HTML with CSS inlined (about 23 KB for the home page), one small deferred JS
file, WebP images with exact sizes and lazy loading, and GPT loaded only after the page is idle. Images come
from the site's own domain (Pages CDN). Game files are cached at Cloudflare's edge for a month.

## Ads

**Portal pages (GPT):** slots are listed in `site.json → ads.siteSlots`. With `"mode": "test"` they use
Google's sample unit; with `"mode": "live"` they use `ads.siteUnits[<slot>]` if set, else `siteUnitPattern`, e.g. `/23360556473/example.com_game_side`.

**Inside the games:** every game's `gam-config.js` keeps working unchanged. When a site serves
`/play/<slug>/`, the Function swaps every ad unit string ending in `_rewarded`, `_interstitial` or
`_native` for this site's unit. Units are looked up in this order:

1. `"mode": "test"` (or no domain yet): Google's public sample units
2. `site.json → ads.games[<slug>]` (`{ rewarded, interstitial, native }`, set with the Launch API; goes live with the rebuild)
3. `games.gamewhame.com/<slug>/sites/<siteKey>/ads.json` (written by your GAM automator, same shape; live within 5 minutes, no rebuild):
   ```json
   { "rewarded": "/23360556473/example.com_water_sort_rewarded",
     "interstitial": "/23360556473/example.com_water_sort_interstitial",
     "native": "/23360556473/example.com_water_sort_native" }
   ```
4. `gameUnitPattern`, e.g. `/{network}/{domain}_{game}_{kind}`, where `{game}` is the slug with `_` instead of `-`

## Add a new site

**With the Launch API** (recommended): `POST https://sitebuilder.thebesads.com/api/v1/games/sites { "domain": "…", "name": "…" }`
does all of the steps below (plus GA4 and Search Console) and reports progress. Game text, categories and per-site
settings/ad units are edited through the same API — see `docs/GAMES_API.md` in `adeshsarwan/site-builder`.

**By hand:**

1. Copy `sites/demo/` to `sites/<newkey>/` and edit `site.json` (name, domain, theme colours, featured games,
   `ads.mode`, `adsTxt` lines). Commit and push.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → this repo.
   - Build command: `node build.mjs`
   - Build output directory: `dist`
   - Environment variable: `SITE` = `<newkey>` (and `NODE_VERSION` = `20`)
3. After the first deploy: **Custom domains → Set up a custom domain** → the site's domain.
4. Create the GAM units for that domain, upload `ads.json` files to R2, and switch `ads.mode` to `"live"`.

Sites launched by the API only rebuild when their own folder, the catalogue or the shared code changes (build watch paths).

## Add or update a game

1. Upload the build to R2 as `<slug>/` (Brotli, Decompression Fallback **off**, Data Caching **on**).
   Replacing the whole folder deletes `media/` and `catalog/`, so re-upload those afterwards, or only replace `Build/`.
2. Upload `<slug>/media/` (WebP icon, tile, cover, screenshots) and `<slug>/catalog/game.json`.
3. `node scripts/sync-catalog.mjs <slug>`, commit, push (or `POST /api/v1/games { "slug": "…" }` on the Launch API).
   Edit titles, descriptions, how to play and categories in `catalog/games.json` (or `PATCH /api/v1/games/<slug>`);
   `sync-catalog` never overwrites existing games unless you pass `--refresh <slug>`. `"disabled": true` hides a game on every site.
4. Purge `games.gamewhame.com/<slug>/` in Cloudflare caching if you replaced an existing build.

## Local preview

```
SITE=demo node build.mjs
npx wrangler@3 pages dev dist      # serves pages + the /play/ Function on http://localhost:8788
```

## `assets` setting

- `"proxy"` (default): game files go through the site's Function, so everything is on one domain. Each game
  load uses about 8–12 Function requests (the Pages free plan includes 100,000 a day).
- `"cdn"`: only `index.html` and `gam-config.js` go through the Function; the rest load straight from
  `games.gamewhame.com` with a shared cache. This needs the R2 bucket's CORS policy to allow the site's origin
  (or `*`) for `GET`/`HEAD`.

## Extra content (mobile game guides, blog, own legal pages)

A site can add content beyond the H5 games with `"content"` in `site.json`:

```json
"content": { "dir": "torunex-site", "replaceNames": { "Gamez Adda": "Torunex" }, "excludeApps": [] }
```

Files in `content/<dir>/` (all optional):

| File | Builds |
|---|---|
| `apps.json` | `/mobile-games/` and `/mobile-games/<slug>/` (info, facts, official store links, screenshots, guide text) |
| `posts.json` | `/blog/` and `/blog/<slug>/` |
| `pages.json` | `about`, `privacy`, `terms`, `contact` HTML that replaces the built-in legal pages |
| `home.json` | home-page intro / "mobile games" text and the popular list |

Import them from a Gamez Adda-style site with the **Import site content** GitHub Action (inputs: site key, source URL),
or locally: `npm i --no-save linkedom && node scripts/import-gamezadda.mjs <siteKey> <sourceUrl>`.
Images are copied to the site's own `/media/` at build time; brand names are swapped at build time with `replaceNames`.

**`"ads": { "mode": "off" }`** builds with no ad slots and no GPT on portal pages (for sites whose ads come later,
e.g. from the Price Optimiser script). Inside the games, Google's sample units stay so rewarded flows keep working.
`site.json → headHtml` (array of strings) is injected into every page's `<head>` for that later script.
