# H5 Games Site Builder: Spec & API Integration Guide

How the H5 game portal builder works, what is configured in Cloudflare, and how to create new game sites
programmatically from an existing site-building API (the same API that builds job sites).

- **Repo:** `github.com/adeshsarwan/h5-games-site-builder` (branch `main`)
- **First site:** PlayPop demo, live at `https://play-pop-demo.pages.dev` (Google test ads)
- **Game storage:** Cloudflare R2 bucket `gamewhame-files`, served at `https://games.gamewhame.com`
- **Cloudflare account ID:** `4df8c97b1058bcf322f39d3dc24001f3`, zone `gamewhame.com`

---

## 1. Architecture

```
                       ┌──────────────────────────────────────────┐
  Visitor ──► site.com │ Cloudflare Pages project (one per site)  │
                       │  /                 static HTML (tile grid)│
                       │  /game/<slug>/     static game page       │
                       │  /category/<cat>/  static category page   │
                       │  /media/<slug>/…   WebP copied at build   │
                       │  /play/<slug>/…    Pages Function ────────┼──► games.gamewhame.com (R2)
                       └──────────────────────────────────────────┘     <slug>/index.html, Build/*,
                                                                         gam-config.js, gam-manager.js,
                                                                         media/*, catalog/game.json,
                                                                         sites/<siteKey>/ads.json
```

- **One repo, many sites.** Each site is a folder `sites/<siteKey>/site.json` plus its own Cloudflare Pages
  project with the environment variable `SITE=<siteKey>`.
- **One shared copy of each game** lives in R2. Every site serves it under its own domain at `/play/<slug>/`,
  so the domain looks uniform and Ad Manager sees the site's own domain on every ad request.
- **Per-site ad units** are swapped in at request time by the `/play/` Function. No game rebuilds and no
  per-site copies of games are needed.

---

## 2. R2 layout (`gamewhame-files`)

```
<slug>/                          e.g. water-sort/
  index.html                     custom Unity template (loads gam-config.js + gam-manager.js)
  gam-config.js                  the game's own GAM ad unit paths (format varies per game)
  gam-manager.js                 GPT logic + Unity bridge (WebGLAdCallbackReceiver)
  Build/<slug>.loader.js
  Build/<slug>.framework.js.br   Brotli, Decompression Fallback OFF
  Build/<slug>.wasm.br
  Build/<slug>.data.br
  StreamingAssets/
  media/                         ← added by this project (WebP)
    icon-512.webp  icon-192.webp  thumb-1x1.webp (400px)  cover-16x9.webp (1280x720)
    screens/01-1080.webp 01-540.webp …   media.json (sizes, orientation)
  catalog/game.json              ← title, tagline, description, how_to_play, categories, orientation, Play Store link
  sites/<siteKey>/ads.json       ← per-site GAM units (written by the GAM automator)
h5-games/                        separate catalogue, NOT used by this project
```

**Rules for uploading builds (developer):** Unity WebGL with Compression **Brotli**, Decompression Fallback
**OFF**, Data Caching **ON**; lowercase-hyphen slug folder; `index.html` exactly. **Only replace `Build/`
when updating a game.** Replacing the whole folder deletes `media/`, `catalog/` and `sites/`. After
re-uploading a build, purge `games.gamewhame.com/<slug>/` in Cloudflare.

### `ads.json` (one per site per game)

```json
{
  "rewarded":     "/23360556473/example.com_water_sort_rewarded",
  "interstitial": "/23360556473/example.com_water_sort_interstitial",
  "native":       "/23360556473/example.com_water_sort_native"
}
```
Path: `<slug>/sites/<siteKey>/ads.json`. Picked up within 5 minutes; no rebuild.

---

## 3. Cloudflare configuration already in place (zone `gamewhame.com`)

