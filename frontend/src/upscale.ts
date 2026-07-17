import { xbrzScale, type ScaleSource as XbrzSource } from "./xbrz.js";

export const LANCZOS_A = 3;
/** Soft cap for a single HQ tile buffer (device pixels). ~8 Mi px ≈ 32 MiB RGBA. */
export const HQ_MAX_TILE_PIXELS = 8_388_608;
export const HQ_MAX_TILE_SIDE = 4096;
/** Extra CSS pixels around the visible intersection so small pans do not immediately blank. */
export const HQ_OVERSCAN_CSS = 64;

export type ScaleSource = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};
export type ScaleRegion = { x: number; y: number; w: number; h: number };
export type CanvasScaleRendering = "highQuality" | "noHalo" | "xbrz";

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function lanczosWeight(x: number, a: number): number {
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  return sinc(x) * sinc(x / a);
}

function clampByte(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 255) return 255;
  return (v + 0.5) | 0;
}

function clampRegion(
  region: ScaleRegion,
  srcW: number,
  srcH: number
): { rx: number; ry: number; rw: number; rh: number } {
  let rx = region.x;
  let ry = region.y;
  let rw = region.w;
  let rh = region.h;
  if (rx < 0) {
    rw += rx;
    rx = 0;
  }
  if (ry < 0) {
    rh += ry;
    ry = 0;
  }
  if (rx + rw > srcW) rw = srcW - rx;
  if (ry + rh > srcH) rh = srcH - ry;
  return { rx, ry, rw, rh };
}

function bilinearScaleBuffer(
  src: ScaleSource,
  destWidth: number,
  destHeight: number
): ImageData {
  if (destWidth < 1 || destHeight < 1) {
    throw new Error("bilinearScaleBuffer: dest size must be >= 1");
  }
  const srcW = src.width;
  const srcH = src.height;
  const srcData = src.data;
  const out = new Uint8ClampedArray(destWidth * destHeight * 4);
  for (let dy = 0; dy < destHeight; dy++) {
    const v = ((dy + 0.5) / destHeight) * srcH - 0.5;
    const y0 = Math.min(srcH - 1, Math.max(0, Math.floor(v)));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, v - y0));
    for (let dx = 0; dx < destWidth; dx++) {
      const u = ((dx + 0.5) / destWidth) * srcW - 0.5;
      const x0 = Math.min(srcW - 1, Math.max(0, Math.floor(u)));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, u - x0));
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const o = (dy * destWidth + dx) * 4;
      for (let c = 0; c < 4; c++) {
        const top = srcData[i00 + c]! * (1 - fx) + srcData[i10 + c]! * fx;
        const bot = srcData[i01 + c]! * (1 - fx) + srcData[i11 + c]! * fx;
        out[o + c] = clampByte(top * (1 - fy) + bot * fy);
      }
    }
  }
  return new ImageData(out, destWidth, destHeight);
}

/**
 * Separable Lanczos-3: scale a source axis-aligned sub-rect into dest pixel size.
 * Region coords are in source natural pixels (float OK). Output ImageData of destWidth×destHeight.
 */
