/**
 * Generate public/favicon.ico from the same design as favicon.svg.
 *
 *     node dashboard/tools/make-favicon.mjs
 *
 * An .ico as well as the SVG because the SVG covers current browsers but not
 * bookmark bars, pinned tabs on older Windows builds, or anything that asks for
 * /favicon.ico directly. Written by hand rather than pulling in an image
 * library: the panel's whole point is that it ships no dependencies it does not
 * need, and a 32x32 four-rectangle icon does not need one.
 *
 * ICO here is a container of PNGs, which is legal and much simpler than the
 * legacy BMP-with-AND-mask form.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "favicon.ico");

const GREEN = [0x47, 0x72, 0x3e, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const CLEAR = [0x00, 0x00, 0x00, 0x00];

/** The glyph as fractions of the canvas, so it scales to any size. */
const PANELS = [
  [6 / 32, 6 / 32, 9 / 32, 9 / 32],
  [17 / 32, 6 / 32, 9 / 32, 5 / 32],
  [17 / 32, 13 / 32, 9 / 32, 13 / 32],
  [6 / 32, 17 / 32, 9 / 32, 9 / 32],
];

/** Render one size to raw RGBA. */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.1875); // matches rx=6 at 32px

  const put = (x, y, rgba) => {
    const i = (y * size + x) * 4;
    px[i] = rgba[0];
    px[i + 1] = rgba[1];
    px[i + 2] = rgba[2];
    px[i + 3] = rgba[3];
  };

  // Rounded background. At 16px the radius is 3, which is the difference
  // between a tile and a blob, so it is worth doing properly.
  const inCorner = (x, y) => {
    const cx = x < radius ? radius - 0.5 : x >= size - radius ? size - radius - 0.5 : x;
    const cy = y < radius ? radius - 0.5 : y >= size - radius ? size - radius - 0.5 : y;
    if (cx === x && cy === y) return true;
    return Math.hypot(x - cx, y - cy) <= radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      put(x, y, inCorner(x, y) ? GREEN : CLEAR);
    }
  }

  for (const [fx, fy, fw, fh] of PANELS) {
    const x0 = Math.round(fx * size);
    const y0 = Math.round(fy * size);
    const x1 = Math.min(size, x0 + Math.max(1, Math.round(fw * size)));
    const y1 = Math.min(size, y0 + Math.max(1, Math.round(fh * size)));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) put(x, y, WHITE);
    }
  }
  return px;
}

/* ------------------------------------------------------------------ PNG --- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 (none) is fine for an
  // image this small and keeps the encoder honest.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ ICO --- */

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette size
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const images = [16, 32, 48].map((size) => ({ size, data: png(size, render(size)) }));
writeFileSync(OUT, ico(images));
console.log(
  "wrote %s (%d bytes, sizes %s)",
  OUT,
  images.reduce((n, i) => n + i.data.length, 22 + images.length * 16),
  images.map((i) => i.size).join("/")
);