**Cache Rules**
| Name | Expression | Edge TTL | Browser TTL |
|---|---|---|---|
| Game pages & ad config | `(http.host eq "games.gamewhame.com")` | 5 min (ignore origin) | Bypass |
| Game builds & media | `(http.host eq "games.gamewhame.com" and (http.request.uri.path contains "/Build/" or http.request.uri.path contains "/StreamingAssets/" or http.request.uri.path contains "/media/"))` | 1 month | 1 day |

**Response Header Transform Rules** (7 total)
| Rule | Match | Header |
|---|---|---|
| Unity Brotli Encoding | path ends `.br` | `Content-Encoding: br` |
| Unity Wasm Content Type | path ends `.wasm.br` | `Content-Type: application/wasm` |
| Unity .js.br type | host + ends `.js.br` | `Content-Type: application/javascript` |
| Unity .data.br type | host + ends `.data.br` | `Content-Type: application/octet-stream` |
| Unityweb Brotli | host + ends `.unityweb` | `Content-Encoding: br` |
| Unityweb wasm type | host + ends `.wasm.unityweb` | `Content-Type: application/wasm` |
| Unityweb js type | host + ends `.js.unityweb` | `Content-Type: application/javascript` |

Not changed: Early Hints / 0-RTT (not toggleable in the new dashboard on this plan; small gain).
R2 CORS currently allows only `https://gamewhame.com` (only matters for `"assets": "cdn"` mode, §6).

---

## 4. Repo layout

```
sites/<key>/site.json        one file per portal
catalog/games.json           all games (synced from R2 catalog/game.json)
build.mjs                    zero-dependency static generator → dist/
src/styles.css               Poki-style design (inlined into every page)
src/app.js                   search, player, fullscreen/immersive mobile play, recently played, lazy GPT
functions/play/[[path]].js   /play/<slug>/ Function (ad unit swap + proxy)
functions/_generated/site.js written by build.mjs for the Function
scripts/sync-catalog.mjs     refresh catalog/games.json from R2
```

### `site.json` schema

```json
{
  "key": "demo",
  "name": "PlayPop",
  "domain": "",                         // "" until a custom domain is attached (forces test ads)
  "tagline": "Free online games…",
  "description": "SEO description for home page",
  "language": "en",
  "theme": { "background": "#bfe3ff", "backgroundAlt": "#d9efff", "accent": "#ff3d77",
             "accentText": "#ffffff", "text": "#0b2a4a", "tile": "#ffffff" },
  "logo": { "text": "PlayPop", "mark": "P" },
  "games": "all",                       // or ["water-sort", "beer-pong", …]
  "exclude": ["jigsaw-ultimate"],
  "featured": ["water-sort", "beer-pong"],
  "categories": ["Puzzle","Casual","Word","Arcade","Casino","Sports","Action","Brain"],
  "ads": {
    "mode": "test",                     // "test" | "live"
    "networkCode": "23360556473",
    "gameUnitPattern": "/{network}/{domain}_{game}_{kind}",   // fallback when no ads.json
    "siteUnitPattern": "/{network}/{domain}_{slot}",
    "siteSlots": {
      "game_side":  [[300,250],[300,600],[160,600]],
      "home_rect":  [[300,250]],
      "game_below": [[728,90],[320,100],[320,50]]
    }
  },
  "assets": "proxy",                    // "proxy" | "cdn" (see §6)
  "adsTxt": ["google.com, pub-XXXX, DIRECT, f08c47fec0942fa0"],
  "contactEmail": "",
  "analytics": { "ga4": "" }
}
```

### Generated pages
`/`, `/game/<slug>/`, `/category/<cat>/`, `/about/`, `/privacy/`, `/terms/`, `404.html`, `search.json`,
`sitemap.xml` (when `domain` set), `robots.txt` (disallows `/play/`), `ads.txt` (when `adsTxt` set),
`favicon.svg`, `manifest.webmanifest`, `_headers`. Game pages include VideoGame JSON-LD and OG tags.
The build leaves out any game whose `media/` is missing in R2 and prints a warning.

---

## 5. Ad unit resolution (inside games)

