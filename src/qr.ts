// Shows an account's QR code in the terminal. The API gives it as a PNG data
// URL (`qrCodeUrl`), so there is no text to re-encode: the PNG is decoded
// (node:zlib; non-interlaced, any bit depth and color type), the module grid
// is read back from the finder pattern, and each pair of rows becomes one line
// of half blocks.

import { inflateSync } from "node:zlib";

export interface Bitmap {
  width: number;
  height: number;
  /** true = dark, row-major. */
  dark: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function pngFromDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) throw new Error("not a PNG data URL");
  return Buffer.from(m[1]!, "base64");
}

export function decodePng(png: Buffer): Bitmap {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Buffer | undefined;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[12] !== 0) throw new Error("interlaced PNG");
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || !width || !height) throw new Error("unsupported PNG");
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const sample = (y: number, i: number): number => {
    // The i-th sample of row y, scaled to 0..255.
    if (bitDepth === 8) return rows[y * stride + i]!;
    if (bitDepth === 16) return rows[y * stride + i * 2]!;
    const bit = i * bitDepth;
    const byte = rows[y * stride + (bit >> 3)]!;
    const v = (byte >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1));
  };
  const dark = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number;
      let alpha = 255;
      if (colorType === 3) {
        const idx = sample(y, x);
        r = palette?.[idx * 3] ?? 0;
        g = palette?.[idx * 3 + 1] ?? 0;
        b = palette?.[idx * 3 + 2] ?? 0;
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = sample(y, x * channels);
        if (colorType === 4) alpha = sample(y, x * channels + 1);
      } else {
        r = sample(y, x * channels);
        g = sample(y, x * channels + 1);
        b = sample(y, x * channels + 2);
        if (colorType === 6) alpha = sample(y, x * channels + 3);
      }
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * (alpha / 255) + 255 * (1 - alpha / 255);
      dark[y * width + x] = lum < 128 ? 1 : 0;
    }
  }
  return { width, height, dark };
}

/** The QR module grid (true = dark) read from a rendered QR code. */
export function qrMatrix(img: Bitmap): boolean[][] {
  const at = (x: number, y: number) => img.dark[y * img.width + x] === 1;
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!at(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("blank image");
  // The top-left finder pattern starts at (minX, minY) with a 7-module dark run.
  let run = 0;
  while (minX + run <= maxX && at(minX + run, minY)) run++;
  const module = run / 7;
  const size = Math.round((maxX - minX + 1) / module);
  if (module < 1 || size < 21 || size > 177 || (size - 17) % 4 !== 0) throw new Error("no QR code found");
  const matrix: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) {
      const x = Math.min(maxX, Math.floor(minX + (c + 0.5) * module));
      const y = Math.min(maxY, Math.floor(minY + (r + 0.5) * module));
      row.push(at(x, y));
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * Renders the grid with a quiet zone, two rows per line. With color, dark and
 * light are painted explicitly (works on light and dark terminals); without,
 * light modules are drawn as blocks, which reads right on a dark background.
 */
export function renderMatrix(matrix: boolean[][], color: boolean, quiet = 2): string {
  const n = matrix.length + quiet * 2;
  const get = (r: number, c: number) => {
    const rr = r - quiet;
    const cc = c - quiet;
    return rr >= 0 && cc >= 0 && rr < matrix.length && cc < matrix.length ? matrix[rr]![cc]! : false;
  };
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const top = get(r, c);
      const bottom = r + 1 < n ? get(r + 1, c) : false;
      if (color) line += `\x1b[${top ? 30 : 97};${bottom ? 40 : 107}m▀`;
      else line += !top && !bottom ? "█" : !top ? "▀" : !bottom ? "▄" : " ";
    }
    lines.push(color ? `${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}

/** The QR code of a PNG data URL as terminal text, or null when it cannot be read. */
export function qrToTerminal(dataUrl: string, color: boolean): string | null {
  try {
    return renderMatrix(qrMatrix(decodePng(pngFromDataUrl(dataUrl))), color);
  } catch {
    return null;
  }
}
