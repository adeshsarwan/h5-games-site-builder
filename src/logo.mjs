// Retro game logos for the portals. A site picks one with site.json "logo": { "motif": "cassette", "tile": "#FF8FB8" }
// (the Launch API sets this for every new site). build.mjs writes logo.svg (header/footer mark), a simpler flat
// favicon.svg, and, when @resvg/resvg-js is installed, logo.png (512, e.g. for the GAM consent message),
// apple-touch-icon.png (180) and favicon.ico (16/32/48).
const INK = "#1B1035", NIGHT = "#2A1A6E", POP = "#B6F23A", HOT = "#D6246E", PAPER = "#F3F1FF";
const S = `stroke="${INK}" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"`;
const s8 = `stroke="${INK}" stroke-width="8" stroke-linejoin="round"`;

/** Default tile colour per motif; any colour works. */
export const TILES = { controller: "#B6F23A", cartridge: "#FFD23F", handheld: "#5CE1E6", cassette: "#FF8FB8", joystick: "#B79CFF", crt: "#FF9F45" };
export const MOTIFS = Object.keys(TILES);

// Drawn inside the 400x400 tile at (46,46). class="fine" = detail left out of the favicon.
const ART = {
  controller: `<g transform="translate(262 252) scale(0.86) translate(-281 -276)">
    <path d="M150 178 h192 c46 0 76 34 84 82 l14 86 c7 42-34 66-62 38 l-40-40 h-184 l-40 40 c-28 28-69 4-62-38 l14-86 c8-48 38-82 84-82 z" fill="${NIGHT}" stroke="${INK}" stroke-width="14" stroke-linejoin="round"/>
    <rect x="148" y="226" width="26" height="78" rx="6" fill="${POP}"/><rect x="122" y="252" width="78" height="26" rx="6" fill="${POP}"/>
    <circle cx="338" cy="240" r="17" fill="${HOT}"/><circle cx="374" cy="276" r="17" fill="${PAPER}"/><circle cx="302" cy="276" r="17" fill="${PAPER}"/><circle cx="338" cy="312" r="17" fill="${HOT}"/></g>`,
  cartridge: `<path d="M164 118 h132 l32 32 v214 a14 14 0 0 1-14 14 h-150 a14 14 0 0 1-14-14 v-232 a14 14 0 0 1 14-14z" fill="${NIGHT}" ${S}/>
    <path class="fine" d="M186 142 h84 M186 160 h84" stroke="${PAPER}" stroke-width="8" stroke-linecap="round" opacity=".55"/>
    <rect x="182" y="188" width="128" height="116" rx="12" fill="${POP}" ${s8}/>
    <g fill="${HOT}"><rect x="226" y="214" width="16" height="16"/><rect x="250" y="214" width="16" height="16"/><rect x="218" y="230" width="56" height="16"/><rect x="218" y="246" width="56" height="16"/><rect x="226" y="262" width="40" height="16"/><rect x="238" y="278" width="16" height="12"/></g>
    <g class="fine" fill="${PAPER}"><rect x="190" y="330" width="14" height="30" rx="3"/><rect x="214" y="330" width="14" height="30" rx="3"/><rect x="238" y="330" width="14" height="30" rx="3"/><rect x="262" y="330" width="14" height="30" rx="3"/><rect x="286" y="330" width="14" height="30" rx="3"/></g>`,
  handheld: `<path d="M176 104 h140 a20 20 0 0 1 20 20 v214 a52 52 0 0 1-52 52 h-108 a20 20 0 0 1-20-20 v-246 a20 20 0 0 1 20-20z" fill="${NIGHT}" ${S}/>
    <rect x="178" y="128" width="136" height="112" rx="10" fill="${INK}"/><rect x="192" y="142" width="108" height="84" rx="4" fill="${POP}"/>
    <g class="fine" fill="${INK}"><rect x="216" y="178" width="12" height="12"/><rect x="264" y="178" width="12" height="12"/><rect x="228" y="166" width="36" height="12"/><rect x="216" y="190" width="60" height="12"/><rect x="204" y="214" width="84" height="8"/></g>
    <rect x="194" y="272" width="22" height="60" rx="5" fill="${POP}"/><rect x="175" y="291" width="60" height="22" rx="5" fill="${POP}"/>
    <circle cx="288" cy="282" r="15" fill="${HOT}"/><circle cx="314" cy="306" r="15" fill="${HOT}"/>
    <path class="fine" d="M276 356 l16-10 M290 362 l16-10 M304 368 l16-10" stroke="${PAPER}" stroke-width="6" stroke-linecap="round" opacity=".6"/>`,
  cassette: `<rect x="98" y="148" width="296" height="196" rx="24" fill="${NIGHT}" ${S}/>
    <rect x="128" y="172" width="236" height="104" rx="12" fill="${PAPER}" ${s8}/><rect x="128" y="172" width="236" height="22" rx="10" fill="${HOT}"/>
    <rect x="170" y="210" width="152" height="48" rx="24" fill="${INK}"/>
    <circle cx="200" cy="234" r="18" fill="${POP}"/><circle cx="292" cy="234" r="18" fill="${POP}"/><circle cx="200" cy="234" r="7" fill="${INK}"/><circle cx="292" cy="234" r="7" fill="${INK}"/>
    <path d="M152 344 l18-46 h152 l18 46z" fill="${NIGHT}" ${S}/>
    <circle class="fine" cx="200" cy="322" r="8" fill="${INK}"/><circle class="fine" cx="292" cy="322" r="8" fill="${INK}"/>`,
  joystick: `<path d="M118 286 h256 a20 20 0 0 1 20 20 v54 a20 20 0 0 1-20 20 h-256 a20 20 0 0 1-20-20 v-54 a20 20 0 0 1 20-20z" fill="${NIGHT}" ${S}/>
    <ellipse cx="226" cy="290" rx="44" ry="14" fill="${INK}"/>
    <rect x="216" y="170" width="20" height="122" rx="8" fill="${PAPER}" stroke="${INK}" stroke-width="10"/>
    <circle cx="226" cy="150" r="48" fill="${HOT}" ${S}/><circle cx="210" cy="134" r="12" fill="${PAPER}" opacity=".75"/>
    <circle cx="316" cy="322" r="20" fill="${POP}" stroke="${INK}" stroke-width="8"/><circle cx="358" cy="322" r="14" fill="${PAPER}" stroke="${INK}" stroke-width="8"/>
    <circle class="fine" cx="140" cy="340" r="9" fill="${POP}"/>`,
  crt: `<path d="M216 152 l-40-52 M276 152 l40-52" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>
    <circle cx="176" cy="98" r="11" fill="${HOT}" stroke="${INK}" stroke-width="6"/><circle cx="316" cy="98" r="11" fill="${HOT}" stroke="${INK}" stroke-width="6"/>
    <rect x="92" y="150" width="308" height="226" rx="32" fill="${NIGHT}" ${S}/>
    <rect x="118" y="174" width="200" height="176" rx="34" fill="${INK}"/><rect x="132" y="188" width="172" height="148" rx="26" fill="${POP}"/>
    <rect class="fine" x="160" y="300" width="116" height="10" fill="${INK}"/>
    <g fill="${HOT}"><rect x="198" y="226" width="14" height="14"/><rect x="226" y="226" width="14" height="14"/><rect x="186" y="240" width="66" height="14"/><rect x="186" y="254" width="66" height="14"/><rect x="198" y="268" width="42" height="14"/><rect x="212" y="282" width="14" height="12"/></g>
    <circle cx="360" cy="208" r="18" fill="${POP}" stroke="${INK}" stroke-width="8"/><circle class="fine" cx="360" cy="258" r="14" fill="${HOT}" stroke="${INK}" stroke-width="8"/>
    <path class="fine" d="M342 302 h36 M342 318 h36 M342 334 h36" stroke="${PAPER}" stroke-width="6" stroke-linecap="round" opacity=".6"/>`,
};

