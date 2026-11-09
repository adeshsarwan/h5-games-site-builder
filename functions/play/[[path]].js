/**
 * /play/<slug>/...  — serves a game from the shared R2 catalogue on THIS site's domain,
 * with THIS site's GAM ad units.
 *
 *   /play/<slug>/                 -> the game's index.html (ad unit strings swapped, optional <base> for CDN mode)
 *   /play/<slug>/gam-config.js    -> the game's own gam-config.js with this site's ad unit paths
 *   /play/<slug>/<anything else>  -> proxied from games.gamewhame.com (proxy mode only)
 *
 * Ad units are resolved in this order:
 *   1. site.json ads.mode "test" / "off", or no domain        -> Google's public sample units
 *      ("off" = no portal ads yet; games keep sample units so rewarded/continue flows still work)
 *   2. site.json ads.games[<slug>]                            (set per site via the Launch API)
 *   3. games.gamewhame.com/<slug>/sites/<siteKey>/ads.json   (written by your GAM automator)
 *   4. site.json ads.gameUnitPattern                         -> e.g. /123/example.com_water_sort_rewarded
 */
import SITE from "../_generated/site.js";

const CDN = "https://games.gamewhame.com";
const SLUG_RE = /^[a-z0-9-]+$/;
// Any GAM ad unit path that ends in _rewarded / _interstitial / _native (string literals or HTML comments).
const UNIT_RE = /\/\d{4,}\/[A-Za-z0-9._\-]+?_(rewarded|interstitial|native)\b/g;
const TEST_UNITS = {
  rewarded: "/22639388115/rewarded_web_example",
  interstitial: "/6355419/Travel/Europe/France/Paris",
  native: "/6355419/Travel/Europe/France/Paris",
};

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const parts = ctx.params.path || [];
  const slug = parts[0];
  if (!slug || !SLUG_RE.test(slug) || !SITE.games.includes(slug)) {
    return new Response("Game not found", { status: 404 });
  }
  const rest = parts.slice(1).join("/");

  // Relative asset URLs inside index.html need the trailing slash.
  if (!rest && !url.pathname.endsWith("/")) {
    return Response.redirect(`${url.origin}/play/${slug}/`, 301);
  }
  if (!rest || rest === "index.html") return gameHtml(slug);
  if (rest === "gam-config.js") return gamConfig(slug);
  if (SITE.assets === "cdn") return Response.redirect(`${CDN}/${slug}/${rest}`, 302);
  return proxy(slug, rest, ctx.request);
}

async function siteUnits(slug) {
  if (SITE.ads.mode === "test" || SITE.ads.mode === "off" || !SITE.domain) return TEST_UNITS;
  const own = SITE.ads.games && SITE.ads.games[slug];
  if (own && own.rewarded && own.interstitial && own.native) return own;
  try {
    const r = await fetch(`${CDN}/${slug}/sites/${SITE.key}/ads.json`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) {
      const j = await r.json();
      if (j && j.rewarded && j.interstitial && j.native) return j;
    }
  } catch (_) { /* fall through */ }
  const game = slug.replace(/-/g, "_");
  const make = (kind) =>
    SITE.ads.gameUnitPattern
      .replace("{network}", SITE.ads.networkCode)
      .replace("{domain}", SITE.domain)
      .replace("{game}", game)
      .replace("{kind}", kind);
  return { rewarded: make("rewarded"), interstitial: make("interstitial"), native: make("native") };
}

function swapUnits(text, units) {
  return text.replace(UNIT_RE, (_m, kind) => units[kind] || _m);
}

async function gameHtml(slug) {
  const r = await fetch(`${CDN}/${slug}/index.html`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) return new Response("Game unavailable", { status: 502 });
  let html = swapUnits(await r.text(), await siteUnits(slug));

  // gam-config.js must always come from this site (it carries this site's units).
  html = html.replace(/src=(["'])gam-config\.js\1/, `src="/play/${slug}/gam-config.js"`);
  const head = [`<meta name="robots" content="noindex">`];
  if (SITE.assets === "cdn") head.unshift(`<base href="${CDN}/${slug}/">`);
  html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n${head.join("\n")}`);

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300",
      "x-robots-tag": "noindex",
    },
  });
}

async function gamConfig(slug) {
  const r = await fetch(`${CDN}/${slug}/gam-config.js`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) {
    return new Response(`/* ${slug}: no gam-config.js in R2 */`, {
      status: 404,
      headers: { "content-type": "application/javascript" },
    });
  }
  const js = swapUnits(await r.text(), await siteUnits(slug));
  return new Response(js, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300",
    },
  });
}

async function proxy(slug, rest, request) {
  const isBuild = rest.startsWith("Build/") || rest.startsWith("StreamingAssets/");
  const upstream = await fetch(`${CDN}/${slug}/${rest}`, {
    headers: { "accept-encoding": request.headers.get("accept-encoding") || "br, gzip" },
    cf: { cacheEverything: true, cacheTtl: isBuild ? 2592000 : 3600 },
  });
  const res = new Response(upstream.body, upstream);
  res.headers.set("cache-control", isBuild ? "public, max-age=86400" : "public, max-age=3600");
  res.headers.delete("set-cookie");
  return res;
}
