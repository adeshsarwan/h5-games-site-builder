#!/usr/bin/env node
/**
 * Adds games to catalog/games.json from R2 (games.gamewhame.com/<slug>/catalog/game.json).
 *   node scripts/sync-catalog.mjs new-game-slug [another-slug]   -> add new games (existing ones are left alone)
 *   node scripts/sync-catalog.mjs --refresh some-slug            -> re-pull a game's text from R2 (overwrites edits!)
 *
 * catalog/games.json is the source of truth: titles, descriptions, how to play and categories are
 * edited there (by hand or with the Launch API, PATCH /api/v1/games/<slug>), so a plain run never
 * overwrites them. The Launch API can also add a game: POST /api/v1/games { "slug": "…" }.
 */
import { readFile, writeFile } from "node:fs/promises";

const CDN = "https://games.gamewhame.com";
const file = new URL("../catalog/games.json", import.meta.url);
const catalog = JSON.parse(await readFile(file, "utf8"));
const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const slugs = args.filter((a) => !a.startsWith("--"));
if (!slugs.length) { console.log("Nothing to do. Usage: sync-catalog.mjs <new-slug>… | --refresh <slug>…"); process.exit(0); }

for (const slug of slugs) {
  const i = catalog.findIndex((g) => g.slug === slug);
  if (i >= 0 && !refresh) { console.log(`keep ${slug} (already in the catalogue; use --refresh to re-pull from R2)`); continue; }
  try {
    const r = await fetch(`${CDN}/${slug}/catalog/game.json`);
    if (!r.ok) throw new Error(r.status);
    const g = await r.json();
    delete g.h5_url; delete g.screens;
    if (i >= 0) {
      const old = catalog[i];
      if (old.categories?.length) g.categories = old.categories; // portal categories, not Play Store ones
      if (old.disabled) g.disabled = true;
      catalog[i] = g;
      console.log(`refreshed ${slug}`);
    } else { catalog.push(g); console.log(`added ${slug}`); }
  } catch (e) {
    console.log(`skip ${slug} (R2: ${e.message})`);
  }
}
await writeFile(file, JSON.stringify(catalog, null, 1) + "\n");
console.log(`catalog/games.json: ${catalog.length} games`);
