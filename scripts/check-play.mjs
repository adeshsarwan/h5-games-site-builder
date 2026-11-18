#!/usr/bin/env node
// Finds game files that a portal's /play/ proxy serves as an error while games.gamewhame.com serves them fine
// (e.g. a 404 cached at the edge before the game was uploaded).
//
//   node scripts/check-play.mjs                 all sites in sites/ that have a domain
//   node scripts/check-play.mjs gametuno-com    one site
//
// For each game: loads https://<domain>/play/<slug>/, reads the Build/* file names from the HTML, and fetches the first
// byte of each file from the portal and from the CDN. Exit code 1 if any mismatch is found.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const CDN = "https://games.gamewhame.com";
const catalog = JSON.parse(await readFile(path.join(ROOT, "catalog", "games.json"), "utf8"));
const all = (Array.isArray(catalog) ? catalog : catalog.games || Object.values(catalog)).filter((g) => !g.disabled).map((g) => g.slug);

const status = async (u) => {
  try {
    const r = await fetch(u, { headers: { range: "bytes=0-0" }, redirect: "follow" });
    await r.body?.cancel();
    return r.status;
  } catch (e) { return `ERR ${e.code || e.message}`; }
};
const ok = (s) => s === 200 || s === 206;

const keys = process.argv[2] ? [process.argv[2]] : await readdir(path.join(ROOT, "sites"));
let bad = 0;
for (const key of keys) {
  const site = JSON.parse(await readFile(path.join(ROOT, "sites", key, "site.json"), "utf8"));
  if (!site.domain) continue;
  const games = (site.games === "all" ? all : site.games).filter((s) => !(site.exclude || []).includes(s));
  // Check where visitors actually load games from (play host if set).
  const base = `https://${site.playHost || site.domain}/play`;
  console.log(`\n${key} (${base}): ${games.length} games`);
  for (const slug of games) {
    let html = "";
    const page = await fetch(`${base}/${slug}/`).then(async (r) => { html = await r.text(); return r.status; }).catch((e) => `ERR ${e.message}`);
    const files = [...new Set(html.match(/Build\/[A-Za-z0-9._-]+/g) || [])];
    const problems = [];
    if (!ok(page)) problems.push(`index ${page}`);
    if (ok(page) && !files.length) problems.push("no Build/ files found in HTML");
    for (const f of files) {
      const [mine, cdn] = await Promise.all([status(`${base}/${slug}/${f}`), status(`${CDN}/${slug}/${f}`)]);
      if (!ok(mine)) problems.push(`${f}: portal ${mine}, CDN ${cdn}${ok(cdn) ? "  <- stuck at the edge" : "  <- missing in R2"}`);
    }
    if (problems.length) { bad++; console.log(`  ✗ ${slug}\n      ${problems.join("\n      ")}`); }
    else console.log(`  ✓ ${slug}`);
  }
}
console.log(bad ? `\n${bad} game(s) with problems.` : "\nAll games load.");
process.exit(bad ? 1 : 0);
