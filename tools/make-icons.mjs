/**
 * tools/make-icons.mjs — generates the PNG app icons with no dependencies.
 *
 * Run: node tools/make-icons.mjs
 * Writes assets/icon-192.png, assets/icon-512.png and assets/icon-maskable-512.png
 * using a minimal PNG encoder built on node:zlib.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'assets');

/* ------------------------------ PNG encoder ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------- drawing -------------------------------- */

function hexToRgb(hex) {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function createCanvas(size) {
  return { size, pixels: new Uint8Array(size * size * 4) };
}

function blend(canvas, x, y, [r, g, b], alpha = 1) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  const dst = canvas.pixels;
  dst[i] = Math.round(dst[i] * (1 - a) + r * a);
  dst[i + 1] = Math.round(dst[i + 1] * (1 - a) + g * a);
  dst[i + 2] = Math.round(dst[i + 2] * (1 - a) + b * a);
  dst[i + 3] = Math.max(dst[i + 3], Math.round(255 * a));
}

function fillRoundRect(canvas, x, y, w, h, radius, color, alpha = 1) {
  const rgb = hexToRgb(color);
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
      const dx = Math.min(px - x, x + w - 1 - px);
      const dy = Math.min(py - y, y + h - 1 - py);
      let coverage = 1;
      if (dx < radius && dy < radius) {
        const dist = Math.hypot(radius - dx, radius - dy);
        coverage = Math.max(0, Math.min(1, radius - dist + 0.5));
      }
      if (coverage > 0) blend(canvas, px, py, rgb, alpha * coverage);
    }
  }
}

/* --------------------------------- icon ---------------------------------- */

function drawIcon(size, { maskable }) {
  const canvas = createCanvas(size);
  const bg = maskable ? '#0b1220' : '#0b1220';
  fillRoundRect(canvas, 0, 0, size, size, maskable ? 0 : size * 0.2, bg, 1);

  // Content occupies 78% of the canvas (inside the maskable safe zone).
  const inset = size * (maskable ? 0.14 : 0.11);
  const board = size - inset * 2;
  const cell = board / 9;
  fillRoundRect(canvas, inset, inset, board, board, size * 0.045, '#131c2e', 1);
  fillRoundRect(canvas, inset, inset, board, board, size * 0.045, '#6b80a8', 0.12);

  const thin = Math.max(1, size * 0.008);
  const thick = Math.max(2, size * 0.024);
  for (let i = 1; i < 9; i++) {
    const isThick = i % 3 === 0;
    const width = isThick ? thick : thin;
    const color = isThick ? '#6b80a8' : '#2c3b58';
    const offset = Math.round(inset + cell * i - width / 2);
    fillRoundRect(canvas, offset, inset, width, board, 0, color, 1);
    fillRoundRect(canvas, inset, offset, board, width, 0, color, 1);
  }
  fillRoundRect(canvas, inset, inset, board, board, size * 0.045, '#6b80a8', 0.0);

  const pad = cell * 0.16;
  const clueSize = cell - pad * 2;
  const accentClues = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ];
  const lightClues = [
    [4, 0],
    [5, 1],
  ];
  for (const [col, row] of accentClues) {
    fillRoundRect(
      canvas,
      inset + col * cell + pad,
      inset + row * cell + pad,
      clueSize,
      clueSize,
      cell * 0.2,
      '#4f8cff',
      1,
    );
  }
  for (const [col, row] of lightClues) {
    fillRoundRect(
      canvas,
      inset + col * cell + pad,
      inset + row * cell + pad,
      clueSize,
      clueSize,
      cell * 0.2,
      '#e8eefc',
      0.94,
    );
  }
  return encodePng(size, size, canvas.pixels);
}

mkdirSync(assetsDir, { recursive: true });
const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
];

for (const [name, size, options] of targets) {
  const png = drawIcon(size, options);
  writeFileSync(join(assetsDir, name), png);
  console.log(`wrote assets/${name} (${size}×${size}, ${png.length} bytes)`);
}