export function lanczosScaleRegion(
  src: ScaleSource,
  region: ScaleRegion,
  destWidth: number,
  destHeight: number
): ImageData {
  if (destWidth < 1 || destHeight < 1) {
    throw new Error("lanczosScaleRegion: dest size must be >= 1");
  }
  if (src.width < 1 || src.height < 1) {
    throw new Error("lanczosScaleRegion: source size must be >= 1");
  }

  const a = LANCZOS_A;
  const srcW = src.width;
  const srcH = src.height;
  const srcData = src.data;

  const { rx, ry, rw, rh } = clampRegion(region, srcW, srcH);
  if (rw < 1 || rh < 1) {
    throw new Error("lanczosScaleRegion: region empty after clamp");
  }

  const scaleX = destWidth / rw;
  const scaleY = destHeight / rh;

  // Horizontal pass over integer source rows covering the region.
  const yStart = Math.max(0, Math.floor(ry));
  const yEnd = Math.min(srcH - 1, Math.ceil(ry + rh) - 1);
  const rowCount = yEnd - yStart + 1;
  if (rowCount < 1) {
    throw new Error("lanczosScaleRegion: no source rows in region");
  }

  const temp = new Float32Array(destWidth * rowCount * 4);
  const radiusX = scaleX >= 1 ? a : a / scaleX;

  for (let row = 0; row < rowCount; row++) {
    const sy = yStart + row;
    for (let dx = 0; dx < destWidth; dx++) {
      const u = rx + ((dx + 0.5) / destWidth) * rw - 0.5;
      const x0 = Math.floor(u - radiusX) + 1;
      const x1 = Math.ceil(u + radiusX);

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let wSum = 0;

      for (let ix = x0; ix <= x1; ix++) {
        const cx = Math.min(srcW - 1, Math.max(0, ix));
        const dist = scaleX >= 1 ? u - ix : (u - ix) * scaleX;
        const w = lanczosWeight(dist, a);
        if (w === 0) continue;
        const idx = (sy * srcW + cx) * 4;
        r += srcData[idx]! * w;
        g += srcData[idx + 1]! * w;
        b += srcData[idx + 2]! * w;
        alpha += srcData[idx + 3]! * w;
        wSum += w;
      }

      const out = (row * destWidth + dx) * 4;
      if (wSum > 0) {
        const inv = 1 / wSum;
        temp[out] = r * inv;
        temp[out + 1] = g * inv;
        temp[out + 2] = b * inv;
        temp[out + 3] = alpha * inv;
      }
    }
  }

  // Vertical pass into dest.
  const outData = new Uint8ClampedArray(destWidth * destHeight * 4);
  const radiusY = scaleY >= 1 ? a : a / scaleY;

  for (let dy = 0; dy < destHeight; dy++) {
    const v = ry + ((dy + 0.5) / destHeight) * rh - 0.5;
    const y0 = Math.floor(v - radiusY) + 1;
    const y1 = Math.ceil(v + radiusY);

    for (let dx = 0; dx < destWidth; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let wSum = 0;

      for (let iy = y0; iy <= y1; iy++) {
        const syClamped = Math.min(srcH - 1, Math.max(0, iy));
        const row = Math.min(rowCount - 1, Math.max(0, syClamped - yStart));
        const dist = scaleY >= 1 ? v - iy : (v - iy) * scaleY;
        const w = lanczosWeight(dist, a);
        if (w === 0) continue;
        const idx = (row * destWidth + dx) * 4;
        r += temp[idx]! * w;
        g += temp[idx + 1]! * w;
        b += temp[idx + 2]! * w;
        alpha += temp[idx + 3]! * w;
        wSum += w;
      }

      const out = (dy * destWidth + dx) * 4;
      if (wSum > 0) {
        const inv = 1 / wSum;
        outData[out] = clampByte(r * inv);
        outData[out + 1] = clampByte(g * inv);
        outData[out + 2] = clampByte(b * inv);
        outData[out + 3] = clampByte(alpha * inv);
      }
    }
  }

  return new ImageData(outData, destWidth, destHeight);
}

/**
 * NoHalo: one densify stage (edge-aware 2×) then bilinear into the dest tile.
 */
