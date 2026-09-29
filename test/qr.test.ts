import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, qrMatrix, qrToTerminal, renderMatrix } from "../src/qr.js";

function crcTable() {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
}
const TABLE = crcTable();
function crc(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

/** A PNG of `pixels` (true = dark): 1-bit palette like the engine's encoder, or 8-bit RGB with every filter type. */
function encodePng(pixels: boolean[][], mode: "palette1" | "rgb8"): Buffer {
  const h = pixels.length;
  const w = pixels[0]!.length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = mode === "palette1" ? 1 : 8;
  ihdr[9] = mode === "palette1" ? 3 : 2;
  const bpp = mode === "palette1" ? 1 : 3;
  const stride = mode === "palette1" ? Math.ceil(w / 8) : w * 3;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) {
      if (mode === "palette1") {
        if (!pixels[y]![x]) raw[x >> 3]! |= 0x80 >> (x & 7); // index 1 = white
      } else {
        const v = pixels[y]![x] ? 10 : 245;
        raw[x * 3] = v;
        raw[x * 3 + 1] = v;
        raw[x * 3 + 2] = v;
      }
    }
    const filter = mode === "palette1" ? 0 : y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? raw[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      out[i + 1] = (raw[i]! - pred) & 0xff;
    }
    rows.push(out);
    prev = raw;
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (mode === "palette1") parts.push(chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])));
  parts.push(chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function fakeQr(size: number, seed = 7): boolean[][] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 2 === 0);
  const m = Array.from({ length: size }, () => Array.from({ length: size }, rnd));
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        m[rr]![cc] = r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2;
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  return m;
}

function scale(m: boolean[][], px: number, quiet: number, pad = 0): boolean[][] {
  const n = (m.length + quiet * 2) * px + pad;
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      const r = Math.floor((y - pad / 2) / px) - quiet;
      const c = Math.floor((x - pad / 2) / px) - quiet;
      return r >= 0 && c >= 0 && r < m.length && c < m.length ? m[r]![c]! : false;
    }),
  );
}

describe("terminal QR code", () => {
  it("reads the module grid back from a 1-bit palette PNG and an RGB PNG with every filter", () => {
    const qr = fakeQr(29);
    for (const mode of ["palette1", "rgb8"] as const) {
      const png = encodePng(scale(qr, 6, 4, 3), mode);
      expect(qrMatrix(decodePng(png))).toEqual(qr);
    }
  });

  it("renders two rows per line, with or without color, and returns null for a non-QR image", () => {
    const qr = fakeQr(21);
    const text = renderMatrix(qr, false);
    expect(text.split("\n")).toHaveLength(Math.ceil((21 + 4) / 2));
    expect(renderMatrix(qr, true)).toContain("\x1b[");
    const url = `data:image/png;base64,${encodePng(scale(qr, 4, 2), "palette1").toString("base64")}`;
    expect(qrToTerminal(url, false)).toBe(text);
    expect(qrToTerminal("data:image/png;base64,AAAA", false)).toBeNull();
  });
});