Each game's `gam-config.js` comes in one of three formats (plain strings, `adUnitPath` objects, `adUnit` objects),
but every unit is a string matching:

```
/\/\d{4,}\/[A-Za-z0-9._\-]+?_(rewarded|interstitial|native)\b/g
```

When serving `/play/<slug>/` and `/play/<slug>/gam-config.js`, the Function replaces each match by kind:

1. `games.gamewhame.com/<slug>/sites/<siteKey>/ads.json` if present
2. `ads.mode === "test"` or no `domain` → Google's sample units
   (`/22639388115/rewarded_web_example`, `/6355419/Travel/Europe/France/Paris`)
3. `gameUnitPattern` (e.g. `/23360556473/example.com_water_sort_rewarded`)

It also rewrites `<script src="gam-config.js">` to the site's copy and adds `noindex`.

**Portal page ads (GPT):** `.ad` grid slots from `siteSlots`; GPT is loaded after the page is idle, with lazy
loading and collapsed empty divs. Test mode uses `/6355419/Travel/Europe/France/Paris`.

---

## 6. Asset modes

| Mode | How game files load | Cost / requirement |
|---|---|---|
| `proxy` (default) | Through the site's Function, everything on one domain | About 8–12 Function requests per game start (Pages free: 100k/day; Workers Paid $5/mo for 10M) |
| `cdn` | Only `index.html` + `gam-config.js` via the Function; `<base>` points at `games.gamewhame.com` | R2 CORS must allow the site's origin (or `*`) for GET/HEAD; all sites share one edge cache |

---

## 7. Creating a site via your API

Your job-site API can create H5 game sites with the same five steps. Store per site:
`siteKey`, `domain`, `name`, `theme`, `featured`, `adsMode`, `networkCode`, Pages project name.

### Step 1: Write `sites/<siteKey>/site.json` to GitHub
```http
PUT https://api.github.com/repos/adeshsarwan/h5-games-site-builder/contents/sites/{siteKey}/site.json
Authorization: Bearer <GITHUB_TOKEN>        # fine-grained token, Contents: read/write on this repo
{
  "message": "Add site {siteKey}",
  "content": "<base64 of site.json>",
  "branch": "main"
  // include "sha" of the existing file when updating
}
```

### Step 2: Create the Pages project (connected to the repo)
```http
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects
Authorization: Bearer <CF_API_TOKEN>        # permission: Account → Cloudflare Pages: Edit
{
  "name": "{pagesProjectName}",
  "production_branch": "main",
  "source": {
    "type": "github",
    "config": {
      "owner": "adeshsarwan",
      "repo_name": "h5-games-site-builder",
      "production_branch": "main",
      "deployments_enabled": true,
      "production_deployments_enabled": true
    }
  },
  "build_config": { "build_command": "node build.mjs", "destination_dir": "dist", "root_dir": "" },
  "deployment_configs": {
    "production": { "env_vars": {
      "SITE": { "type": "plain_text", "value": "{siteKey}" },
      "NODE_VERSION": { "type": "plain_text", "value": "20" }
    } }
  }
}
```
The Cloudflare GitHub app must already have access to the repo (it does, from the first site).
Trigger the first build with `POST …/pages/projects/{name}/deployments`.

### Step 3: Attach the custom domain
```http
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{name}/domains
{ "name": "example.com" }
```
If the domain's DNS is on Cloudflare, the CNAME is created automatically; otherwise point a CNAME to
`{name}.pages.dev`. Then set `"domain": "example.com"` in `site.json` (step 1 again).

### Step 4: Create GAM ad units and write `ads.json` to R2
For each game slug: create `{domain}_{game}_rewarded|interstitial|native` in GAM (your automator), then:
```http
PUT https://{account_id}.r2.cloudflarestorage.com/gamewhame-files/{slug}/sites/{siteKey}/ads.json
# S3 API with an R2 token (Object Read & Write on gamewhame-files); Content-Type: application/json
```
Also add the site-level units (`{domain}_game_side`, `{domain}_home_rect`, `{domain}_game_below`).