export function noHaloScaleRegion(
  src: ScaleSource,
  region: ScaleRegion,
  destWidth: number,
  destHeight: number
): ImageData {
  if (destWidth < 1 || destHeight < 1) {
    throw new Error("noHaloScaleRegion: dest size must be >= 1");
  }
  if (src.width < 1 || src.height < 1) {
    throw new Error("noHaloScaleRegion: source size must be >= 1");
  }

  const srcW = src.width;
  const srcH = src.height;
  const srcData = src.data;
  const { rx, ry, rw, rh } = clampRegion(region, srcW, srcH);
  if (rw < 1 || rh < 1) {
    throw new Error("noHaloScaleRegion: region empty after clamp");
  }

  const ix0 = Math.max(0, Math.floor(rx) - 1);
  const iy0 = Math.max(0, Math.floor(ry) - 1);
  const ix1 = Math.min(srcW, Math.ceil(rx + rw) + 1);
  const iy1 = Math.min(srcH, Math.ceil(ry + rh) + 1);
  const cw = ix1 - ix0;
  const ch = iy1 - iy0;
  if (cw < 1 || ch < 1) {
    throw new Error("noHaloScaleRegion: densify crop empty");
  }

  const crop = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((iy0 + y) * srcW + (ix0 + x)) * 4;
      const di = (y * cw + x) * 4;
      crop[di] = srcData[si]!;
      crop[di + 1] = srcData[si + 1]!;
      crop[di + 2] = srcData[si + 2]!;
      crop[di + 3] = srcData[si + 3]!;
    }
  }

  const iw = cw * 2;
  const ih = ch * 2;
  const inter = new Uint8ClampedArray(iw * ih * 4);

  const sample = (x: number, y: number, c: number): number => {
    const cx = Math.min(cw - 1, Math.max(0, x));
    const cy = Math.min(ch - 1, Math.max(0, y));
    return crop[(cy * cw + cx) * 4 + c]!;
  };
  const mixCh = (a: number, b: number): number => ((a + b) / 2 + 0.5) | 0;

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const A = [sample(x, y, 0), sample(x, y, 1), sample(x, y, 2), sample(x, y, 3)];
      const B = [sample(x + 1, y, 0), sample(x + 1, y, 1), sample(x + 1, y, 2), sample(x + 1, y, 3)];
      const C = [sample(x, y + 1, 0), sample(x, y + 1, 1), sample(x, y + 1, 2), sample(x, y + 1, 3)];
      const D = [
        sample(x + 1, y + 1, 0),
        sample(x + 1, y + 1, 1),
        sample(x + 1, y + 1, 2),
        sample(x + 1, y + 1, 3),
      ];

      let dAD = 0;
      let dBC = 0;
      for (let c = 0; c < 3; c++) {
        dAD = Math.max(dAD, Math.abs(A[c]! - D[c]!));
        dBC = Math.max(dBC, Math.abs(B[c]! - C[c]!));
      }

      let TL: number[];
      let TR: number[];
      let BL: number[];
      let BR: number[];
      if (dAD < dBC) {
        TL = A;
        TR = [mixCh(A[0]!, B[0]!), mixCh(A[1]!, B[1]!), mixCh(A[2]!, B[2]!), mixCh(A[3]!, B[3]!)];
        BL = [mixCh(A[0]!, C[0]!), mixCh(A[1]!, C[1]!), mixCh(A[2]!, C[2]!), mixCh(A[3]!, C[3]!)];
        BR = [mixCh(A[0]!, D[0]!), mixCh(A[1]!, D[1]!), mixCh(A[2]!, D[2]!), mixCh(A[3]!, D[3]!)];
      } else if (dBC < dAD) {
        TL = [mixCh(A[0]!, B[0]!), mixCh(A[1]!, B[1]!), mixCh(A[2]!, B[2]!), mixCh(A[3]!, B[3]!)];
        TR = B;
        BL = C;
        BR = [mixCh(B[0]!, C[0]!), mixCh(B[1]!, C[1]!), mixCh(B[2]!, C[2]!), mixCh(B[3]!, C[3]!)];
      } else {
        TL = A;
        TR = [mixCh(A[0]!, B[0]!), mixCh(A[1]!, B[1]!), mixCh(A[2]!, B[2]!), mixCh(A[3]!, B[3]!)];
        BL = [mixCh(A[0]!, C[0]!), mixCh(A[1]!, C[1]!), mixCh(A[2]!, C[2]!), mixCh(A[3]!, C[3]!)];
        BR = [mixCh(B[0]!, C[0]!), mixCh(B[1]!, C[1]!), mixCh(B[2]!, C[2]!), mixCh(B[3]!, C[3]!)];
      }

      const write = (px: number, py: number, p: number[]): void => {
        const o = (py * iw + px) * 4;
        inter[o] = p[0]!;
        inter[o + 1] = p[1]!;
        inter[o + 2] = p[2]!;
        inter[o + 3] = p[3]!;
      };
      write(x * 2, y * 2, TL);
      write(x * 2 + 1, y * 2, TR);
      write(x * 2, y * 2 + 1, BL);
      write(x * 2 + 1, y * 2 + 1, BR);
    }
  }

  const irx = (rx - ix0) * 2;
  const iry = (ry - iy0) * 2;
  const irw = rw * 2;
  const irh = rh * 2;

  // Bilinear over the mapped intermediate sub-rect.
  const out = new Uint8ClampedArray(destWidth * destHeight * 4);
  for (let dy = 0; dy < destHeight; dy++) {
    const v = iry + ((dy + 0.5) / destHeight) * irh - 0.5;
    const y0 = Math.min(ih - 1, Math.max(0, Math.floor(v)));
    const y1 = Math.min(ih - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, v - y0));
    for (let dx = 0; dx < destWidth; dx++) {
      const u = irx + ((dx + 0.5) / destWidth) * irw - 0.5;
      const x0 = Math.min(iw - 1, Math.max(0, Math.floor(u)));
      const x1 = Math.min(iw - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, u - x0));
      const i00 = (y0 * iw + x0) * 4;
      const i10 = (y0 * iw + x1) * 4;
      const i01 = (y1 * iw + x0) * 4;
      const i11 = (y1 * iw + x1) * 4;
      const o = (dy * destWidth + dx) * 4;
      for (let c = 0; c < 4; c++) {
        const top = inter[i00 + c]! * (1 - fx) + inter[i10 + c]! * fx;
        const bot = inter[i01 + c]! * (1 - fx) + inter[i11 + c]! * fx;
        out[o + c] = clampByte(top * (1 - fy) + bot * fy);
      }
    }
  }
  return new ImageData(out, destWidth, destHeight);
}

