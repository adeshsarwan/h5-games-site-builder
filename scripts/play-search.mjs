#!/usr/bin/env node
/**
 * Research helper: searches Google Play for each term and writes candidates with key facts to
 * content/_research/play-search.json (title, package, rating, installs, price, ads, IAP, genre, size hints).
 *
 *   npm i --no-save google-play-scraper@10 && node scripts/play-search.mjs "mahjong|word games|two player games"
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import gplay from "google-play-scraper";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const terms = (process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
const out = {};
for (const term of terms) {
  try {
    const list = await gplay.search({ term, num: 20, lang: "en", country: "us", fullDetail: false });
    const rows = [];
    for (const r of list) {
      try {
        const d = await gplay.app({ appId: r.appId, lang: "en", country: "us" });
        if (!/^GAME_/.test(d.genreId || "")) continue;
        rows.push({ appId: d.appId, title: d.title, dev: d.developer, score: d.score ? +d.score.toFixed(1) : null, ratings: d.ratings,
          installs: d.minInstalls, free: d.free, price: d.priceText, ads: d.adSupported, iap: d.offersIAP, genre: d.genre,
          rating: d.contentRating, updated: d.updated ? new Date(d.updated).toISOString().slice(0, 10) : "", summary: (d.summary || "").slice(0, 140) });
      } catch { /* skip */ }
    }
    out[term] = rows;
    console.log(term, rows.length);
  } catch (e) { console.log("fail", term, e.message); }
}
await mkdir(path.join(ROOT, "content", "_research"), { recursive: true });
await writeFile(path.join(ROOT, "content", "_research", "play-search.json"), JSON.stringify(out, null, 1) + "\n");
