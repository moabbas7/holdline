/**
 * PNG helpers for the visual check: noisy-region detection, visual diffs and blank-screen
 * detection. pngjs and pixelmatch are loaded only when the visual check actually runs.
 */
import type { Rect } from './types.js';

export interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}

type PngMod = typeof import('pngjs');
let pngMod: PngMod | null = null;
async function png(): Promise<PngMod> {
  pngMod ??= await import('pngjs');
  return pngMod;
}

export async function decodePng(buf: Buffer): Promise<Img> {
  const { PNG } = await png();
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: p.data };
}

export async function encodePng(img: Img): Promise<Buffer> {
  const { PNG } = await png();
  const p = new PNG({ width: img.width, height: img.height });
  p.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(p);
}

/** Copy `img` onto a W×H canvas; uncovered pixels are filled with magenta. */
function pad(img: Img, W: number, H: number): Uint8Array {
  if (img.width === W && img.height === H) return img.data;
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255;
    out[i + 1] = 0;
    out[i + 2] = 255;
    out[i + 3] = 255;
  }
  for (let y = 0; y < img.height; y++) {
    out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * W * 4);
  }
  return out;
}

export const GRID = 16;

/**
 * Regions that differ between two screenshots of the same page (live content such as
 * clocks or carousels). Differences are snapped to a 16px grid, grown by two cells (blur and
 * shadows around live content bleed a little) and
 * merged into rectangles. Areas covered by only one image (height changed) are included.
 */
export function noisyRegions(a: Img, b: Img, grid = GRID, grow = 2): Rect[] {
  const W = Math.max(a.width, b.width);
  const H = Math.max(a.height, b.height);
  const da = pad(a, W, H);
  const db = pad(b, W, H);
  const cols = Math.ceil(W / grid);
  const rows = Math.ceil(H / grid);
  const cells = new Uint8Array(cols * rows);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / grid) * cols;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(da[i]! - db[i]!) > 2 || Math.abs(da[i + 1]! - db[i + 1]!) > 2 || Math.abs(da[i + 2]! - db[i + 2]!) > 2 || Math.abs(da[i + 3]! - db[i + 3]!) > 2) {
        cells[row + Math.floor(x / grid)] = 1;
      }
    }
  }
  // Grow by `grow` cells.
  const grown = new Uint8Array(cells.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r * cols + c]) continue;
      for (let dr = -grow; dr <= grow; dr++) for (let dc = -grow; dc <= grow; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) grown[rr * cols + cc] = 1;
      }
    }
  }
  // Horizontal runs per row, then merge identical runs on consecutive rows.
  const rects: Rect[] = [];
  let open = new Map<string, Rect>();
  for (let r = 0; r < rows; r++) {
    const next = new Map<string, Rect>();
    let c = 0;
    while (c < cols) {
      if (!grown[r * cols + c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < cols && grown[r * cols + c]) c++;
      const key = `${start}-${c}`;
      const prev = open.get(key);
      if (prev) {
        prev.height += grid;
        next.set(key, prev);
        open.delete(key);
      } else {
        next.set(key, { x: start * grid, y: r * grid, width: (c - start) * grid, height: grid });
      }
    }
    for (const done of open.values()) rects.push(done);
    open = next;
  }
  for (const done of open.values()) rects.push(done);
  return rects.map((rc) => ({ x: rc.x, y: rc.y, width: Math.min(rc.width, W - rc.x), height: Math.min(rc.height, H - rc.y) }));
}

export interface ImageDiff {
  /** Changed pixels outside noisy regions. */
  changed: number;
  /** Pixels compared (outside noisy regions). */
  compared: number;
  ratio: number;
  sizeChanged: boolean;
  diff: Img;
}

const close = (a: Uint8Array, i: number, b: Uint8Array, j: number) =>
  Math.abs(a[i]! - b[j]!) + Math.abs(a[i + 1]! - b[j + 1]!) + Math.abs(a[i + 2]! - b[j + 2]!) <= 48;

/**
 * Pixels in the cell [x0, x1) × [y0, y1) whose colour differs between `a` and `b` shifted by
 * (dx, dy). Pixels shifted outside the image count as different.
 */