export function pickXbrzFactor(scaleX: number, scaleY: number): number | null {
  const s = Math.max(scaleX, scaleY);
  if (s < 1.5) return null;
  return Math.min(6, Math.max(2, Math.round(s)));
}

export { xbrzScale } from "./xbrz.js";

export function scaleRegionForRendering(
  rendering: CanvasScaleRendering,
  src: ScaleSource,
  region: ScaleRegion,
  destWidth: number,
  destHeight: number
): ImageData {
  switch (rendering) {
    case "highQuality":
      return lanczosScaleRegion(src, region, destWidth, destHeight);
    case "noHalo":
      return noHaloScaleRegion(src, region, destWidth, destHeight);
    case "xbrz": {
      const srcW = src.width;
      const srcH = src.height;
      let x0 = Math.floor(region.x);
      let y0 = Math.floor(region.y);
      let x1 = Math.ceil(region.x + region.w);
      let y1 = Math.ceil(region.y + region.h);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > srcW) x1 = srcW;
      if (y1 > srcH) y1 = srcH;
      const cw = x1 - x0;
      const ch = y1 - y0;
      if (cw < 1 || ch < 1) {
        throw new Error("scaleRegionForRendering: xbrz crop empty");
      }
      const factor = pickXbrzFactor(destWidth / region.w, destHeight / region.h);
      if (factor == null) {
        throw new Error("scaleRegionForRendering: xbrz factor unavailable");
      }
      const cropData = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const si = ((y0 + y) * srcW + (x0 + x)) * 4;
          const di = (y * cw + x) * 4;
          cropData[di] = src.data[si]!;
          cropData[di + 1] = src.data[si + 1]!;
          cropData[di + 2] = src.data[si + 2]!;
          cropData[di + 3] = src.data[si + 3]!;
        }
      }
      const scaled = xbrzScale(
        { data: cropData, width: cw, height: ch } as XbrzSource,
        factor as 2 | 3 | 4 | 5 | 6
      );
      if (scaled.width === destWidth && scaled.height === destHeight) {
        const copy =
          scaled.data instanceof Uint8ClampedArray
            ? scaled.data
            : new Uint8ClampedArray(scaled.data);
        return new ImageData(copy, scaled.width, scaled.height);
      }
      return bilinearScaleBuffer(scaled, destWidth, destHeight);
    }
    default: {
      const _exhaustive: never = rendering;
      throw new Error(`scaleRegionForRendering: unsupported ${_exhaustive}`);
    }
  }
}

/** Cheap path: drawImage full source or sub-rect into canvas (smoothing high). */
export function drawImageRegion(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  src: { x: number; y: number; w: number; h: number },
  destW: number,
  destH: number
): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, destW, destH);
  ctx.drawImage(source, src.x, src.y, src.w, src.h, 0, 0, destW, destH);
}

/** True when display scale > 1 along either axis (worth filter vs browser bilinear). */
export function shouldUpscaleHQ(scaleX: number, scaleY: number): boolean {
  return scaleX > 1.01 || scaleY > 1.01;
}

/** Clamp tile device size to HQ_MAX_*; returns adjusted dest and a note if capped. */
export function clampTileDest(destW: number, destH: number): { w: number; h: number; capped: boolean } {
  let w = Math.max(1, Math.round(destW));
  let h = Math.max(1, Math.round(destH));
  let capped = false;

  if (w > HQ_MAX_TILE_SIDE || h > HQ_MAX_TILE_SIDE) {
    const factor = Math.min(HQ_MAX_TILE_SIDE / w, HQ_MAX_TILE_SIDE / h);
    w = Math.max(1, Math.floor(w * factor));
    h = Math.max(1, Math.floor(h * factor));
    capped = true;
  }

  const pixels = w * h;
  if (pixels > HQ_MAX_TILE_PIXELS) {
    const factor = Math.sqrt(HQ_MAX_TILE_PIXELS / pixels);
    w = Math.max(1, Math.floor(w * factor));
    h = Math.max(1, Math.floor(h * factor));
    if (w > HQ_MAX_TILE_SIDE || h > HQ_MAX_TILE_SIDE) {
      const f2 = Math.min(HQ_MAX_TILE_SIDE / w, HQ_MAX_TILE_SIDE / h);
      w = Math.max(1, Math.floor(w * f2));
      h = Math.max(1, Math.floor(h * f2));
    }
    capped = true;
  }

  return { w, h, capped };
}