### Step 5: Go live
Set `"ads": { "mode": "live" }` and `adsTxt` in `site.json` (step 1). Add a consent banner (Google CMP)
before serving real ads in the EEA/UK.

### Scaling tips
- **Build watch paths:** each Pages project rebuilds on every push. With many sites, set each project's
  *Build watch paths* to include `sites/{siteKey}/**`, `src/**`, `build.mjs`, `functions/**`,
  `catalog/**`, so a single site edit doesn't rebuild all sites.
- **Catalogue updates:** `node scripts/sync-catalog.mjs <newSlug>` then commit; all sites pick it up.
- **Per-site game lists:** use `"games": [..]` / `"exclude"` to vary portals and avoid duplicate-content
  footprints across many sites; vary `name`, `theme`, `featured`, and description text per site.

---

## 8. Game catalogue (27 Ignia Games titles)

| Slug | Play Store package | Notes |
|---|---|---|
| dot-connect-mania | com.gp.ds.flowdotconnectmania | |
| number-merge-2048 | com.gp.ha.numbermerge2048puzzle | |
| maze-quest | com.gp.ds.mazequestpathfinder | gam-config.js / gam-manager.js missing in R2 → ads broken |
| water-sort | com.gp.ds.watercolorsortmania | gam-config.js / gam-manager.js missing in R2 → ads broken |
| block-puzzle-blast | com.hypercasual.gp.BlockPuzzleBlastp2e | |
| word-quest-cross-word-puzzle | com.gp.happyadda.wordquestcrossword | |
| dice-merge-mania | com.gp.ds.dicemergemania | `.unityweb` (fixed by header rule) |
| ball-rolling-puzzle | com.gp.ds.BallRollingPuzzle | |
| beer-pong | com.gp.ds.beerpong | description mentions real money / crypto, rewrite before live ads |
| link-the-dot | com.gp.ha.linkthedotspuzzlequest | |
| stupid-birds | com.dumadugames.stupidbirds | |
| buccarat | com.dumadugames.baccarat | |
| just-riddles | com.ha.gp.englishriddlepuzzles | |
| math-cross-mania | com.ha.gp.crossmathpuzzle | |
| flick-pool | com.ha.gp.flickpoolpuzzle | |
| word-pic | com.gp.ds.pics4word | |
| basketball-arcade | com.dumadu.basketballarcade | |
| jigsaw-ultimate | com.gp.dumadu.jigsawpuzzle | 727 MB build, excluded |
| roulette | com.dumadugames.roulette | |
| dream-run | com.dumadugames.dreamrun | |
| pair-match-3d | com.happyadda.matchnsortpuzzle | |
| craps | com.dumadugames.craps | |
| farkle-blast | com.dumadugames.farkleblast | |
| unblock-puzzle | com.gp.ds.unblockpuzzle | rebuilt as `.br`; media/catalog need re-upload |
| wrench-master-mind-twist | com.gp.ds.wrenchmastermindtwist | |
| one-line-path | com.gp.ds.onelinepathconnect | |
| death-tube | com.dumadugames.gp.deathtube | |

Media source: Play Store listings (developer "Ignia Games"), converted to WebP. 6 games had a Play Store
"How to play"; the other 21 have written 3-step instructions (`how_to_play_source: "written"`).

---

## 9. Open items

1. Re-upload `unblock-puzzle/media/` and `unblock-puzzle/catalog/` (deleted when the build folder was replaced).
2. Upload the missing `gam-config.js` + `gam-manager.js` for maze-quest and water-sort.
3. Rewrite Play Store descriptions for the web and for ad policy (casino titles, Beer Pong's real-money/crypto copy).
4. Rotate the R2 access key that was shared in chat (`0d87dd88…`).
5. Add Google CMP consent before switching any site to `"mode": "live"`.
6. Rebuild Jigsaw Ultimate with asset bundles before including it.
7. Optional: switch to `"assets": "cdn"` after setting R2 CORS to allow site origins (saves Function requests).