function cellMismatches(a: Uint8Array, b: Uint8Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number, dx: number, dy: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const yy = y + dy;
    for (let x = x0; x < x1; x++) {
      const xx = x + dx;
      if (yy < 0 || yy >= H || xx < 0 || xx >= W || !close(a, (y * W + x) * 4, b, (yy * W + xx) * 4)) n++;
    }
  }
  return n;
}

/**
 * Pixel diff of two screenshots, ignoring `noisy` regions. Different sizes are padded.
 * Changed pixels are grouped in 16px cells; a cell whose content matches as a whole when
 * shifted by up to `shift` px is not counted, so layout jitter (text moved by 1px) is not a
 * change, while different text in the same place still is.
 */
export async function diffImages(before: Img, after: Img, noisy: Rect[] = [], shift = 1): Promise<ImageDiff> {
  const { default: pixelmatch } = await import('pixelmatch');
  const W = Math.max(before.width, after.width);
  const H = Math.max(before.height, after.height);
  const a = pad(before, W, H);
  const b = pad(after, W, H);
  const ignore = new Uint8Array(W * H);
  let ignored = 0;
  for (const r of noisy) {
    for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.height); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(W, r.x + r.width); x++) {
        if (!ignore[y * W + x]) {
          ignore[y * W + x] = 1;
          ignored++;
        }
      }
    }
  }
  const out = new Uint8Array(W * H * 4);
  pixelmatch(a, b, out, W, H, { threshold: 0.1, includeAA: false, alpha: 0.2, diffColor: [255, 0, 0], ...(ignored ? { ignoreMask: ignore } : {}) });
  const isDiff = (o: number) => out[o] === 255 && out[o + 1] === 0 && out[o + 2] === 0;
  let changed = 0;
  const cell = GRID;
  for (let cy = 0; cy < H; cy += cell) {
    for (let cx = 0; cx < W; cx += cell) {
      const x1 = Math.min(W, cx + cell);
      const y1 = Math.min(H, cy + cell);
      let n = 0;
      for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) if (isDiff((y * W + x) * 4)) n++;
      if (n === 0) continue;
      let shifted = false;
      if (shift > 0) {
        const base = cellMismatches(a, b, W, H, cx, cy, x1, y1, 0, 0);
        for (let dy = -shift; dy <= shift && !shifted; dy++) {
          for (let dx = -shift; dx <= shift && !shifted; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (cellMismatches(a, b, W, H, cx, cy, x1, y1, dx, dy) <= Math.max(2, base * 0.1)) shifted = true;
          }
        }
      }
      if (!shifted) {
        changed += n;
        continue;
      }
      // Moved by at most `shift` px: shown in orange, not counted.
      for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) if (isDiff((y * W + x) * 4)) out[(y * W + x) * 4 + 1] = 170;
    }
  }
  // Show ignored (noisy) regions in grey on the diff image.
  if (ignored) {
    for (let p = 0; p < ignore.length; p++) {
      if (!ignore[p]) continue;
      out[p * 4] = 200;
      out[p * 4 + 1] = 200;
      out[p * 4 + 2] = 200;
      out[p * 4 + 3] = 255;
    }
  }
  const compared = W * H - ignored;
  return {
    changed,
    compared,
    ratio: compared > 0 ? changed / compared : 0,
    sizeChanged: before.width !== after.width || before.height !== after.height,
    diff: { width: W, height: H, data: out },
  };
}

/** True when at least `share` of the pixels have the same colour (a blank screen). */
export function isSingleColour(img: Img, share = 0.9999): boolean {
  const counts = new Map<number, number>();
  const step = 2;
  let total = 0;
  for (let p = 0; p < img.width * img.height; p += step) {
    const i = p * 4;
    const key = ((img.data[i]! >> 2) << 12) | ((img.data[i + 1]! >> 2) << 6) | (img.data[i + 2]! >> 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  }
  let max = 0;
  for (const v of counts.values()) max = Math.max(max, v);
  return total > 0 && max / total >= share;
}
