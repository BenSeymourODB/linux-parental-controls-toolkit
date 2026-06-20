// Generate the /app PWA icons (#109) — a brand "time ring" mark.
//
// Dependency-free: encodes PNGs with Node's built-in zlib, so the icons are
// reproducible and reviewable rather than committed as opaque binary blobs.
// Run from anywhere: `node server/frontend/scripts/generate-app-icons.mjs`.
//
// Output: server/frontend/static/app-icons/{icon-192,icon-512,
// icon-maskable-512,apple-touch-icon}.png. `static/` is copied verbatim into
// the adapter-static build, so these are served at `/app-icons/*` by Fastify.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "app-icons");

// Brand palette (mirrors design/assets/styles.css: --primary, white).
const PRIMARY = [79, 70, 229];
const WHITE = [255, 255, 255];

/** CRC-32 (PNG polynomial), computed with a lazily-built lookup table. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Assemble one PNG chunk: length + type + data + CRC. */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Encode straight-alpha RGBA pixels (Uint8Array, w*h*4) as a PNG buffer. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12: compression / filter / interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.subarray(y * stride, y * stride + stride).forEach((b, i) => {
      raw[y * (stride + 1) + 1 + i] = b;
    });
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** ~1px-wide analytic coverage for "inside radius R" at distance r. */
const insideCircle = (r, R) => clamp01((R + 0.75 - r) / 1.5);

/** Signed-distance coverage for a rounded square centred on the canvas. */
function insideRoundedSquare(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return clamp01((0.75 - (outside + inside)) / 1.5);
}

/** Composite a straight-alpha source colour over a destination pixel. */
function over(dst, src, srcA) {
  const outA = srcA + dst[3] * (1 - srcA);
  if (outA <= 0) return [0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    dst[i] = (src[i] * srcA + dst[i] * dst[3] * (1 - srcA)) / outA;
  }
  dst[3] = outA;
  return dst;
}

/**
 * Render the icon: a primary-coloured tile with a white "time ring" (a near-
 * full donut with a gap + a 12-o'clock marker dot — the product's burndown-ring
 * motif). `maskable` fills the whole tile edge-to-edge (square) and keeps the
 * mark inside the safe zone; otherwise it's a rounded square on transparency.
 */
function renderIcon(size, { maskable }) {
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const cornerR = maskable ? 0 : size * 0.22;
  // Maskable: shrink the mark to the central safe zone (~80%).
  const markScale = maskable ? 0.8 : 1;
  const ringOuter = size * 0.3 * markScale;
  const ringInner = size * 0.205 * markScale;
  const dotR = size * 0.052 * markScale;
  const dotCy = c - (ringOuter + ringInner) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = [0, 0, 0, 0];
      // Tile background.
      const bgCov = maskable ? 1 : insideRoundedSquare(x + 0.5, y + 0.5, size, cornerR);
      if (bgCov > 0) over(px, PRIMARY, bgCov);
      // White ring with a gap at the top-right (open-clock look).
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const angle = Math.atan2(y + 0.5 - c, x + 0.5 - c); // -PI..PI, 0 = +x
      const inGap = angle > -Math.PI / 2 - 0.35 && angle < -Math.PI / 2 + 0.35;
      let ringCov = insideCircle(r, ringOuter) - insideCircle(r, ringInner);
      if (inGap) ringCov = 0;
      if (ringCov > 0) over(px, WHITE, clamp01(ringCov));
      // 12-o'clock marker dot.
      const dotCov = insideCircle(Math.hypot(x + 0.5 - c, y + 0.5 - dotCy), dotR);
      if (dotCov > 0) over(px, WHITE, dotCov);

      const o = (y * size + x) * 4;
      rgba[o] = Math.round(px[0]);
      rgba[o + 1] = Math.round(px[1]);
      rgba[o + 2] = Math.round(px[2]);
      rgba[o + 3] = Math.round(px[3] * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ["icon-192.png", 192, { maskable: false }],
  ["icon-512.png", 512, { maskable: false }],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon.png", 180, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT_DIR, name), renderIcon(size, opts));
  console.log(`wrote ${name} (${size}x${size})`);
}
