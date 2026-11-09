#!/usr/bin/env node
/**
 * Refreshes live Google Play data for every game in content/<site>/apps.json
 * into content/<site>/play.json (rating, ratings count, installs, version, updated date,
 * official icon + screenshot URLs on Google's CDN, ads / in-app purchase flags, content rating).
 *
 *   npm i --no-save google-play-scraper@10 && node scripts/sync-play.mjs torunex-site
 *
 * Runs daily from .github/workflows/sync-play.yml. Games whose lookup fails keep their last good data.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import gplay from "google-play-scraper";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SITE = process.argv[2] || "torunex-site";
const dir = path.join(ROOT, "content", SITE);
const apps = JSON.parse(await readFile(path.join(dir, "apps.json"), "utf8"));
const outFile = path.join(dir, "play.json");
const prev = existsSync(outFile) ? JSON.parse(await readFile(outFile, "utf8")) : {};
const out = { ...prev };

const pkgOf = (url = "") => (url.match(/[?&]id=([^&#]+)/) || [])[1] || "";
const pkgs = [...new Set(apps.map((a) => pkgOf(a.googlePlay)).filter(Boolean))];
let ok = 0, failed = [];

async function one(appId) {
  for (let i = 0; i < 3; i++) {
    try {
      const d = await gplay.app({ appId, lang: "en", country: "us" });
      out[appId] = {
        title: d.title,
        developer: d.developer,
        score: d.score ? Math.round(d.score * 10) / 10 : null,
        ratings: d.ratings || null,
        installs: d.installs || "",               // e.g. "1,000,000,000+"
        minInstalls: d.minInstalls || null,
        version: d.version && d.version !== "VARY" ? d.version : "",
        updated: d.updated ? new Date(d.updated).toISOString().slice(0, 10) : "",
        released: d.released || "",
        genre: d.genre || "",
        contentRating: d.contentRating || "",
        free: d.free !== false,
        price: d.free === false ? d.priceText || "" : "",
        adSupported: !!d.adSupported,
        offersIAP: !!d.offersIAP,
        iapRange: d.IAPRange || "",
        android: d.androidVersionText && d.androidVersionText !== "VARY" ? d.androidVersionText : "",
        icon: d.icon || "",
        header: d.headerImage || "",
        screenshots: (d.screenshots || []).slice(0, 8),
        url: d.url,
        checked: new Date().toISOString().slice(0, 10),
      };
      ok++;
      return;
    } catch (e) {
      if (i === 2) failed.push(`${appId} (${e.message})`);
      else await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

// small pool so we stay polite
const q = [...pkgs];
await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await one(q.shift()); }));

await writeFile(outFile, JSON.stringify(Object.fromEntries(Object.entries(out).sort()), null, 1) + "\n");
console.log(`Google Play data: ${ok}/${pkgs.length} refreshed${failed.length ? `; failed (kept old data): ${failed.join(", ")}` : ""}`);
if (!ok) process.exit(1);
