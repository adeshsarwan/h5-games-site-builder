#!/usr/bin/env node
/**
 * Refreshes catalog/games.json from R2 (games.gamewhame.com/<slug>/catalog/game.json).
 *   node scripts/sync-catalog.mjs                 -> refresh every game already in the catalogue
 *   node scripts/sync-catalog.mjs new-game-slug   -> also add new slugs
 * Portal categories already set in the repo are kept (R2 holds the raw Play Store categories).
 */
import { readFile, writeFile } from "node:fs/promises";

const CDN = "https://games.gamewhame.com";
const file = new URL("../catalog/games.json", import.meta.url);
const catalog = JSON.parse(await readFile(file, "utf8"));
const slugs = [...new Set([...catalog.map((g) => g.slug), ...process.argv.slice(2)])];

const out = [];
for (const slug of slugs) {
  const old = catalog.find((g) => g.slug === slug);
  try {
    const r = await fetch(`${CDN}/${slug}/catalog/game.json`);
    if (!r.ok) throw new Error(r.status);
    const g = await r.json();
    delete g.h5_url; delete g.screens;
    if (old?.categories?.length) g.categories = old.categories;
    out.push(g);
    console.log(`ok   ${slug}`);
  } catch (e) {
    if (old) out.push(old);
    console.log(`keep ${slug} (R2: ${e.message})`);
  }
}
await writeFile(file, JSON.stringify(out, null, 1) + "\n");
console.log(`catalog/games.json: ${out.length} games`);
