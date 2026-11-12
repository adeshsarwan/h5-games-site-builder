#!/usr/bin/env node
/**
 * Builds one portal site into ./dist
 *   SITE=demo node build.mjs          (Cloudflare Pages: set SITE as an environment variable)
 *
 * - Reads sites/<SITE>/site.json and catalog/games.json
 * - Downloads each game's WebP media from R2 (games.gamewhame.com/<slug>/media/) into dist/media so
 *   images are served from the site's own domain by Pages' CDN (no Function calls, no extra DNS lookups)
 * - Writes static HTML for home, game pages, category pages, legal pages, sitemap, robots, ads.txt, _headers
 * - Writes functions/_generated/site.js for the /play/<slug>/ Function
 */
import { readFile, writeFile, mkdir, rm, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SITE_KEY = process.env.SITE || process.argv[2] || "demo";
const CDN = "https://games.gamewhame.com";
const OUT = path.join(ROOT, "dist");
const CACHE = path.join(ROOT, ".cache", "media");

const site = JSON.parse(await readFile(path.join(ROOT, "sites", SITE_KEY, "site.json"), "utf8"));
const catalog = JSON.parse(await readFile(path.join(ROOT, "catalog", "games.json"), "utf8"));
site.key = SITE_KEY;
const origin = site.domain ? `https://${site.domain}` : "";

// ---------- games for this site ----------
let games = site.games === "all" ? catalog : catalog.filter((g) => site.games.includes(g.slug));
games = games.filter((g) => !(site.exclude || []).includes(g.slug) && g.title && !g.disabled); // disabled = off on every site
const featured = (site.featured || []).filter((s) => games.some((g) => g.slug === s));
games.sort((a, b) => {
  const fa = featured.indexOf(a.slug), fb = featured.indexOf(b.slug);
  if (fa !== fb) return (fa === -1 ? 999 : fa) - (fb === -1 ? 999 : fb);
  return a.title.localeCompare(b.title);
});
const bySlug = Object.fromEntries(games.map((g) => [g.slug, g]));
const cats = (site.categories || []).filter((c) => games.some((g) => g.categories.includes(c)));
const CAT_ICON = { Puzzle: "🧩", Casual: "🎈", Word: "🔤", Arcade: "🕹️", Casino: "🎰", Sports: "⚽", Action: "⚡", Brain: "🧠", Cards: "🃏" };
const catSlug = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// ---------- extra content (mobile game guides, blog, own legal pages): content/<dir>/ ----------
const C = await (async () => {
  if (!site.content) return null;
  const dir = path.join(ROOT, "content", site.content.dir || SITE_KEY);
  const load = async (f, d) => (existsSync(path.join(dir, f)) ? JSON.parse(await readFile(path.join(dir, f), "utf8")) : d);
  const names = Object.entries(site.content.replaceNames || {});
  const swap = (v) => typeof v === "string" ? names.reduce((x, [a, b]) => x.split(a).join(b), v)
    : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
  // "{site}" in any content file becomes this site's name, so one content folder can serve several sites.
  const tok = (v) => typeof v === "string" ? v.split("{site}").join(site.name)
    : Array.isArray(v) ? v.map(tok) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tok(x)])) : v;
  const out = tok(swap({ apps: await load("apps.json", []), posts: await load("posts.json", []), pages: await load("pages.json", {}), home: await load("home.json", {}) }));
  out.play = await load("play.json", {});          // live Google Play data (scripts/sync-play.mjs, daily)
  out.ed = tok(await load("editorial.json", { reviews: {}, lists: [] })); // our own reviews and best-of lists
  // Games we added ourselves (content/<dir>/extra-apps.json: [{ pkg, path? }]); facts and images come from play.json.
  const have = new Set(out.apps.map((a) => (a.googlePlay?.match(/[?&]id=([^&#]+)/) || [])[1]));
  for (const e of await load("extra-apps.json", [])) {
    const p = out.play[e.pkg];
    if (!p || have.has(e.pkg)) continue;
    const pth = e.path || p.title.replace(/[™®:'’]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    out.apps.push({ slug: pth.toLowerCase(), path: pth, title: e.title || p.title, genre: `Game ${p.genre}`, developer: p.developer, googlePlay: `https://play.google.com/store/apps/details?id=${e.pkg}`, html: "", screenshots: [], icon: "", extra: true });
    have.add(e.pkg);
  }
  const ex = site.content.excludeApps || [];
  out.apps = out.apps.filter((a) => !ex.includes(a.slug));
  return out;
})();

// ---------- helpers ----------
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (s = "", n = 155) => (s.length > n ? s.slice(0, s.lastIndexOf(" ", n - 1)) + "…" : s);
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const minCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{}:;,>])\s*/g, "$1").replace(/;}/g, "}").trim();
// Strip the web-unfriendly bits Play Store copy tends to contain.
const webify = (s = "") =>
  s.replace(/\b(download|install)(\s+(it|now|the game|today))?\s*(and|&)?/gi, (m) => (/and|&/.test(m) ? "Play now and" : "Play now"))
   .replace(/\b(on your (phone|device|android))\b/gi, "in your browser")
   .replace(/\n{3,}/g, "\n\n").trim();

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18h2"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M9 17h6"/></svg>',
  blog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// ---------- ad helpers ----------
function siteUnit(slot) {
  if (site.ads.mode === "test" || !site.domain) return "/6355419/Travel/Europe/France/Paris";
  if (site.ads.siteUnits?.[slot]) return site.ads.siteUnits[slot]; // set per site via the Launch API
  return site.ads.siteUnitPattern.replace("{network}", site.ads.networkCode).replace("{domain}", site.domain).replace("{slot}", slot);
}
// Native banner containers filled by the Price Optimiser script (same ids as gamezadda.store): one of each per page.
const NATIVE = !!site.ads.nativeSlots;
const gamNative = (n) => NATIVE ? `<div id="gam-native-0${n}-wrapper" class="gam-ad-wrapper" aria-label="Advertisement" aria-busy="true"><div class="gam-ad-label">Advertisement</div><div id="gam-native-0${n}" class="gam-native-slot" style="width:100%;min-height:250px"></div></div>` : "";
const ADS_OFF = site.ads.mode === "off"; // no ad slots or GPT on portal pages (ads added later, e.g. by Price Optimiser)
function adSlot(slot, cls = "") {
  if (ADS_OFF) return "";
  const sizes = site.ads.siteSlots?.[slot];
  if (!sizes) return "";
  return `<div class="ad ${cls}" data-unit="${esc(siteUnit(slot))}" data-sizes='${JSON.stringify(sizes)}'></div>`;
}

// ---------- media ----------
async function fetchTo(url, file) {
  if (existsSync(file)) return true;
  const r = await fetch(url);
  if (!r.ok) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(await r.arrayBuffer()));
  return true;
}
async function syncMedia(g) {
  const files = ["thumb-1x1.webp", "icon-192.webp", "icon-512.webp", "cover-16x9.webp"];
  const n = g.media?.screens?.length || 0;
  for (let i = 1; i <= Math.min(n, 6); i++) {
    const p = String(i).padStart(2, "0");
    files.push(`screens/${p}-540.webp`);
  }
  const ok = await Promise.all(files.map((f) => fetchTo(`${CDN}/${g.slug}/media/${f}`, path.join(CACHE, g.slug, f)).catch(() => false)));
  if (!ok.slice(0, 4).every(Boolean)) return false; // icon/tile/cover missing -> leave the game out of this build
  await cp(path.join(CACHE, g.slug), path.join(OUT, "media", g.slug), { recursive: true });
  return true;
}

// ---------- templates ----------
let CSS = minCss(await readFile(path.join(ROOT, "src", "styles.css"), "utf8"));
const t = site.theme;
const V = site.design === "vibrant"; // bold "sticker" design (torunex.site); default design otherwise
if (V) CSS += minCss(await readFile(path.join(ROOT, "src", "vibrant.css"), "utf8"));
const themeCss = `:root{--bg:${t.background};--bg2:${t.backgroundAlt};--accent:${t.accent};--accentText:${t.accentText};--text:${t.text};--tile:${t.tile}}`;
const JS = await readFile(path.join(ROOT, "src", "app.js"), "utf8");
const JS_FILE = `/assets/app.${hash(JS)}.js`;

function tile(g, size = "", lazy = true, badge = "") {
  const px = size === "s3" ? 314 : size === "s2" ? 204 : 94;
  return `<a class="tile ${size}" href="/game/${g.slug}/">${badge ? `<span class="badge">${badge}</span>` : ""}<img src="/media/${g.slug}/${px > 94 ? "thumb-1x1" : "icon-192"}.webp" srcset="/media/${g.slug}/icon-192.webp 192w, /media/${g.slug}/thumb-1x1.webp 400w, /media/${g.slug}/icon-512.webp 512w" sizes="${px}px" width="${px}" height="${px}" alt="${esc(g.title)}"${lazy ? ' loading="lazy" decoding="async"' : ' fetchpriority="high"'}><span class="t">${esc(g.title)}</span></a>`;
}
const brand = () => V ? "" : `<div class="brand"><a class="logo" href="/" aria-label="${esc(site.name)} home"><span class="mark">${esc(site.logo.mark)}</span>${esc(site.logo.text)}</a><nav><a href="/" aria-label="Home">${ICON.home}</a>${LISTS().length ? `<a href="/best/" aria-label="Best games">${ICON.trophy}</a>` : ""}${C?.apps.length ? `<a href="/topgames/" aria-label="Mobile games">${ICON.phone}</a>` : ""}${C?.posts.length ? `<a href="/blog/" aria-label="Blog">${ICON.blog}</a>` : ""}<button data-search aria-label="Search games">${ICON.search}</button></nav></div>`;
const catTiles = () => `</div><nav class="cats" aria-label="Categories">${cats.map((c) => `<a class="cat" href="/category/${catSlug(c)}/"><i>${CAT_ICON[c] || "🎮"}</i>${esc(c)} games</a>`).join("")}</nav><div class="grid">`;

function page({ title, desc, canonical, body, head = "", ogImage = "", jsonld = null, robots = "", slim = false }) {
  const url = origin + canonical;
  const siteJs = { games: Object.fromEntries(games.map((g) => [g.slug, g.title])) };
  return `<!doctype html><html lang="${site.language || "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${origin ? `<link rel="canonical" href="${url}">` : ""}${robots ? `<meta name="robots" content="${robots}">` : ""}
<meta name="theme-color" content="${t.background}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(site.name)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${ogImage ? `<meta property="og:image" content="${origin}${ogImage}"><meta name="twitter:card" content="summary_large_image">` : ""}
${ADS_OFF ? "" : '<link rel="preconnect" href="https://securepubads.g.doubleclick.net">'}${head}${(site.headHtml || []).join("")}
${V ? '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@600;700;800;900&display=swap" rel="stylesheet">' : ""}
<style>${themeCss}${CSS}</style>${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
<script>window.__SITE__=${JSON.stringify(siteJs)}</script><script defer src="${JS_FILE}"></script>${site.analytics?.ga4 ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${site.analytics.ga4}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${site.analytics.ga4}')</script>` : ""}
</head><body${V ? ' class="v"' : ""}>${V ? vHeader(slim) : ""}<main class="wrap">${body}</main>
${V ? vFooter() : ""}<footer${V ? " hidden" : ""}><a href="/">All games</a>${cats.map((c) => `<a href="/category/${catSlug(c)}/">${esc(c)}</a>`).join("")}${LISTS().length ? '<a href="/best/">Best games</a>' : ""}${C?.apps.length ? '<a href="/topgames/">Mobile games</a>' : ""}${C?.posts.length ? '<a href="/blog/">Blog</a>' : ""}<a href="/about/">About</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a>${C?.pages.contact ? '<a href="/contact/">Contact</a>' : site.contactEmail ? `<a href="mailto:${esc(site.contactEmail)}">Contact</a>` : ""}<span>© ${new Date().getFullYear()} ${esc(site.name)}</span></footer>
<div class="search" role="dialog" aria-label="Search"><div class="box"><input type="search" placeholder="Search ${games.length} games…" aria-label="Search games"><div class="res"></div></div></div>
</body></html>`;
}

// Home: brand box, big featured tiles sprinkled through a dense grid, category tiles, an ad tile, SEO text.
function homePage() {
  if (V && C) return vHome();
  const sizeFor = (i) => (i === 0 ? "s3" : i < featured.length || i % 9 === 4 ? "s2" : "");
  const tiles = games.map((g, i) => tile(g, sizeFor(i), i > 5, i < featured.length && i > 0 ? "HOT" : ""));
  tiles.splice(10, 0, adSlot("home_rect"));
  const body = `<div class="grid">${brand()}${tiles.join("")}<div id="recent"></div>${catTiles()}</div>
${C ? homeExtras() : ""}
<section class="text"><h1>${esc(site.name)}: free online games</h1><p>${esc(site.description)}</p>${C?.home.mobile ? `<div class="prose">${fixLinks(C.home.mobile)}</div>` : ""}</section>`;
  return page({
    title: `${site.name}: Play free online games`,
    desc: site.description,
    canonical: "/",
    ogImage: `/media/${games[0].slug}/cover-16x9.webp`,
    head: `<link rel="preload" as="image" href="/media/${games[0].slug}/thumb-1x1.webp" fetchpriority="high">`,
    jsonld: { "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: origin || undefined },
    body,
  });
}

function descHtml(desc) {
  const paras = desc.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const p = (x) => `<p class="desc">${esc(x)}</p>`;
  const head = [], tail = [];
  let n = 0;
  for (const x of paras) (n < 420 ? head : tail).push(x), (n += x.length);
  return head.map(p).join("") + (tail.length ? `<details><summary>Read more</summary>${tail.map(p).join("")}</details>` : "");
}

function gamePage(g) {
  if (V) return vGamePage(g);
  const desc = webify(g.description || g.tagline || "");
  const how = (g.how_to_play || "").split("\n").map((s) => s.replace(/^[•\-\d.)\s]+/, "").trim()).filter(Boolean);
  const nShots = Math.min(g.media?.screens?.length || 0, 6);
  const others = games.filter((x) => x.slug !== g.slug);
  const related = others.filter((x) => x.categories.some((c) => g.categories.includes(c)));
  const rest = others.filter((x) => !related.includes(x));
  const around = [...related, ...rest];
  const portrait = g.orientation === "portrait";
  const player = `<section class="player${portrait ? " portrait" : ""}" data-slug="${g.slug}" data-title="${esc(g.title)}">
<div class="stage"><div class="cover"><img class="bg" src="/media/${g.slug}/cover-16x9.webp" alt="" fetchpriority="high"><div class="card"><img src="/media/${g.slug}/icon-512.webp" width="132" height="132" alt="${esc(g.title)}"><h1>${esc(g.title)}</h1><button class="play">Play</button></div></div></div>
<div class="bar"><img src="/media/${g.slug}/icon-192.webp" width="36" height="36" alt=""><strong>${esc(g.title)}</strong><button data-fullscreen aria-label="Fullscreen">${ICON.full}</button><button class="exit" data-exit aria-label="Close game">${ICON.close}</button></div></section>`;
  const info = `<article class="info"><div><h2>${esc(g.title)}</h2>
<div class="chips">${g.categories.filter((c) => cats.includes(c)).map((c) => `<a class="chip" href="/category/${catSlug(c)}/">${esc(c)}</a>`).join("")}</div>
${g.tagline ? `<p><strong>${esc(webify(g.tagline))}</strong></p>` : ""}${descHtml(desc)}</div>
<div>${how.length ? `<h3>How to play</h3><ol class="how">${how.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
${nShots ? `<h3>Screenshots</h3><div class="shots">${Array.from({ length: nShots }, (_, i) => `<img src="/media/${g.slug}/screens/${String(i + 1).padStart(2, "0")}-540.webp" alt="${esc(g.title)} screenshot ${i + 1}" loading="lazy" decoding="async" height="220">`).join("")}</div>` : ""}</div></article>`;
  const body = `<div class="grid">${brand()}${player}${adSlot("game_side", "tall")}${around.slice(0, 18).map((x) => tile(x)).join("")}</div>${gamNative(1)}${info}${gamNative(2)}<div class="grid">${adSlot("game_below", "wide")}
<h2 class="h">More games</h2>${around.slice(18).map((x, i) => tile(x, i % 7 === 0 ? "s2" : "")).join("")}${catTiles()}</div>`;
  return page({
    title: `${g.title}: Play online for free on ${site.name}`,
    desc: short(`Play ${g.title} free in your browser. ${g.tagline || desc}`),
    canonical: `/game/${g.slug}/`,
    ogImage: `/media/${g.slug}/cover-16x9.webp`,
    head: `<link rel="preload" as="image" href="/media/${g.slug}/cover-16x9.webp" fetchpriority="high">`,
    jsonld: {
      "@context": "https://schema.org", "@type": "VideoGame", name: g.title, description: short(desc, 300),
      url: origin ? `${origin}/game/${g.slug}/` : undefined, image: origin ? `${origin}/media/${g.slug}/icon-512.webp` : undefined,
      genre: g.categories, gamePlatform: ["Web browser", "Mobile", "Desktop"], applicationCategory: "Game", operatingSystem: "Any",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    body,
  });
}

function categoryPage(c) {
  const list = games.filter((g) => g.categories.includes(c));
  const body = `<div class="grid">${brand()}<h1 class="h ch">${CAT_ICON[c] || ""} ${esc(c)} games</h1>
${list.map((g, i) => tile(g, i === 0 ? "s2" : "", i > 7)).join("")}${adSlot("home_rect")}<h2 class="h">Other categories</h2>${catTiles()}</div>
<section class="text"><h2>${esc(c)} games on ${esc(site.name)}</h2><p>Play ${list.length} free ${esc(c.toLowerCase())} games on ${esc(site.name)}. No downloads; they work on phone, tablet and desktop.</p></section>`;
  return page({ title: `${c} games: play free online on ${site.name}`, desc: `Play the best free ${c.toLowerCase()} games online on ${site.name}. Instant play, no downloads.`, canonical: `/category/${catSlug(c)}/`, body });
}

function textPage(slug, title, html) {
  if (C?.pages[slug]?.html) { title = C.pages[slug].title || title; html = `<div class="prose">${fixLinks(C.pages[slug].html)}</div>`; }
  return page({ title: `${title} | ${site.name}`, desc: `${title} for ${site.name}.`, canonical: `/${slug}/`, body: `<div class="grid">${brand()}</div><section class="text"><h1>${esc(title)}</h1>${html}</section>` });
}
const contact = site.contactEmail ? `<a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>` : "the contact address on this site";
const LEGAL = {
  about: ["About us", `<p>${esc(site.name)} is a free games website. Every game runs instantly in your browser on phone, tablet and desktop, with no downloads or sign-up.</p><p>Questions or feedback? Reach us at ${contact}.</p>`],
  privacy: ["Privacy policy", `<p>This site and the games on it use cookies and similar technologies, including Google Ad Manager, to show and measure advertising and to understand how the site is used. Google and its partners may use cookies to serve ads based on your visits to this and other websites. You can opt out of personalised advertising at <a href="https://adssettings.google.com">Google Ad Settings</a>.</p><p>We store your recently played games in your browser's local storage so we can show them on the home page. This data never leaves your device.</p><p>We do not ask for, or knowingly collect, personal information from children. For privacy questions contact ${contact}.</p>`],
  terms: ["Terms of use", `<p>The games on ${esc(site.name)} are provided free of charge for personal entertainment, as is and without warranty. Game names, artwork and trademarks belong to their respective owners. By using the site you agree not to copy, frame or redistribute its content without permission.</p>`],
};

// ---------- content pages: /topgames/, /blog/ ----------
const appBy = Object.fromEntries((C?.apps || []).map((a) => [a.slug, a]));
const appByPath = Object.fromEntries((C?.apps || []).map((a) => [(a.path || a.slug).toLowerCase(), a]));
// Mobile game pages keep the source site's URLs (/topgames/<Name>) so existing campaign links work unchanged.
const appUrl = (a) => `/topgames/${a.path || a.slug}`;
const postBy = Object.fromEntries((C?.posts || []).map((p) => [p.slug, p]));
const slugify = (x) => { try { x = decodeURIComponent(x); } catch {} return x.toLowerCase().replace(/™|®/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); };
const LEGAL_PATH = { "about-us": "/about/", "privacy-policy": "/privacy/", "terms-of-use": "/terms/", "contact-us": "/contact/" };
// Point links in imported HTML at this site's own pages.
function fixLinks(html = "") {
  // emails hidden by Cloudflare's obfuscation on the source site
  if (site.contactEmail) html = html.replace(/<a href="\/cdn-cgi\/l\/email-protection[^"]*">[^<]*<\/a>/g, `<a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>`);
  return html.replace(/href="([^"]*)"/g, (m, h) => {
    const u = h.replace(/^https?:\/\/[^/]+/, "");
    let x;
    if ((x = u.match(/^\/topgames\/([^/?#]+)/))) { let n = x[1]; try { n = decodeURIComponent(n); } catch {} const a = appByPath[n.replace(/ /g, "-").toLowerCase()] || appBy[slugify(n)]; return `href="${a ? appUrl(a) : "/topgames/"}"`; }
    if (/^\/topgames\/?$/.test(u)) return 'href="/topgames/"';
    if ((x = u.match(/^\/blogs\/([^/?#]+)/))) return `href="${postBy[slugify(x[1])] ? `/blog/${slugify(x[1])}/` : "/blog/"}"`;
    if (/^\/blogs\/?$/.test(u)) return 'href="/blog/"';
    if ((x = u.match(/^\/download\/([^/?#]+)/))) { const a = appBy[slugify(x[1])]; return a?.googlePlay ? `href="${esc(a.googlePlay)}" rel="nofollow noopener" target="_blank"` : `href="/topgames/"`; }
    if ((x = u.match(/^\/page\/([^/?#]+)/))) return `href="${LEGAL_PATH[x[1].toLowerCase()] || "/"}"`;
    if (/^\/(playgames\.html|index\.html|game-template\.html.*)?$/.test(u) && h !== u) return 'href="/"';
    return m;
  });
}
const appImg = (a) => appImgOf(a, 192);
function appTile(a, size = "", lazy = true) {
  const px = size === "s2" ? 204 : 94;
  return `<a class="tile ${size}" href="${appUrl(a)}"><img src="${esc(appImg(a))}" width="${px}" height="${px}" alt="${esc(a.title)}"${lazy ? ' loading="lazy" decoding="async"' : ""}><span class="t">${esc(a.title)}</span></a>`;
}
function postCard(p) {
  return `<a class="card" href="/blog/${p.slug}/"><img src="${esc(p._image || p.image)}" alt="${esc(p.title)}" loading="lazy" decoding="async" width="400" height="225"><span>${p.label ? `<em>${esc(p.label)}</em>` : ""}<strong>${esc(p.title)}</strong>${p.blurb ? `<small>${esc(p.blurb)}</small>` : ""}</span></a>`;
}
function homeExtras() {
  const pop = (C.home.popular || []).map((s) => appBy[s]).filter(Boolean);
  const rv = C.apps.filter((a) => reviewOf(a)).sort((x, y) => reviewOf(y).score - reviewOf(x).score);
  const list = [...new Set([...rv, ...pop, ...C.apps])];
  const ls = LISTS().filter((l) => !l.kids).slice(0, 6);
  return `${ls.length ? `<h2 class="h2"><a href="/best/">Best mobile games to download →</a></h2><div class="cards">${ls.map(listCard).join("")}</div>` : ""}${C.apps.length ? `<div class="grid"><h2 class="h"><a href="/topgames/">Popular mobile games →</a></h2>${list.slice(0, 24).map((a, i) => appTile(a, i < 2 ? "s2" : "")).join("")}</div>` : ""}
${C.posts.length ? `<h2 class="h2"><a href="/blog/">Articles →</a></h2><div class="cards">${C.posts.slice(0, 6).map(postCard).join("")}</div>` : ""}`;
}
function appsIndex() {
  if (V) return vAppsIndex();
  const body = `<div class="grid">${brand()}<h1 class="h ch">🔥 Top mobile games</h1>${[...C.apps.filter((a) => reviewOf(a)), ...C.apps.filter((a) => !reviewOf(a))].map((a, i) => appTile(a, i < 3 ? "s2" : "", i > 7)).join("")}<h2 class="h">Play online now</h2>${games.slice(0, 12).map((g) => tile(g)).join("")}</div>
${C.home.intro ? `<section class="text prose">${fixLinks(C.home.intro)}</section>` : ""}`;
  return page({ title: `Top mobile games: guides, tips and official download links | ${site.name}`, desc: `Gameplay guides, tips and official store links for ${C.apps.slice(0, 4).map((a) => a.title).join(", ")} and more popular mobile games.`, canonical: "/topgames/", body });
}
// ---------- Google Play data + editorial ----------
const pkgOf = (a) => (a.googlePlay?.match(/[?&]id=([^&#]+)/) || [])[1] || "";
const playOf = (a) => C?.play?.[pkgOf(a)] || null;
const reviewOf = (a) => C?.ed?.reviews?.[a.path] || null;
const playImg = (u, size) => (u ? u.replace(/=[swh]\d+.*$/, "") + `=${size}` : "");
const appImgOf = (a, px = 192) => { const p = playOf(a); return p?.icon ? playImg(p.icon, `s${px}`) : a._icon || a.icon; };
const fmtDate = (d) => { if (!d) return ""; const x = new Date(d + (d.length === 10 ? "T00:00:00Z" : "")); return isNaN(x) ? d : x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const fmtCount = (n) => !n ? "" : n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);
const installsShort = (p) => p?.minInstalls ? fmtCount(p.minInstalls) + "+" : p?.installs || "";
const stars = (x) => `<span class="stars" style="--v:${(x / 5) * 100}%" aria-label="${x} out of 5"></span>`;
const authorName = (k) => C?.ed?.authors?.find((x) => x.slug === k)?.name || `${site.name} Editors`;
const listsFor = (a) => (C?.ed?.lists || []).filter((l) => l.picks.some((p) => p.path === a.path));
const storeBtn = (a) => a.googlePlay ? `<a class="store" data-app="${esc(a.title)}" href="${esc(a.googlePlay)}" rel="nofollow noopener" target="_blank">Get it on Google Play</a>` : "";
function playFacts(a) {
  const p = playOf(a);
  if (!p) return a.developer ? `<dl class="facts"><div><dt>Developer</dt><dd>${esc(a.developer)}</dd></div></dl>` : "";
  const f = [
    ["Google Play rating", p.score ? `${p.score} ★${p.ratings ? ` <small>(${fmtCount(p.ratings)} ratings)</small>` : ""}` : "Not rated yet"],
    ["Installs", esc(p.installs || "–")],
    ["Price", p.free ? "Free" : esc(p.price || "Paid")],
    ["Ads", p.adSupported ? "Contains ads" : "No ads"],
    ["In-app purchases", p.offersIAP ? `Yes${p.iapRange ? ` <small>(${esc(p.iapRange)})</small>` : ""}` : "No"],
    ["Age rating", esc(p.contentRating || "–")],
    ["Version", esc(p.version || "Varies with device")],
    ["Updated", esc(fmtDate(p.updated))],
    ["Developer", esc(p.developer || a.developer || "")],
  ].filter(([, v]) => v);
  return `<dl class="facts">${f.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl><p class="src">Data from <a href="${esc(a.googlePlay)}" rel="nofollow noopener" target="_blank">Google Play</a>, checked ${esc(fmtDate(p.checked))}. Game names, icons and screenshots belong to their publishers.</p>`;
}
function reviewBox(a, r) {
  return `<section class="review">
<div class="score"><b>${r.score.toFixed(1)}</b><span>/5</span>${stars(r.score)}${r.editorsChoice ? `<em class="ec">Editor's Choice</em>` : ""}</div>
<div><h2>Our verdict</h2><p class="verdict">${esc(r.verdict)}</p>${r.bestFor ? `<p><strong>Best for:</strong> ${esc(r.bestFor)}</p>` : ""}</div>
<div class="pc"><div><h3>What we like</h3><ul class="pros">${r.pros.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div><div><h3>Watch out for</h3><ul class="cons">${r.cons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
</section>`;
}
function appPage(a) {
  const r = reviewOf(a);
  const p = playOf(a);
  const shots = p?.screenshots?.length ? p.screenshots.slice(0, 6).map((u) => playImg(u, "h440")) : (a._shots || a.screenshots || []).slice(0, 6);
  const rest = C.apps.filter((x) => x.slug !== a.slug);
  const reviewed = rest.filter((x) => reviewOf(x));
  const others = [...reviewed.filter((x) => x.genre === a.genre), ...reviewed.filter((x) => x.genre !== a.genre), ...rest.filter((x) => !reviewOf(x) && x.genre === a.genre)];
  const inLists = listsFor(a);
  const meta = r ? `<p class="meta">Review by ${esc(authorName(r.author))} · Updated ${esc(fmtDate(r.updated))} · <a href="/how-we-review/">How we review</a></p>` : "";
  const main = r
    ? `${reviewBox(a, r)}<div class="prose">${r.body.map((x) => `<p>${esc(x)}</p>`).join("")}</div>`
    : `<div class="prose">${fixLinks(a.html)}</div>`;
  const body = `<div class="grid">${brand()}</div>
<article class="info app"><div>
<div class="apphead"><img src="${esc(appImgOf(a, 224))}" width="112" height="112" alt="${esc(a.title)}" fetchpriority="high"><div><h1>${esc(a.title)}${r ? " review" : ""}</h1>${a.genre ? `<p class="genre">${esc((p?.genre || a.genre).replace(/^Game /, ""))}</p>` : ""}<div class="stores">${storeBtn(a)}</div></div></div>
${gamNative(1)}${meta}${main}${gamNative(2)}
<h3>Google Play facts</h3>${playFacts(a)}${V ? vDisclaimer(true) : ""}</div>
<div>${shots.length ? `<h3>Screenshots</h3><div class="shots">${shots.map((u, i) => `<img src="${esc(u)}" alt="${esc(a.title)} screenshot ${i + 1}" loading="lazy" decoding="async" height="220">`).join("")}</div>` : ""}
${inLists.length ? `<h3>Featured in</h3><div class="mini">${inLists.map((l) => `<a href="/best/${l.slug}/">🏆 ${esc(l.title)}</a>`).join("")}</div>` : ""}
<h3>${reviewed.length ? "More reviewed games" : "Similar games"}</h3><div class="mini">${(others.length ? others : rest).slice(0, 8).map((x) => `<a href="${appUrl(x)}"><img src="${esc(appImgOf(x, 96))}" width="48" height="48" alt="" loading="lazy">${esc(x.title)}${reviewOf(x) ? ` <small>${reviewOf(x).score.toFixed(1)}/5</small>` : ""}</a>`).join("")}</div></div></article>
<div class="grid"><h2 class="h">H5 online games: play instantly</h2>${games.slice(0, 18).map((g) => tile(g)).join("")}</div>`;
  return page({
    title: r ? `${a.title} review: is it worth downloading? | ${site.name}` : `${a.title}: gameplay, tips and download | ${site.name}`,
    desc: short(r ? `${a.title} review: ${r.verdict}` : a.metaDesc || `${a.title} guide and official download link.`),
    canonical: appUrl(a),
    ogImage: "",
    robots: r ? "" : "noindex,follow", // unreviewed pages stay for campaigns but are kept out of search until reviewed
    jsonld: r ? { "@context": "https://schema.org", "@type": "Review", name: `${a.title} review`, datePublished: r.updated, author: { "@type": "Organization", name: authorName(r.author) }, publisher: { "@type": "Organization", name: site.name },
      reviewRating: { "@type": "Rating", ratingValue: r.score, bestRating: 5, worstRating: 1 },
      itemReviewed: { "@type": "MobileApplication", name: a.title, operatingSystem: "Android", applicationCategory: "GameApplication", author: p?.developer ? { "@type": "Organization", name: p.developer } : undefined } }
      : { "@context": "https://schema.org", "@type": "MobileApplication", name: a.title, applicationCategory: "GameApplication", operatingSystem: "Android" },
    body,
  });
}
// ---------- best-of lists ----------
const LISTS = () => C?.ed?.lists || [];
function listCard(l) {
  const first = appByPath[(l.picks[0]?.path || "").toLowerCase()];
  return `<a class="card list" href="/best/${l.slug}/"><span class="icons">${l.picks.slice(0, 4).map((p) => appByPath[p.path.toLowerCase()]).filter(Boolean).map((x) => `<img src="${esc(appImgOf(x, 128))}" alt="" width="64" height="64" loading="lazy">`).join("")}</span><span>${l.kids ? "<em>For kids</em>" : `<em>${l.picks.length} picks</em>`}<strong>${esc(l.title)}</strong><small>Updated ${esc(fmtDate(l.updated))}</small></span></a>`;
}
function bestIndex() {
  if (V) return vBestIndex();
  const main = LISTS().filter((l) => !l.kids), kids = LISTS().filter((l) => l.kids);
  const body = `<div class="grid">${brand()}<h1 class="h ch">🏆 Best mobile games</h1></div>
<section class="text"><p>Our editors' picks of the Android games worth your time and storage space, sorted by what you want to play. Each list explains how we chose, and every pick links to the official Google Play page. <a href="/how-we-review/">How we review</a>.</p></section>
<div class="cards">${main.map(listCard).join("")}</div>
${kids.length ? `<h2 class="h2">For kids</h2><div class="cards">${kids.map(listCard).join("")}</div>` : ""}
<h2 class="h2">Editor's Choice</h2><div class="grid">${C.apps.filter((a) => reviewOf(a)?.editorsChoice).map((a) => appTile(a)).join("")}</div>`;
  return page({ title: `Best mobile games to download in ${new Date().getFullYear()} | ${site.name}`, desc: `Editor-picked lists of the best Android games: ${main.slice(0, 4).map((l) => l.title.replace(/^Best /, "").toLowerCase()).join(", ")} and more.`, canonical: "/best/", body });
}
// A list can require facts that must stay true ("filter": "noAds" | "noIAP" | "noAdsNoIAP"); picks that no longer
// match the live Google Play data are dropped at build time, so the page never claims something stale.
const LIST_FILTER = { noAds: (p) => p && !p.adSupported, noIAP: (p) => p && !p.offersIAP, noAdsNoIAP: (p) => p && !p.adSupported && !p.offersIAP };
const picksOf = (l) => l.picks.map((p) => ({ ...p, a: appByPath[p.path.toLowerCase()] })).filter((p) => {
  if (!p.a) { console.warn(`  ! list ${l.slug}: unknown game ${p.path}`); return false; }
  const f = LIST_FILTER[l.filter];
  if (f && !f(playOf(p.a))) { console.warn(`  ! list ${l.slug}: dropped ${p.path} (no longer matches ${l.filter})`); return false; }
  return true;
});
function listPage(l) {
  if (V) return vListPage(l);
  const picks = picksOf(l);
  const row = (p, i) => { const pl = playOf(p.a), r = reviewOf(p.a); return `<tr><td>${i + 1}</td><td><a href="#pick-${i + 1}"><img src="${esc(appImgOf(p.a, 64))}" width="32" height="32" alt="" loading="lazy">${esc(p.a.title)}</a></td><td>${esc(p.award || "")}</td><td>${r ? `${r.score.toFixed(1)}/5` : "–"}</td><td>${pl?.score ? `${pl.score} ★` : "–"}</td><td>${esc(installsShort(pl) || "–")}</td><td>${pl ? [pl.free ? "Free" : pl.price || "Paid", pl.adSupported ? "ads" : "", pl.offersIAP ? "IAP" : ""].filter(Boolean).join(" · ") : "–"}</td></tr>`; };
  const section = (p, i) => { const r = reviewOf(p.a), pl = playOf(p.a); return `<section class="pick" id="pick-${i + 1}"><div class="apphead"><img src="${esc(appImgOf(p.a, 192))}" width="88" height="88" alt="${esc(p.a.title)}" loading="lazy"><div><p class="rank">${i + 1}.${p.award ? ` <em>${esc(p.award)}</em>` : ""}</p><h2>${esc(p.a.title)}</h2><p class="genre">${r ? `Our score ${r.score.toFixed(1)}/5` : ""}${r && pl?.score ? " · " : ""}${pl?.score ? `Google Play ${pl.score} ★` : ""}${pl?.installs ? ` · ${esc(pl.installs)} installs` : ""}</p></div></div>
<p>${esc(p.why)}</p><div class="stores">${storeBtn(p.a)}${r ? `<a class="store ghost" href="${appUrl(p.a)}">Read our review</a>` : ""}</div></section>`; };
  const body = `<div class="grid">${brand()}</div>
<article class="text listpage"><p class="meta"><a href="/best/">Best games</a> · By ${esc(authorName(l.author))} · Updated ${esc(fmtDate(l.updated))}</p><h1>${esc(l.title)}</h1>${l.intro.map((x) => `<p>${esc(x)}</p>`).join("")}
<div class="tablewrap"><table class="cmp"><thead><tr><th>#</th><th>Game</th><th>Award</th><th>Our score</th><th>Play rating</th><th>Installs</th><th>Price</th></tr></thead><tbody>${picks.map(row).join("")}</tbody></table></div>
<p class="src">Google Play ratings and installs update daily. IAP = in-app purchases.</p>
${picks.map(section).join("")}
${l.howWeChose ? `<h2>How we chose</h2><p>${esc(l.howWeChose)}</p>` : ""}</article>
<h2 class="h2">More lists</h2><div class="cards">${LISTS().filter((x) => x.slug !== l.slug && !!x.kids === !!l.kids).slice(0, 3).map(listCard).join("")}</div>`;
  return page({
    title: `${l.title} (${fmtDate(l.updated).split(" ").slice(1).join(" ")}) | ${site.name}`, desc: short(l.intro[0]), canonical: `/best/${l.slug}/`,
    jsonld: { "@context": "https://schema.org", "@type": "ItemList", name: l.title, itemListElement: picks.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.a.title, url: origin ? origin + appUrl(p.a) : undefined })) },
    body,
  });
}
function howWeReview() {
  const html = (C.ed.method || []).map((x) => x.startsWith("## ") ? `<h2>${esc(x.slice(3))}</h2>` : `<p>${esc(x)}</p>`).join("");
  return page({ title: `How we review games | ${site.name}`, desc: `How ${site.name} chooses, scores and updates its mobile game reviews and best-of lists.`, canonical: "/how-we-review/", body: `<div class="grid">${brand()}</div><section class="text prose"><h1>How we review games</h1>${html}</section>` });
}
function blogIndex() {
  const body = `<div class="grid">${brand()}<h1 class="h ch">📝 Gaming blog</h1></div><div class="cards">${C.posts.map(postCard).join("")}</div>`;
  return page({ title: `Gaming blog: guides and tips | ${site.name}`, desc: `Gaming guides and tips from ${site.name}: ${C.posts.slice(0, 3).map((p) => p.title).join(", ")} and more.`, canonical: "/blog/", body });
}
function postPage(p) {
  const more = C.posts.filter((x) => x.slug !== p.slug);
  const body = `<div class="grid">${brand()}</div>
<article class="text post"><img class="banner" src="${esc(p._image || p.image)}" alt="" fetchpriority="high" width="1200" height="500"><h1>${esc(p.title)}</h1><p class="meta">By ${esc(site.name)}${p.date ? ` · ${esc(p.date)}` : ""}</p><div class="prose">${fixLinks(p.html)}</div></article>
<h2 class="h2">More articles</h2><div class="cards">${more.slice(0, 3).map(postCard).join("")}</div>
<div class="grid"><h2 class="h">Play online now</h2>${games.slice(0, 12).map((g) => tile(g)).join("")}</div>`;
  return page({
    title: `${p.title} | ${site.name}`, desc: short(p.metaDesc && !/play free online games/i.test(p.metaDesc) ? p.metaDesc : p.blurb || p.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    canonical: `/blog/${p.slug}/`, ogImage: p._image || "",
    jsonld: { "@context": "https://schema.org", "@type": "Article", headline: p.title, image: origin && p._image ? origin + p._image : undefined, author: { "@type": "Organization", name: site.name }, publisher: { "@type": "Organization", name: site.name } },
    body,
  });
}
// Copy content images to the site's own domain (falls back to the original URL if a download fails).
async function localImg(url, rel) {
  if (!url) return "";
  const ext = (url.match(/\.(webp|png|jpe?g|gif)(?:\?|$)/i)?.[1] || "webp").toLowerCase();
  const file = `${rel}.${ext}`;
  const ok = await fetchTo(url, path.join(CACHE, "_content", file)).catch(() => false);
  if (!ok) return url;
  await mkdir(path.dirname(path.join(OUT, "media", file)), { recursive: true });
  await cp(path.join(CACHE, "_content", file), path.join(OUT, "media", file));
  return `/media/${file}`;
}

// ---------- vibrant design (site.design = "vibrant") ----------
const VPAL = ["#B6F23A", "#FFB3D1", "#2EE6D6", "#FFD23F", "#C9B8FF", "#9BE7FF", "#FF9F68", "#FFE45C"];
const VSVG = {
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M9 17h6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
};
const nApps = () => C?.apps.length || 0;
function vHeader(slim = false) {
  const pills = [
    ...cats.map((c, i) => `<a class="vpill" style="--c:${VPAL[i % VPAL.length]}" href="/category/${catSlug(c)}/">${esc(c)}</a>`),
    nApps() ? `<a class="vpill" style="--c:#FFFFFF" href="/topgames/">Mobile games</a>` : "",
  ].join("");
  return `<header class="vh"><div class="vin vtop">
<a class="vlogo" href="/" aria-label="${esc(site.name)} home"><span class="vmark">${esc(site.logo.mark)}</span><span>${esc(site.logo.text)}</span></a>
<button class="vsearch" data-search>${VSVG.search}<span>Search ${games.length + nApps()} games and lists…</span></button>
${LISTS().length ? `<a class="vbtn vhot" href="/best/">${VSVG.trophy}<span>Best lists</span></a>` : ""}
</div>${slim ? "" : `<nav class="vin vcats" aria-label="Categories">${pills}</nav>`}</header>`;
}
function vFooter() {
  const links = [LISTS().length && ["/best/", "Best lists"], nApps() && ["/topgames/", "Mobile games"], C?.ed?.method && ["/how-we-review/", "How we review"], C?.posts.length && ["/blog/", "Blog"], ["/about/", "About"], ["/privacy/", "Privacy"], ["/terms/", "Terms"], C?.pages.contact && ["/contact/", "Contact"]].filter(Boolean);
  return `<footer class="vf"><div class="vin"><span class="vlogo vsm"><span class="vmark">${esc(site.logo.mark)}</span>${esc(site.logo.text)}</span>${links.map(([h, n]) => `<a href="${h}">${n}</a>`).join("")}<span class="vcopy">Reviews and rankings are our opinion. Mobile games listed here are made and owned by their developers and download from Google Play; ${esc(site.name)} isn't affiliated with Google or the publishers. © ${new Date().getFullYear()} ${esc(site.name)}</span></div></footer>`;
}
// One H5 game tile in a mosaic; sz: "" | "w" (2x1, cover art) | "b" (2x2)
function vTile(g, sz = "", badge = "", lazy = true) {
  const src = sz === "w" ? `/media/${g.slug}/cover-16x9.webp` : `/media/${g.slug}/thumb-1x1.webp`;
  return `<a class="vt ${sz}" href="/game/${g.slug}/"><img src="${src}" alt="${esc(g.title)}"${lazy ? ' loading="lazy" decoding="async"' : ' fetchpriority="high"'}>${badge ? `<i class="vbadge${badge === "NEW" ? " new" : ""}">${badge}</i>` : ""}<b>${esc(g.title)}</b></a>`;
}
const VPATTERN = ["b", "w", "", "", "", "", "w", "b", "", "", "w", "", "", "", "", "w", "", "", "b", "", "", "w", "", "", ""];
const vMosaic = (list, start = 0) => `<div class="vmosaic">${list.map((g, i) => vTile(g, VPATTERN[(i + start) % VPATTERN.length], i === 0 ? "HOT" : i === 3 ? "NEW" : "", i > 4)).join("")}</div>`;
// App icon from Google Play (official CDN), with a coloured tile behind it
const vIcon = (a, px) => `<img class="vicon" src="${esc(appImgOf(a, px * 2))}" width="${px}" height="${px}" alt="${esc(a.title)}" loading="lazy" decoding="async">`;
const shortList = (l) => l.title.replace(/^Best /, "").replace(/ for Android$/, "").replace(/^Android /, "").replace(/^\w/, (c) => c.toUpperCase());
function vListCard(l, i, sz = "") {
  const picks = picksOf(l).slice(0, 3);
  return `<a class="vlist ${sz}" style="--c:${VPAL[i % VPAL.length]}" href="/best/${l.slug}/"><span class="vlist-icons">${picks.map((p) => `<span>${vIcon(p.a, sz === "b" ? 88 : 56)}<em>${esc(p.a.title.split(/[:\-–]/)[0].trim())}</em></span>`).join("")}</span><span class="vlist-t"><strong>${esc(l.title)}</strong><small>${picksOf(l).length} picks · updated ${esc(fmtDate(l.updated))}</small></span></a>`;
}
// Shown wherever we review or recommend Play Store games.
function vDisclaimer(compact = false) {
  return `<aside class="vdisc${compact ? " sm" : ""}" aria-label="Disclaimer"><strong>Please note</strong><p>Our reviews, scores and rankings are the opinion of the ${esc(site.name)} editors. The mobile games we list are not our games: they are made and owned by their own developers and are downloaded from Google Play, not from ${esc(site.name)}. We are not affiliated with Google or the game publishers. Ratings, installs and prices come from Google Play and can change. <a href="/how-we-review/">How we review</a></p></aside>`;
}
function vAbout() {
  const faq = [
    ["Do I need to install anything?", `Not for our ${games.length} browser games: open one and it starts right away. The mobile games in our lists are installed from Google Play.`],
    ["Are the browser games free?", "Yes. Every game you can play on this site is free and needs no account."],
    ["Are the mobile games yours?", `No. They are made by their own developers. We review and recommend them, and every download button goes to the game's official Google Play page.`],
    ["How do you pick games for your lists?", "Our editors look at how fun and deep a game is, how fair its ads and purchases are, and how well it runs on typical phones. Facts come from Google Play and refresh daily."],
    ["Does it work on my phone?", "Yes. The site and the browser games work on phones, tablets and desktops."],
  ];
  const feats = [
    ["#B6F23A", "Play instantly", `${games.length} free puzzle, word and arcade games that run in your browser. No download, no sign-up.`],
    ["#FFB3D1", "Honest picks", `${LISTS().length} lists and ${Object.keys(C.ed.reviews || {}).length} reviews telling you which Play Store games are worth your time, money and storage.`],
    ["#2EE6D6", "Always up to date", "Ratings, installs, prices and ads info are checked against Google Play every day."],
  ];
  return `<section class="vin vsec vabout"><div class="vfeats">${feats.map(([c, h, t]) => `<div class="vfeat-c" style="--c:${c}"><strong>${h}</strong><p>${esc(t)}</p></div>`).join("")}</div>
<div class="vfaq"><h2>Questions</h2>${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
${vDisclaimer()}
<h1 class="vseo">${esc(site.name)}: free online games and the best mobile games to download</h1></section>`;
}
function vHome() {
  const ed = C.ed.home || {};
  const featA = appByPath[(ed.featured || "").toLowerCase()];
  const featR = featA && reviewOf(featA), featP = featA && playOf(featA);
  const spot = (ed.spotlight || []).map((x) => { const l = LISTS().find((y) => y.slug === x.list); const a = appByPath[x.path.toLowerCase()]; const pick = l?.picks.find((p) => p.path === x.path); return a && l ? { a, l, why: x.why || pick?.why || "" } : null; }).filter(Boolean);
  const hero = featA ? `<section class="vin vhero">
<a class="vfeat" href="${appUrl(featA)}">${featP?.header ? `<img class="vfeat-img" src="${esc(playImg(featP.header, "w1200"))}" alt="" fetchpriority="high">` : `<span class="vfeat-img"></span>`}<i class="vtag">Editor's pick</i>
<span class="vfeat-b">${vIcon(featA, 84)}<span class="vfeat-t"><strong>${esc(featA.title)}</strong><span>${esc(featR?.verdict || "")}</span><span class="vchips">${featR ? `<i>Our score ${featR.score.toFixed(1)}/5</i>` : ""}${featP ? `<i class="g">${featP.adSupported ? "Has ads" : "No ads"}</i><i class="b">${esc(installsShort(featP))} installs</i>` : ""}</span></span><span class="vbtn vpop">Why we love it →</span></span></a>
<div class="vspots">${spot.map((x, i) => `<a class="vspot" style="--c:${VPAL[(i + 1) % VPAL.length]}" href="/best/${x.l.slug}/">${vIcon(x.a, 72)}<span><i>${esc(shortList(x.l))}</i><strong>${esc(x.a.title.split(":")[0])}</strong><small>${esc(x.why)}</small></span></a>`).join("")}</div></section>` : "";
  const homeLists = (ed.lists || []).map((sl) => LISTS().find((l) => l.slug === sl)).filter(Boolean);
  const rows = cats.slice(0, 3).map((c) => { const list = games.filter((g) => g.categories.includes(c)).slice(0, 9); return `<section class="vin vsec"><div class="vsec-h"><h2>${esc(c)} games</h2><a href="/category/${catSlug(c)}/">See all →</a></div>${vMosaic(list, 7)}</section>`; }).join("");
  const body = `<div class="vband">${hero}</div>
<section class="vin vsec"><div class="vsec-h"><h2>Play instantly</h2><span class="vsticker">${games.length} free games · no download</span></div>${vMosaic(games)}</section>
${NATIVE ? `<div class="vin vad">${gamNative(1)}</div>` : ""}
${homeLists.length ? `<section class="vpink"><div class="vin vsec"><div class="vsec-h"><div><h2>What should I download?</h2><p>Hand-picked Android games, checked against Google Play every day.</p></div><a class="vbtn vwhite" href="/best/">All ${LISTS().length} lists →</a></div><div class="vlists">${homeLists.map((l, i) => vListCard(l, i)).join("")}</div></div></section>` : ""}
${NATIVE ? `<div class="vin vad">${gamNative(2)}</div>` : ""}${rows}
${vAbout()}`;
  return page({ title: `${site.name}: free online games and the best mobile games`, desc: site.description, canonical: "/", ogImage: `/media/${games[0].slug}/cover-16x9.webp`,
    jsonld: { "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: origin || undefined }, body });
}
function vAppsIndex() {
  // Image-first mosaic: Editor's Choice = big square icon, popular games with a Play feature graphic = wide banner,
  // the rest = small square icons. Rating sits on the tile; the name shows on hover (always on big/wide tiles).
  const pop = (a) => playOf(a)?.minInstalls || 0;
  const all = [...C.apps].sort((x, y) => ((reviewOf(y)?.editorsChoice ? 2e10 : 0) + pop(y)) - ((reviewOf(x)?.editorsChoice ? 2e10 : 0) + pop(x)));
  let wides = 0;
  const sizeOf = (a, i) => {
    const r = reviewOf(a), p = playOf(a);
    if (r?.editorsChoice) return "b";
    if (p?.header && pop(a) >= 1e8 && wides < 24 && i % 3 !== 2) { wides++; return "w"; }
    return "";
  };
  // spread the big tiles out so the wall looks mixed rather than sorted
  const big = all.filter((a) => reviewOf(a)?.editorsChoice), rest = all.filter((a) => !reviewOf(a)?.editorsChoice);
  const mixed = []; let bi = 0;
  rest.forEach((a, i) => { if (i % 7 === 0 && bi < big.length) mixed.push(big[bi++]); mixed.push(a); });
  while (bi < big.length) mixed.push(big[bi++]);
  const tile = (a, i) => {
    const sz = sizeOf(a, i), p = playOf(a), r = reviewOf(a);
    const img = sz === "w" ? playImg(p.header, "w720") : appImgOf(a, sz === "b" ? 512 : 256);
    return `<a class="vg ${sz}" href="${appUrl(a)}"><img src="${esc(img)}" alt="${esc(a.title)}"${i > 14 ? ' loading="lazy" decoding="async"' : ""}>${p?.score ? `<i class="vg-r">${p.score} ★</i>` : ""}${r ? `<i class="vg-s${r.editorsChoice ? " ec" : ""}">${r.editorsChoice ? "Editor's Choice · " : ""}${r.score.toFixed(1)}/5</i>` : ""}<b>${esc(a.title.split(/[:–]/)[0].trim())}</b></a>`;
  };
  const body = `<section class="vin vwall-h"><h1>Top mobile games</h1><p>${C.apps.length} Android games · live Google Play ratings · <a href="/best/">best-of lists</a></p></section>
<section class="vin"><div class="vwall">${mixed.map(tile).join("")}</div></section>
<section class="vin">${vDisclaimer()}</section>`;
  return page({ slim: true, title: `Top mobile games: reviews, ratings and official downloads | ${site.name}`, desc: `Live Google Play ratings and our reviews of ${C.apps.length} Android games, including ${big.slice(0, 3).map((a) => a.title.split(":")[0]).join(", ")}.`, canonical: "/topgames/", body });
}
function vBestIndex() {
  const SZ = ["b", "w", "", "", "w", "", "", "b", "", "", "w", "", "", "w", "", ""];
  const ls = LISTS().filter((l) => !l.kids), kids = LISTS().filter((l) => l.kids);
  const order = [...ls.filter((l) => l.filter || /like|without|low-end|two-player|seniors|sleep|flight|mahjong|word/.test(l.slug)), ...ls.filter((l) => !(l.filter || /like|without|low-end|two-player|seniors|sleep|flight|mahjong|word/.test(l.slug)))];
  const body = `<div class="vband vband-hot"><section class="vin vpage-h"><h1>What should you <span>download next?</span></h1><p>${LISTS().length} hand-picked lists for every mood, phone and budget. Every pick links to its official Google Play page. <a href="/how-we-review/">How we choose</a></p></section></div>
<section class="vin vsec"><div class="vlists vmos">${order.map((l, i) => vListCard(l, i, SZ[i % SZ.length])).join("")}</div></section>
${kids.length ? `<section class="vin vsec"><div class="vsec-h"><h2>For kids</h2></div><div class="vlists">${kids.map((l, i) => vListCard(l, i + 3)).join("")}</div></section>` : ""}
<section class="vin">${vDisclaimer()}</section>`;
  return page({ title: `Best mobile games to download in ${new Date().getFullYear()} | ${site.name}`, desc: `${LISTS().length} editor-picked lists of the best Android games: ${ls.slice(0, 4).map((l) => shortList(l).toLowerCase()).join(", ")} and more.`, canonical: "/best/", body });
}
function vListPage(l) {
  const picks = picksOf(l);
  const m = l.title.match(/^Best (.+)$/);
  const h1 = `${picks.length} best ${esc(m ? m[1] : l.title)}`;
  const quick = picks.map((p, i) => { const pl = playOf(p.a); return `<a href="#pick-${i + 1}"><b>${i + 1}</b>${vIcon(p.a, 40)}<span>${esc(p.a.title.split(":")[0])}</span><em>${pl?.score ? pl.score + " ★" : ""}</em></a>`; }).join("");
  const card = (p, i) => { const pl = playOf(p.a), r = reviewOf(p.a); const shots = (pl?.screenshots || []).slice(0, 4);
    return `<section class="vpick" id="pick-${i + 1}"><div class="vpick-h" style="--c:${VPAL[i % VPAL.length]}">${vIcon(p.a, 104)}<div><span class="vrank"><b>${i + 1}</b>${p.award ? `<i>${esc(p.award)}</i>` : ""}</span><h2>${esc(p.a.title)}</h2><span>${esc(pl?.developer || p.a.developer || "")}</span></div></div>
<div class="vpick-b"><div class="vchips big">${pl?.score ? `<i class="y">${pl.score} ★ <small>(${fmtCount(pl.ratings)})</small></i>` : ""}${pl?.installs ? `<i class="b">${esc(pl.installs)} installs</i>` : ""}${pl ? `<i class="${pl.adSupported ? "p" : "g"}">${pl.adSupported ? "Has ads" : "No ads"}</i><i>${pl.free ? "Free" : esc(pl.price)}${pl.offersIAP ? " · in-app purchases" : ""}</i>` : ""}${r ? `<i class="d">Our score ${r.score.toFixed(1)}/5</i>` : ""}</div>
${shots.length ? `<div class="vshots">${shots.map((u, k) => `<img src="${esc(playImg(u, "h480"))}" alt="${esc(p.a.title)} screenshot ${k + 1}" loading="lazy" decoding="async">`).join("")}</div>` : ""}
<p>${esc(p.why)}</p><div class="vrow">${storeBtn(p.a).replace('class="store"', 'class="vbtn vpop vlg"')}${r ? `<a class="vbtn vwhite" href="${appUrl(p.a)}">Read our review</a>` : ""}</div></div></section>`; };
  const h5 = games.slice(0, 6).map((g) => `<a href="/game/${g.slug}/"><img src="/media/${g.slug}/thumb-1x1.webp" alt="${esc(g.title)}" loading="lazy"></a>`).join("");
  const more = LISTS().filter((x) => x.slug !== l.slug && !!x.kids === !!l.kids).slice(0, 4);
  const body = `<div class="vband"><section class="vin vlist-hero"><div><span class="vsticker pink">${picks.length} picks · updated ${esc(fmtDate(l.updated))}</span><h1>${h1}</h1>${l.intro.map((x) => `<p>${esc(x)}</p>`).join("")}<p class="vby">By ${esc(authorName(l.author))} · Our picks are our opinion; these games are made by their developers and download from Google Play · <a href="/how-we-review/">How we choose</a></p></div><nav class="vquick" aria-label="Quick picks"><strong>Quick picks</strong>${quick}</nav></section></div>
<div class="vin vlist-body"><article>${gamNative(1)}${picks.map((p, i) => card(p, i) + (i === 1 ? gamNative(2) : "")).join("")}${l.howWeChose ? `<section class="vhow"><h2>How we chose</h2><p>${esc(l.howWeChose)}</p><p class="src">Ratings, installs, prices and ads info come from Google Play and refresh daily. Names, icons and screenshots belong to their publishers.</p></section>` : ""}${vDisclaimer()}</article>
<aside><div class="vplay"><strong>Bored of waiting? Play now</strong><div>${h5}</div><span>Free in your browser, no download</span></div><div class="vmore"><strong>More lists</strong>${more.map((x) => `<a href="/best/${x.slug}/">${esc(x.title)}</a>`).join("")}</div></aside></div>`;
  return page({
    title: `${l.title} (${fmtDate(l.updated).split(" ").slice(1).join(" ")}) | ${site.name}`, desc: short(l.intro[0]), canonical: `/best/${l.slug}/`,
    jsonld: { "@context": "https://schema.org", "@type": "ItemList", name: l.title, itemListElement: picks.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.a.title, url: origin ? origin + appUrl(p.a) : undefined })) },
    body,
  });
}
// H5 game page, vibrant design. One HTML document with two layouts:
//  desktop (>=870px): framed player + 300px right rail (sidebar ad + trending), similar games under the player
//  mobile  (<870px):  launch card (cover, icon, big Play button -> full-screen game), then content in one column
// Ads: only gam-native-01 (right rail on wide screens, main column otherwise) and gam-native-02 (full-width, above
// "More free games"), the ids the Price Optimiser script fills.
function vGamePage(g) {
  const desc = webify(g.description || g.tagline || "");
  const how = (g.how_to_play || "").split("\n").map((s) => s.replace(/^[•\-\d.)\s]+/, "").trim()).filter(Boolean);
  const nShots = Math.min(g.media?.screens?.length || 0, 6);
  const others = games.filter((x) => x.slug !== g.slug);
  const related = others.filter((x) => x.categories.some((c) => g.categories.includes(c)));
  const around = [...related, ...others.filter((x) => !related.includes(x))];
  const portrait = g.orientation === "portrait";
  const gcats = g.categories.filter((c) => cats.includes(c));
  const c0 = gcats[0];
  const trending = [...featured.map((s) => bySlug[s]), ...games].filter((x, i, a) => x && x.slug !== g.slug && a.indexOf(x) === i).slice(0, 6);
  const chips = `${gcats.map((c, i) => `<a class="gp-chip" style="--c:${VPAL[(cats.indexOf(c)) % VPAL.length]}" href="/category/${catSlug(c)}/">${esc(c)}</a>`).join("")}<span class="gp-chip">${portrait ? "Portrait" : "Landscape"}</span><span class="gp-chip">Free · no download</span>`;
  const shots = nShots ? `<div class="vshots gp-shots">${Array.from({ length: nShots }, (_, i) => `<img src="/media/${g.slug}/screens/${String(i + 1).padStart(2, "0")}-540.webp" alt="${esc(g.title)} screenshot ${i + 1}" loading="lazy" decoding="async">`).join("")}</div>` : "";
  const howBox = how.length ? `<section class="gp-how"><h2>How to play</h2><ol>${how.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>` : "";
  // gam-native-01 lives in the right rail on wide screens; below 1100px (no rail) the same div is moved into the main
  // column before the ad script runs, so each id exists once. Sized for Google's 336x280 / 300x250.
  const sideAd = NATIVE ? `<div class="gp-sidead">${gamNative(1)}</div><script>matchMedia("(max-width:1099px)").matches&&document.querySelector(".gp-n1").appendChild(document.currentScript.previousElementSibling.firstChild)</script>`
    : adSlot("game_side", "gp-sidead");

  // mobile only: launch card
  const launch = `<section class="gp-launch"><div class="gp-launch-card"><img class="gp-launch-bg" src="/media/${g.slug}/cover-16x9.webp" alt="" fetchpriority="high">
<div class="gp-launch-b"><img class="vicon" src="/media/${g.slug}/icon-192.webp" width="88" height="88" alt=""><div><p class="gp-launch-t">${esc(g.title)}</p><div class="gp-chips">${chips}</div></div></div>
<button class="vbtn vpop vlg gp-launch-play" data-play>${VSVG.play}<span>Play now</span></button><small>Opens full screen · tap ✕ to come back</small></div></section>`;

  // desktop player (also the full-screen player on mobile)
  const player = `<section class="player gp-player${portrait ? " portrait" : ""}" data-slug="${g.slug}" data-title="${esc(g.title)}">
<div class="stage"><div class="cover"><img class="bg" src="/media/${g.slug}/cover-16x9.webp" alt=""><div class="gp-card"><img src="/media/${g.slug}/icon-512.webp" width="132" height="132" alt="${esc(g.title)}"><strong>${esc(g.title)}</strong><button class="play vbtn vpop vlg">${VSVG.play}<span>Play</span></button></div></div></div>
<div class="bar"><img src="/media/${g.slug}/icon-192.webp" width="40" height="40" alt=""><strong>${esc(g.title)}</strong><span class="gp-bar-chips">${gcats.map((c) => `<a href="/category/${catSlug(c)}/">${esc(c)}</a>`).join("")}</span><button data-fullscreen aria-label="Fullscreen">${ICON.full}</button><button class="exit" data-exit aria-label="Close game">${ICON.close}</button></div></section>`;

  const similar = `<section class="gp-similar"><div class="vsec-h"><h2>${c0 ? `More ${esc(c0.toLowerCase())} games` : "You may also like"}</h2>${c0 ? `<a href="/category/${catSlug(c0)}/">See all →</a>` : ""}</div><div class="gp-strip">${around.slice(0, 12).map((x) => vTile(x)).join("")}</div></section>`;

  const about = `<article class="gp-about"><h1>${esc(g.title)}</h1><div class="gp-chips">${chips}</div>
${g.tagline ? `<p class="gp-tag">${esc(webify(g.tagline))}</p>` : ""}${descHtml(desc)}</article>`;

  const rail = `<aside class="gp-rail">${sideAd}<div class="gp-trend"><strong>Trending now</strong>${trending.map((x, i) => `<a href="/game/${x.slug}/"><b>${i + 1}</b><img src="/media/${x.slug}/icon-192.webp" width="48" height="48" alt="" loading="lazy"><span>${esc(x.title)}</span></a>`).join("")}</div></aside>`;

  const lists = LISTS().filter((l) => !l.kids).slice(0, 3);
  const body = `<nav class="vin gp-crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${c0 ? `<span>›</span><a href="/category/${catSlug(c0)}/">${esc(c0)} games</a>` : ""}<span>›</span><span>${esc(g.title)}</span></nav>
<div class="vin gp${portrait ? " gp-portrait" : ""}">
<div class="gp-main">${launch}${player}${similar}${NATIVE ? `<div class="gp-n1"></div>` : ""}<div class="gp-info">${about}<div class="gp-side2">${howBox}${shots ? `<section class="gp-shotbox"><h2>Screenshots</h2>${shots}</section>` : ""}</div></div>${NATIVE ? "" : adSlot("game_below", "wide")}</div>
${rail}</div>
${NATIVE ? `<div class="vin gp-n2">${gamNative(2)}</div>` : ""}
<section class="vin vsec"><div class="vsec-h"><h2>More free games</h2><span class="vsticker">${games.length} games · no download</span></div>${vMosaic(around.slice(12, 33))}</section>
${lists.length ? `<section class="vin vsec"><div class="vsec-h"><h2>Rather download a game?</h2><a href="/best/">All ${LISTS().length} lists →</a></div><div class="vlists">${lists.map((l, i) => vListCard(l, i)).join("")}</div></section>` : ""}
<section class="vin vsec"><div class="vsec-h"><h2>Browse by category</h2></div><nav class="vcats2">${cats.map((c, i) => `<a class="vpill" style="--c:${VPAL[i % VPAL.length]}" href="/category/${catSlug(c)}/">${CAT_ICON[c] || "🎮"} ${esc(c)}</a>`).join("")}</nav></section>`;
  return page({
    title: `${g.title}: Play online for free on ${site.name}`,
    desc: short(`Play ${g.title} free in your browser. ${g.tagline || desc}`),
    canonical: `/game/${g.slug}/`,
    ogImage: `/media/${g.slug}/cover-16x9.webp`,
    head: `<link rel="preload" as="image" href="/media/${g.slug}/cover-16x9.webp" fetchpriority="high">`,
    jsonld: {
      "@context": "https://schema.org", "@type": "VideoGame", name: g.title, description: short(desc, 300),
      url: origin ? `${origin}/game/${g.slug}/` : undefined, image: origin ? `${origin}/media/${g.slug}/icon-512.webp` : undefined,
      genre: g.categories, gamePlatform: ["Web browser", "Mobile", "Desktop"], applicationCategory: "Game", operatingSystem: "Any",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    body,
  });
}

// ---------- write everything ----------
await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, "assets"), { recursive: true });
console.log(`Building "${site.name}" (${SITE_KEY}) with ${games.length} games, ads: ${site.ads.mode}, assets: ${site.assets}`);

const missing = [];
for (const g of [...games]) {
  if (!(await syncMedia(g))) { missing.push(g.slug); games.splice(games.indexOf(g), 1); delete bySlug[g.slug]; }
}
if (missing.length) console.warn(`  ! left out (no media in R2 at ${CDN}/<slug>/media/): ${missing.join(", ")}`);
if (!games.length) throw new Error("No games with media; nothing to build.");

const w = async (p, s) => { await mkdir(path.dirname(path.join(OUT, p)), { recursive: true }); await writeFile(path.join(OUT, p), s); };
await w(JS_FILE.slice(1), JS);
await w("index.html", homePage());
for (const g of games) await w(`game/${g.slug}/index.html`, gamePage(g));
for (const c of cats) await w(`category/${catSlug(c)}/index.html`, categoryPage(c));
if (C?.pages.contact) LEGAL.contact = ["Contact us", ""];
for (const [slug, [title, html]] of Object.entries(LEGAL)) await w(`${slug}/index.html`, textPage(slug, title, html));
if (C) {
  const pool = async (items, fn, n = 8) => { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); };
  await pool(C.apps.filter((a) => !playOf(a)?.icon), async (a) => {
    a._icon = await localImg(a.icon, `apps/${a.slug}/icon`);
    a._shots = [];
    for (const [i, u] of (a.screenshots || []).slice(0, 4).entries()) a._shots.push(await localImg(u, `apps/${a.slug}/${String(i + 1).padStart(2, "0")}`));
  });
  await pool(C.posts, async (p) => { p._image = await localImg(p.image, `blog/${p.slug}`); });
  // rebuild home now that images are local
  await w("index.html", homePage());
  if (C.apps.length) {
    await w("topgames/index.html", appsIndex());
    for (const a of C.apps) await w(`topgames/${a.path || a.slug}.html`, appPage(a)); // served at /topgames/<Name>
  }
  if (LISTS().length) { await w("best/index.html", bestIndex()); for (const l of LISTS()) await w(`best/${l.slug}/index.html`, listPage(l)); }
  if (C.ed.method) await w("how-we-review/index.html", howWeReview());
  if (C.posts.length) { await w("blog/index.html", blogIndex()); for (const p of C.posts) await w(`blog/${p.slug}/index.html`, postPage(p)); }
  console.log(`  + content: ${C.apps.length} mobile game pages, ${C.posts.length} blog posts, pages: ${Object.keys(C.pages).join(", ") || "none"}`);
}
await w("404.html", page({ title: `Page not found | ${site.name}`, desc: site.description, canonical: "/404", robots: "noindex", body: `<div class="grid">${brand()}<h1 class="h ch">Oops! That page wandered off. Try one of these:</h1>${games.slice(0, 18).map((g) => tile(g)).join("")}</div>` }));
await w("search.json", JSON.stringify(games.map((g) => ({ s: g.slug, t: g.title, c: g.categories.join(" ") }))));
await w("favicon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${t.accent}"/><text x="32" y="45" font-family="Arial,sans-serif" font-weight="900" font-size="38" text-anchor="middle" fill="${t.accentText}">${esc(site.logo.mark)}</text></svg>`);
await w("manifest.webmanifest", JSON.stringify({ name: site.name, short_name: site.name, start_url: "/", display: "standalone", background_color: t.background, theme_color: t.background, icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }] }));
await w("robots.txt", `User-agent: *\nDisallow: /play/\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ""}`);
if (origin) {
  const urls = ["/", ...games.map((g) => `/game/${g.slug}/`), ...cats.map((c) => `/category/${catSlug(c)}/`), "/about/", "/privacy/", "/terms/",
    ...(C?.pages.contact ? ["/contact/"] : []), ...(C?.apps.length ? ["/topgames/", ...C.apps.filter((a) => reviewOf(a)).map(appUrl)] : []), ...(LISTS().length ? ["/best/", ...LISTS().map((l) => `/best/${l.slug}/`)] : []), ...(C?.ed?.method ? ["/how-we-review/"] : []), ...(C?.posts.length ? ["/blog/", ...C.posts.map((p) => `/blog/${p.slug}/`)] : [])];
  await w("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${origin}${u}</loc></url>`).join("")}</urlset>`);
}
if (site.adsTxt?.length) await w("ads.txt", site.adsTxt.join("\n") + "\n");
if (C?.apps.length) await w("_redirects", `/download/:name /topgames/:name 302\n/mobile-games/* /topgames/ 301\n`);
await w("_headers", `/assets/*
  Cache-Control: public, max-age=31536000, immutable
/media/*
  Cache-Control: public, max-age=604800, stale-while-revalidate=86400
/search.json
  Cache-Control: public, max-age=3600
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`);

// Config for the /play/ Function (bundled by Pages after this build step).
await mkdir(path.join(ROOT, "functions", "_generated"), { recursive: true });
await writeFile(path.join(ROOT, "functions", "_generated", "site.js"),
  `// Generated by build.mjs for site "${SITE_KEY}". Do not edit.\nexport default ${JSON.stringify({ key: SITE_KEY, domain: site.domain, assets: site.assets, ads: { mode: site.ads.mode, networkCode: site.ads.networkCode, gameUnitPattern: site.ads.gameUnitPattern, games: Object.fromEntries(Object.entries(site.ads.games || {}).filter(([s]) => bySlug[s])) }, games: games.map((g) => g.slug) }, null, 1)};\n`);

const size = async (p) => (await stat(path.join(OUT, p))).size;
console.log(`Done: dist/ (home ${(await size("index.html")) / 1000 | 0} KB, ${games.length} game pages, ${cats.length} categories)`);
