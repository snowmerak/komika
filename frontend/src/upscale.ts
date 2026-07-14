export const LANCZOS_A = 3;
/** Soft cap for a single HQ tile buffer (device pixels). ~8 Mi px ≈ 32 MiB RGBA. */
export const HQ_MAX_TILE_PIXELS = 8_388_608;
export const HQ_MAX_TILE_SIDE = 4096;
/** Extra CSS pixels around the visible intersection so small pans do not immediately blank. */
export const HQ_OVERSCAN_CSS = 64;

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

/**
 * Separable Lanczos-3: scale a source axis-aligned sub-rect into dest pixel size.
 * Region coords are in source natural pixels (float OK). Output ImageData of destWidth×destHeight.
 */
export function lanczosScaleRegion(
  src: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  region: { x: number; y: number; w: number; h: number },
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

  // Clamp region into image bounds.
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

/** True when display scale > 1 along either axis (worth Lanczos vs browser bilinear). */
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
