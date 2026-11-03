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
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// ---------- ad helpers ----------
function siteUnit(slot) {
  if (site.ads.mode === "test" || !site.domain) return "/6355419/Travel/Europe/France/Paris";
  if (site.ads.siteUnits?.[slot]) return site.ads.siteUnits[slot]; // set per site via the Launch API
  return site.ads.siteUnitPattern.replace("{network}", site.ads.networkCode).replace("{domain}", site.domain).replace("{slot}", slot);
}
function adSlot(slot, cls = "") {
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
const themeCss = `:root{--bg:${t.background};--bg2:${t.backgroundAlt};--accent:${t.accent};--accentText:${t.accentText};--text:${t.text};--tile:${t.tile}}`;
const JS = await readFile(path.join(ROOT, "src", "app.js"), "utf8");
const JS_FILE = `/assets/app.${hash(JS)}.js`;

function tile(g, size = "", lazy = true, badge = "") {
  const px = size === "s3" ? 314 : size === "s2" ? 204 : 94;
  return `<a class="tile ${size}" href="/game/${g.slug}/">${badge ? `<span class="badge">${badge}</span>` : ""}<img src="/media/${g.slug}/${px > 94 ? "thumb-1x1" : "icon-192"}.webp" srcset="/media/${g.slug}/icon-192.webp 192w, /media/${g.slug}/thumb-1x1.webp 400w, /media/${g.slug}/icon-512.webp 512w" sizes="${px}px" width="${px}" height="${px}" alt="${esc(g.title)}"${lazy ? ' loading="lazy" decoding="async"' : ' fetchpriority="high"'}><span class="t">${esc(g.title)}</span></a>`;
}
const brand = () => `<div class="brand"><a class="logo" href="/" aria-label="${esc(site.name)} home"><span class="mark">${esc(site.logo.mark)}</span>${esc(site.logo.text)}</a><nav><a href="/" aria-label="Home">${ICON.home}</a><button data-search aria-label="Search games">${ICON.search}</button></nav></div>`;
const catTiles = () => `</div><nav class="cats" aria-label="Categories">${cats.map((c) => `<a class="cat" href="/category/${catSlug(c)}/"><i>${CAT_ICON[c] || "🎮"}</i>${esc(c)} games</a>`).join("")}</nav><div class="grid">`;

function page({ title, desc, canonical, body, head = "", ogImage = "", jsonld = null, robots = "" }) {
  const url = origin + canonical;
  const siteJs = { games: Object.fromEntries(games.map((g) => [g.slug, g.title])) };
  return `<!doctype html><html lang="${site.language || "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${origin ? `<link rel="canonical" href="${url}">` : ""}${robots ? `<meta name="robots" content="${robots}">` : ""}
<meta name="theme-color" content="${t.background}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(site.name)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${ogImage ? `<meta property="og:image" content="${origin}${ogImage}"><meta name="twitter:card" content="summary_large_image">` : ""}
<link rel="preconnect" href="https://securepubads.g.doubleclick.net">${head}
<style>${themeCss}${CSS}</style>${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
<script>window.__SITE__=${JSON.stringify(siteJs)}</script><script defer src="${JS_FILE}"></script>${site.analytics?.ga4 ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${site.analytics.ga4}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${site.analytics.ga4}')</script>` : ""}
</head><body><main class="wrap">${body}</main>
<footer><a href="/">All games</a>${cats.map((c) => `<a href="/category/${catSlug(c)}/">${esc(c)}</a>`).join("")}<a href="/about/">About</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a>${site.contactEmail ? `<a href="mailto:${esc(site.contactEmail)}">Contact</a>` : ""}<span>© ${new Date().getFullYear()} ${esc(site.name)}</span></footer>
<div class="search" role="dialog" aria-label="Search"><div class="box"><input type="search" placeholder="Search ${games.length} games…" aria-label="Search games"><div class="res"></div></div></div>
</body></html>`;
}

// Home: brand box, big featured tiles sprinkled through a dense grid, category tiles, an ad tile, SEO text.
function homePage() {
  const sizeFor = (i) => (i === 0 ? "s3" : i < featured.length || i % 9 === 4 ? "s2" : "");
  const tiles = games.map((g, i) => tile(g, sizeFor(i), i > 5, i < featured.length && i > 0 ? "HOT" : ""));
  tiles.splice(10, 0, adSlot("home_rect"));
  const body = `<div class="grid">${brand()}${tiles.join("")}<div id="recent"></div>${catTiles()}</div>
<section class="text"><h1>${esc(site.name)}: free online games</h1><p>${esc(site.description)}</p></section>`;
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
  const body = `<div class="grid">${brand()}${player}${adSlot("game_side", "tall")}${around.slice(0, 18).map((x) => tile(x)).join("")}</div>${info}<div class="grid">${adSlot("game_below", "wide")}
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
  return page({ title: `${title} | ${site.name}`, desc: `${title} for ${site.name}.`, canonical: `/${slug}/`, body: `<div class="grid">${brand()}</div><section class="text"><h1>${esc(title)}</h1>${html}</section>` });
}
const contact = site.contactEmail ? `<a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>` : "the contact address on this site";
const LEGAL = {
  about: ["About us", `<p>${esc(site.name)} is a free games website. Every game runs instantly in your browser on phone, tablet and desktop, with no downloads or sign-up.</p><p>Questions or feedback? Reach us at ${contact}.</p>`],
  privacy: ["Privacy policy", `<p>This site and the games on it use cookies and similar technologies, including Google Ad Manager, to show and measure advertising and to understand how the site is used. Google and its partners may use cookies to serve ads based on your visits to this and other websites. You can opt out of personalised advertising at <a href="https://adssettings.google.com">Google Ad Settings</a>.</p><p>We store your recently played games in your browser's local storage so we can show them on the home page. This data never leaves your device.</p><p>We do not ask for, or knowingly collect, personal information from children. For privacy questions contact ${contact}.</p>`],
  terms: ["Terms of use", `<p>The games on ${esc(site.name)} are provided free of charge for personal entertainment, as is and without warranty. Game names, artwork and trademarks belong to their respective owners. By using the site you agree not to copy, frame or redistribute its content without permission.</p>`],
};

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
for (const [slug, [title, html]] of Object.entries(LEGAL)) await w(`${slug}/index.html`, textPage(slug, title, html));
await w("404.html", page({ title: `Page not found | ${site.name}`, desc: site.description, canonical: "/404", robots: "noindex", body: `<div class="grid">${brand()}<h1 class="h ch">Oops! That page wandered off. Try one of these:</h1>${games.slice(0, 18).map((g) => tile(g)).join("")}</div>` }));
await w("search.json", JSON.stringify(games.map((g) => ({ s: g.slug, t: g.title, c: g.categories.join(" ") }))));
await w("favicon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${t.accent}"/><text x="32" y="45" font-family="Arial,sans-serif" font-weight="900" font-size="38" text-anchor="middle" fill="${t.accentText}">${esc(site.logo.mark)}</text></svg>`);
await w("manifest.webmanifest", JSON.stringify({ name: site.name, short_name: site.name, start_url: "/", display: "standalone", background_color: t.background, theme_color: t.background, icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }] }));
await w("robots.txt", `User-agent: *\nDisallow: /play/\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ""}`);
if (origin) {
  const urls = ["/", ...games.map((g) => `/game/${g.slug}/`), ...cats.map((c) => `/category/${catSlug(c)}/`), "/about/", "/privacy/", "/terms/"];
  await w("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${origin}${u}</loc></url>`).join("")}</urlset>`);
}
if (site.adsTxt?.length) await w("ads.txt", site.adsTxt.join("\n") + "\n");
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