const pick = (motif) => ART[motif] ? motif : "controller";
const tileOf = (motif, tile) => /^#[0-9a-f]{6}$/i.test(tile || "") ? tile : TILES[pick(motif)];

/** Sticker logo: tilted tile with an offset shadow (header, footer, 512px PNG). */
export function logoSvg(motif, tile) {
  const m = pick(motif);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><g transform="rotate(-6 256 256)">
<rect x="70" y="70" width="400" height="400" rx="96" fill="${INK}"/><rect x="46" y="46" width="400" height="400" rx="96" fill="${tileOf(m, tile)}" stroke="${INK}" stroke-width="16"/>
${ART[m]}</g></svg>\n`;
}

/** Favicon: flat, square, no shadow or tilt, the object enlarged and fine detail dropped so it reads at 16–48px. */
export function faviconSvg(motif, tile) {
  const m = pick(motif);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><style>.fine{display:none}</style>
<rect x="14" y="14" width="484" height="484" rx="112" fill="${tileOf(m, tile)}" stroke="${INK}" stroke-width="28"/>
<g transform="translate(256 256) scale(1.32) translate(-246 -246)">${ART[m]}</g></svg>\n`;
}

/** favicon.ico holding PNG images (supported by every current browser and Google Search). */
export function icoFromPngs(pngs /* [{ size, data: Buffer }] */) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}
