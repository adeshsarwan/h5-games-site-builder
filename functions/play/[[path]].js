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
 *
 * site.json "playHost" (e.g. play.gametuno.com, a second custom domain on the same Pages project): the portal loads the
 * iframe from that host. Responses there get Origin-Agent-Cluster: ?1, and GPT inside the game is told the portal's
 * page URL so in-game ads are reported for the portal domain.
 *
 * Edge cache: only 2xx responses are cached. 404/5xx are never cached, so a game uploaded after a first failed request
 * starts working right away (a 30-day cached 404 is what broke Just Riddles).
 */
import SITE from "../_generated/site.js";

const CDN = "https://games.gamewhame.com";
// Bump to move every upstream fetch to fresh cache keys (escapes anything stuck in the edge cache, no purge needed).
const CACHE_V = "2";
const up = (p) => `${CDN}/${p}?cv=${CACHE_V}`;
const ttl = (ok404 = 0, ok = 300) => ({ cacheTtlByStatus: { "200-299": ok, "404": ok404, "500-599": 0 } });
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
  const onPlayHost = !!SITE.playHost && url.hostname === SITE.playHost;
  const res = await route(slug, rest, url, ctx.request);
  if (onPlayHost) {
    const out = new Response(res.body, res);
    out.headers.set("origin-agent-cluster", "?1");
    out.headers.set("x-robots-tag", "noindex");
    return out;
  }
  return res;
}

async function route(slug, rest, url, request) {

  // Relative asset URLs inside index.html need the trailing slash.
  if (!rest && !url.pathname.endsWith("/")) {
    return Response.redirect(`${url.origin}/play/${slug}/`, 301);
  }
  if (!rest || rest === "index.html") return gameHtml(slug, !!SITE.playHost && url.hostname === SITE.playHost);
  if (rest === "gam-config.js") return gamConfig(slug);
  if (SITE.assets === "cdn") return Response.redirect(`${CDN}/${slug}/${rest}`, 302);
  return proxy(slug, rest, request);
}

async function siteUnits(slug) {
  if (SITE.ads.mode === "test" || SITE.ads.mode === "off" || !SITE.domain) return TEST_UNITS;
  const own = SITE.ads.games && SITE.ads.games[slug];
  if (own && own.rewarded && own.interstitial && own.native) return own;
  try {
    // Most games have no ads.json yet, so a 404 here is normal: cache it for 60 s (not 0) to keep game loads fast.
    const r = await fetch(up(`${slug}/sites/${SITE.key}/ads.json`), { cf: ttl(60) });
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

async function gameHtml(slug, onPlayHost) {
  const r = await fetch(up(`${slug}/index.html`), { cf: ttl() });
  if (!r.ok) return new Response("Game unavailable", { status: 502, headers: { "cache-control": "no-store" } });
  let html = swapUnits(await r.text(), await siteUnits(slug));

  // gam-config.js must always come from this site (it carries this site's units).
  html = html.replace(/src=(["'])gam-config\.js\1/, `src="/play/${slug}/gam-config.js"`);
  const head = [`<meta name="robots" content="noindex">`, `<script>${LOADER_JS}</script>`];
  // On play.<domain>, GPT would report the iframe URL; tell it the portal page the game is shown on.
  if (onPlayHost && SITE.domain) head.unshift(`<script>window.googletag=window.googletag||{cmd:[]};googletag.cmd.push(function(){googletag.pubads().set("page_url","https://${SITE.domain}/game/${slug}/")})</script>`);
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
  const r = await fetch(up(`${slug}/gam-config.js`), { cf: ttl() });
  if (!r.ok) {
    return new Response(`/* ${slug}: no gam-config.js in R2 */`, {
      status: 404,
      headers: { "content-type": "application/javascript", "cache-control": "no-store" },
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
  const upstream = await fetch(up(`${slug}/${rest}`), {
    headers: { "accept-encoding": request.headers.get("accept-encoding") || "br, gzip" },
    cf: ttl(0, isBuild ? 2592000 : 3600),
  });
  const res = new Response(upstream.body, upstream);
  // Browsers must not keep a 404 either (they did, for a day).
  res.headers.set("cache-control", !upstream.ok ? "no-store" : isBuild ? "public, max-age=86400" : "public, max-age=3600");
  res.headers.delete("set-cookie");
  return res;
}

/* Injected at the top of every game's <head>. All 27 templates already draw a progress bar from onProgress; this adds:
 *  - taps/clicks on the canvas are ignored until createUnityInstance resolves (no work queued behind wasm compile);
 *  - once downloads finish (progress >= 0.9, where Unity sits while it compiles and starts), a "Starting…" line with a
 *    compositor-only animation, so the screen doesn't look frozen during the long main-thread tasks;
 *  - if loading fails, or downloads stall for 25 s (90 s once at 0.9), a "Tap to retry" screen instead of the template's blocking alert().
 * It wraps createUnityInstance from a capture-phase load listener, which runs before the template's script.onload.
 * If a template never calls it (unknown layout), input is unblocked 8 s after window load. */
const LOADER_JS = `(function(){var done=0,last=Date.now(),p=0,ui,msg,st=document.createElement("style");
st.textContent="canvas{pointer-events:none!important}#h5l{position:fixed;left:0;right:0;bottom:12%;z-index:2147483646;text-align:center;font:600 14px/1.4 system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none;display:none}#h5l i{display:block;width:120px;height:4px;margin:8px auto 0;border-radius:2px;background:linear-gradient(90deg,transparent,#fff,transparent);background-size:50% 100%;background-repeat:no-repeat;animation:h5l 1s linear infinite}@keyframes h5l{from{background-position:-100% 0}to{background-position:200% 0}}#h5l.err{pointer-events:auto;top:0;bottom:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer}#h5l.err i{display:none}#h5l.err b{margin-top:12px;padding:10px 22px;border-radius:22px;background:#fff;color:#111;text-shadow:none}";
document.head.appendChild(st);
function show(t,err){if(!ui){ui=document.createElement("div");ui.id="h5l";document.body.appendChild(ui)}ui.className=err?"err":"";ui.innerHTML=t+(err?"<b>Tap to retry</b>":"<i></i>");ui.style.display=err?"flex":"block";if(err)ui.onclick=function(){location.reload()}}
function finish(){done=1;st.remove();ui&&ui.remove();removeEventListener("pointerdown",block,true)}
function fail(){if(done)return;done=2;show("Couldn't load the game.",1)}
function block(e){if(!done&&e.target&&e.target.closest&&e.target.closest("canvas,#unity-container")){e.stopImmediatePropagation()}}
["pointerdown","pointerup","mousedown","mouseup","touchstart","touchend","click"].forEach(function(t){addEventListener(t,block,true)});
var wrapped=0,iv=setInterval(function(){if(done)return clearInterval(iv);if(Date.now()-last>(p<.9?25000:90000))fail()},2000);
addEventListener("load",function(){setTimeout(function(){if(!wrapped&&!done){done=1;finish()}},8000)});
document.addEventListener("load",function(e){var f=window.createUnityInstance;if(!f||f.__h5)return;
var w=function(c,cfg,onp){return new Promise(function(res){f(c,cfg,function(x){if(x!==p){p=x;last=Date.now()}if(x>=.9&&!done)show("Starting game…");onp&&onp(x)}).then(function(i){finish();res(i)},function(m){console.error(m);fail()})})};
w.__h5=1;wrapped=1;window.createUnityInstance=w},true);})();`;
