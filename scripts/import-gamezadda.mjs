#!/usr/bin/env node
/**
 * Imports the content of a "Gamez Adda"-style site (gamezadda.store) into content/<siteKey>/:
 *   apps.json   mobile game info pages   (/topgames/<Name>  ->  /mobile-games/<slug>/)
 *   posts.json  blog articles            (/blogs/<Title>/   ->  /blog/<slug>/)
 *   pages.json  About / Privacy / Terms / Contact HTML
 *   home.json   home intro + "mobile games" section HTML, popular list
 *
 *   npm i --no-save linkedom && node scripts/import-gamezadda.mjs torunex-site https://gamezadda.store
 *
 * Text is stored as-is (HTML with only href/src/alt kept). Brand names are swapped at build time
 * (site.json -> content.replaceNames), so a re-import never loses that.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SITE_KEY = process.argv[2] || "torunex-site";
const BASE = (process.argv[3] || "https://gamezadda.store").replace(/\/$/, "");
const OUT = path.join(ROOT, "content", SITE_KEY);

const slugify = (s) => decodeURIComponent(s).toLowerCase().replace(/™|®/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const abs = (u) => (u ? new URL(u, BASE + "/").href : "");
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

async function get(p) {
  const url = p.startsWith("http") ? p : BASE + encodeURI(decodeURI(p));
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (content import)" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const html = await r.text();
      return { url: r.url, doc: parseHTML(html).document };
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
}

// Cloudflare email obfuscation -> plain mailto links.
function decodeCfEmail(hex) {
  const k = parseInt(hex.slice(0, 2), 16);
  let o = "";
  for (let i = 2; i < hex.length; i += 2) o += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
  return o;
}
function tidy(el) {
  if (!el) return "";
  el.querySelectorAll("[data-cfemail]").forEach((e) => {
    const mail = decodeCfEmail(e.getAttribute("data-cfemail"));
    const a = e.closest('a[href*="email-protection"]') || e;
    a.outerHTML = `<a href="mailto:${mail}">${mail}</a>`;
  });
  el.querySelectorAll("script,style,noscript,.gam-ad-wrapper,.gam-ad-label").forEach((e) => e.remove());
  el.querySelectorAll("*").forEach((e) => {
    for (const a of [...e.attributes]) if (!["href", "src", "alt"].includes(a.name)) e.removeAttribute(a.name);
    if (e.tagName === "IMG" && e.getAttribute("src")) e.setAttribute("src", abs(e.getAttribute("src")));
  });
  return el.innerHTML.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}

const meta = (doc) => ({
  pageTitle: text(doc.querySelector("title")),
  metaDesc: doc.querySelector('meta[name="description"]')?.getAttribute("content") || "",
});

// ---------- home ----------
const { doc: home } = await get("/");
const appHrefs = [...new Set([...home.querySelectorAll('a[href*="/topgames/"]')]
  .map((a) => a.getAttribute("href").replace(BASE, "").replace(/\/$/, ""))
  .filter((h) => !/\/topgames$/.test(h)))];
const popular = [...home.querySelectorAll(".game-tags a")].map((a) => slugify(a.getAttribute("href").split("/topgames/")[1].replace(/\/$/, "")));
const blogBlurbs = {};
home.querySelectorAll(".blog-section a").forEach((a) => {
  const h = decodeURIComponent((a.getAttribute("href") || "").replace(BASE, ""));
  const p = a.querySelector("p");
  if (h && p) blogBlurbs[h] = text(p);
});
const homeOut = {
  intro: tidy(home.querySelector(".hero-intro")),
  mobile: tidy(home.querySelector(".mobile-games")),
  popular: [...new Set(popular)],
};


// ---------- mobile game pages ----------
const apps = [];
for (const h of appHrefs) {
  const name = decodeURIComponent(h.split("/topgames/")[1]);
  let doc, url;
  try { ({ doc, url } = await get(h)); } catch (e) { console.warn("skip (broken link on source site):", h, e.message); continue; }
  let dl;
  try { dl = (await get(`/download/${name.replace(/ /g, "-")}`)).doc; } catch { dl = null; }
  const info = {};
  doc.querySelectorAll(".info-card").forEach((c) => (info[text(c.querySelector("span"))] = text(c.querySelector("strong"))));
  const links = dl ? [...dl.querySelectorAll(".download-btns a")].map((a) => ({ label: text(a), href: a.getAttribute("href") || "" })) : [];
  const store = (re) => links.find((l) => re.test(l.href))?.href || "";
  apps.push({
    slug: slugify(name),
    source: url,
    title: text(doc.querySelector(".app-title .title")) || name.replace(/-/g, " "),
    genre: text(doc.querySelector(".app-title .developer")),
    developer: info.Developer || "",
    score: info.Score || "",
    downloads: info.Downloads || "",
    age: info.Age || "",
    version: info.Version || "",
    price: info.Price || "",
    icon: abs(doc.querySelector(".app-icon img")?.getAttribute("src")),
    screenshots: [...new Set([...doc.querySelectorAll(".slide-pic")].map((i) => abs(i.getAttribute("data-original"))).filter(Boolean))],
    googlePlay: store(/play\.google\.com/),
    appStore: store(/apps\.apple\.com|itunes\.apple\.com/),
    ...meta(doc),
    html: tidy(doc.querySelector(".review .entry")),
  });
  console.log("app ", apps.at(-1).slug);
}

// ---------- blog ----------
const { doc: blogIdx } = await get("/blogs/");
const posts = [];
for (const a of blogIdx.querySelectorAll("a.blog-card")) {
  const href = a.getAttribute("href");
  let doc, url;
  try { ({ doc, url } = await get(href)); } catch (e) { console.warn("skip (broken link on source site):", href, e.message); continue; }
  const main = doc.querySelector(".blog-main");
  if (!main) { console.warn("skip (not an article):", href); continue; }
  const title = text(a.querySelector("h3"));
  const date = [...main.querySelectorAll(".blog-meta span")].map(text).find((s) => /\d{4}/.test(s)) || "";
  main.querySelector("h1")?.remove();
  main.querySelector(".blog-meta")?.remove();
  posts.push({
    slug: slugify(title),
    source: url,
    title,
    label: a.querySelector("img")?.getAttribute("alt") || "",
    image: abs(doc.querySelector(".blog-banner img")?.getAttribute("src") || a.querySelector("img")?.getAttribute("src")),
    date,
    blurb: blogBlurbs[decodeURIComponent(href)] || "",
    ...meta(doc),
    html: tidy(main),
  });
  console.log("post", posts.at(-1).slug);
}

// ---------- legal pages ----------
const pages = {};
for (const [key, p] of [["about", "About-Us"], ["privacy", "privacy-policy"], ["terms", "terms-of-use"], ["contact", "Contact-Us"]]) {
  const { doc } = await get(`/page/${p}/`);
  const el = doc.querySelector(".entry") || doc.querySelector(".wrapper");
  const h = el?.querySelector("h1,h2,h3");
  const title = text(h);
  h?.remove();
  pages[key] = { title, html: tidy(el) };
}

await mkdir(OUT, { recursive: true });
const save = (f, v) => writeFile(path.join(OUT, f), JSON.stringify(v, null, 1) + "\n");
await save("apps.json", apps);
await save("posts.json", posts);
await save("pages.json", pages);
await save("home.json", homeOut);
console.log(`Imported ${apps.length} apps, ${posts.length} posts, ${Object.keys(pages).length} pages into content/${SITE_KEY}/`);
