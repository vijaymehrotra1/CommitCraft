// Renders media/icon.png (256x256): a commit graph with a branch, plus a sparkle, on a gradient tile.
// No dependencies: shapes are rasterised with 3x3 supersampling and written as a PNG with node:zlib.
// Usage: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const SS = 3; // samples per axis per pixel

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

const distanceToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const inRoundedSquare = (x, y, radius) => {
  const cx = Math.min(Math.max(x, radius), SIZE - radius);
  const cy = Math.min(Math.max(y, radius), SIZE - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
};

const LINE = 6;
const NODES = [
  [92, 58],
  [92, 198],
  [164, 84],
];
const SEGMENTS = [
  [92, 58, 92, 198],
  [92, 168, 164, 110],
  [164, 110, 164, 84],
];
const inGlyph = (x, y) => {
  if (SEGMENTS.some(([ax, ay, bx, by]) => distanceToSegment(x, y, ax, ay, bx, by) <= LINE)) {
    return true;
  }
  return NODES.some(([cx, cy]) => {
    const d = Math.hypot(x - cx, y - cy);
    return d <= 21 && d >= 10; // a ring
  });
};

// Four-point sparkle (an astroid-like star) at the top right.
const inSparkle = (x, y) => {
  const [cx, cy, r] = [208, 52, 30];
  return Math.abs(x - cx) ** 0.55 + Math.abs(y - cy) ** 0.55 <= r ** 0.55;
};

const background = (x, y) => {
  const t = (x + y) / (2 * SIZE);
  return [Math.round(31 + (124 - 31) * t), Math.round(111 + (58 - 111) * t), Math.round(235 + (237 - 235) * t)];
};

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) {
    let tile = 0;
    let glyph = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (inRoundedSquare(px, py, 52)) {
          tile++;
          if (inGlyph(px, py) || inSparkle(px, py)) {
            glyph++;
          }
        }
      }
    }
    const total = SS * SS;
    const [r, g, b] = background(x, y);
    const mix = tile === 0 ? 0 : glyph / tile;
    const offset = 1 + x * 4;
    row[offset] = Math.round(r + (255 - r) * mix);
    row[offset + 1] = Math.round(g + (255 - g) * mix);
    row[offset + 2] = Math.round(b + (255 - b) * mix);
    row[offset + 3] = Math.round((tile / total) * 255);
  }
  rows.push(row);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('media', { recursive: true });
writeFileSync('media/icon.png', png);
console.log(`media/icon.png written (${png.length} bytes, ${SIZE}x${SIZE})`);
