/** Independent TypeScript pixel-art 2–6× scaler for Komika.
 *
 * Not a translation of any GPL shader/source. Rules come only from the
 * project filter plan:
 *   y = 0.299R+0.587G+0.114B
 *   u = (B-y)*0.565
 *   v = (R-y)*0.713
 *   dist = 48*|Δy| + 7*|Δu| + 6*|Δv|
 *   equal ⇔ dist < 96
 *   factor 2: full 2× corner blend matrix on a 3×3 neighborhood
 *   factors 3–6: reuse 2× edge decisions (perimeter-aware n×n stamp)
 */

export type ScaleSource = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

const EQUAL_COLOR_TOLERANCE = 96;

type RGB = { r: number; g: number; b: number; a: number };

function getPixel(src: ScaleSource, x: number, y: number): RGB {
  const cx = x < 0 ? 0 : x >= src.width ? src.width - 1 : x;
  const cy = y < 0 ? 0 : y >= src.height ? src.height - 1 : y;
  const i = (cy * src.width + cx) * 4;
  return {
    r: src.data[i]!,
    g: src.data[i + 1]!,
    b: src.data[i + 2]!,
    a: src.data[i + 3]!,
  };
}

function setPixel(out: Uint8ClampedArray, width: number, x: number, y: number, p: RGB): void {
  const i = (y * width + x) * 4;
  out[i] = p.r;
  out[i + 1] = p.g;
  out[i + 2] = p.b;
  out[i + 3] = p.a;
}

/** Plan-fixed YUV-ish distance. */
export function xbrzDist(a: RGB, b: RGB): number {
  const y1 = 0.299 * a.r + 0.587 * a.g + 0.114 * a.b;
  const y2 = 0.299 * b.r + 0.587 * b.g + 0.114 * b.b;
  const u1 = (a.b - y1) * 0.565;
  const u2 = (b.b - y2) * 0.565;
  const v1 = (a.r - y1) * 0.713;
  const v2 = (b.r - y2) * 0.713;
  return 48 * Math.abs(y1 - y2) + 7 * Math.abs(u1 - u2) + 6 * Math.abs(v1 - v2);
}

export function xbrzEqual(a: RGB, b: RGB): boolean {
  return xbrzDist(a, b) < EQUAL_COLOR_TOLERANCE;
}

function mix(a: RGB, b: RGB, wa: number, wb: number): RGB {
  const s = wa + wb;
  return {
    r: ((a.r * wa + b.r * wb) / s + 0.5) | 0,
    g: ((a.g * wa + b.g * wb) / s + 0.5) | 0,
    b: ((a.b * wa + b.b * wb) / s + 0.5) | 0,
    a: ((a.a * wa + b.a * wb) / s + 0.5) | 0,
  };
}

/**
 * Decide whether the oriented corner (ph,pv,pd) of center e should blend.
 *
 * Edge strength: the two edge neighbors ph/pv differ from e, and the diagonal
 * pd continues one of them (L or diagonal step). Reject flat regions and
 * 2×2 checker noise.
 */
function cornerWantsBlend(e: RGB, ph: RGB, pv: RGB, pd: RGB): boolean {
  // No edge if center already matches either edge neighbor.
  if (xbrzEqual(e, ph) || xbrzEqual(e, pv)) return false;
  // Both edge neighbors equal and differ from e → orthogonal edge, not a corner feature.
  if (xbrzEqual(ph, pv) && !xbrzEqual(ph, pd)) return false;
  // Diagonal / L: pd matches one edge neighbor (or both on a filled wedge).
  if (xbrzEqual(pd, ph) || xbrzEqual(pd, pv) || xbrzEqual(ph, pv)) {
    // Prefer blending when the non-edge side of the corner is closer to e than
    // the edge side (keeps 1px features).
    const edgeCost = xbrzDist(e, ph) + xbrzDist(e, pv);
    const fillCost = xbrzDist(e, pd) * 2;
    return edgeCost >= fillCost;
  }
  // Distinct 3-color corner: blend if e is an outlier against the wedge.
  return xbrzDist(e, pd) < Math.min(xbrzDist(e, ph), xbrzDist(e, pv));
}

/**
 * Full 2× blend matrix for one source pixel.
 * Output:
 *   TL TR
 *   BL BR
 *
 * Each non-NONE corner:
 *   - corner pixel: 50% toward nearer edge neighbor
 *   - two adjacent edge pixels: 25% toward that neighbor
 * When both arms of a corner fire as a continuous diagonal (pd matches both
 * directions via equality chain), the corner alone takes 50% (diagonal).
 */
function blend2xBlock(
  out: Uint8ClampedArray,
  outW: number,
  bx: number,
  by: number,
  A: RGB,
  B: RGB,
  C: RGB,
  D: RGB,
  E: RGB,
  F: RGB,
  G: RGB,
  H: RGB,
  I: RGB
): void {
  // Default fill with center.
  setPixel(out, outW, bx, by, E);
  setPixel(out, outW, bx + 1, by, E);
  setPixel(out, outW, bx, by + 1, E);
  setPixel(out, outW, bx + 1, by + 1, E);

  type Corner = {
    cx: number;
    cy: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    ph: RGB;
    pv: RGB;
    pd: RGB;
  };

  const corners: Corner[] = [
    // TL: horiz D, vert B, diag A
    { cx: bx, cy: by, ax: bx + 1, ay: by, bx: bx, by: by + 1, ph: D, pv: B, pd: A },
    // TR: horiz F, vert B, diag C
    { cx: bx + 1, cy: by, ax: bx, ay: by, bx: bx + 1, by: by + 1, ph: F, pv: B, pd: C },
    // BR: horiz F, vert H, diag I
    { cx: bx + 1, cy: by + 1, ax: bx + 1, ay: by, bx: bx, by: by + 1, ph: F, pv: H, pd: I },
    // BL: horiz D, vert H, diag G
    { cx: bx, cy: by + 1, ax: bx, ay: by, bx: bx + 1, by: by + 1, ph: D, pv: H, pd: G },
  ];

  for (const c of corners) {
    if (!cornerWantsBlend(E, c.ph, c.pv, c.pd)) continue;
    const col = xbrzDist(E, c.ph) <= xbrzDist(E, c.pv) ? c.ph : c.pv;
    const diagonal =
      (xbrzEqual(c.pd, c.ph) && xbrzEqual(c.pd, c.pv)) ||
      (xbrzEqual(c.ph, c.pv) && xbrzEqual(c.pd, c.ph));

    // Corner pixel
    setPixel(out, outW, c.cx, c.cy, mix(E, col, 1, 1));

    if (!diagonal) {
      // Edge-adjacent pixels of the 2× matrix (shallow/steep arms).
      const curA = {
        r: out[(c.ay * outW + c.ax) * 4]!,
        g: out[(c.ay * outW + c.ax) * 4 + 1]!,
        b: out[(c.ay * outW + c.ax) * 4 + 2]!,
        a: out[(c.ay * outW + c.ax) * 4 + 3]!,
      };
      const curB = {
        r: out[(c.by * outW + c.bx) * 4]!,
        g: out[(c.by * outW + c.bx) * 4 + 1]!,
        b: out[(c.by * outW + c.bx) * 4 + 2]!,
        a: out[(c.by * outW + c.bx) * 4 + 3]!,
      };
      // 25% toward edge color on both arms.
      setPixel(out, outW, c.ax, c.ay, mix(curA, col, 3, 1));
      setPixel(out, outW, c.bx, c.by, mix(curB, col, 3, 1));
    }
  }
}

function scale2x(src: ScaleSource, out: Uint8ClampedArray, outW: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const A = getPixel(src, x - 1, y - 1);
      const B = getPixel(src, x, y - 1);
      const C = getPixel(src, x + 1, y - 1);
      const D = getPixel(src, x - 1, y);
      const E = getPixel(src, x, y);
      const F = getPixel(src, x + 1, y);
      const G = getPixel(src, x - 1, y + 1);
      const H = getPixel(src, x, y + 1);
      const I = getPixel(src, x + 1, y + 1);
      blend2xBlock(out, outW, x * 2, y * 2, A, B, C, D, E, F, G, H, I);
    }
  }
}

function stampFrom2x(
  src: ScaleSource,
  factor: number,
  out: Uint8ClampedArray,
  outW: number
): void {
  // xBRZ-inspired 3–6× using 2× edge decisions.
  const tmpW = src.width * 2;
  const tmp = new Uint8ClampedArray(tmpW * src.height * 2 * 4);
  scale2x(src, tmp, tmpW);

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const E = getPixel(src, x, y);
      const iTL = (y * 2 * tmpW + x * 2) * 4;
      const iTR = iTL + 4;
      const iBL = ((y * 2 + 1) * tmpW + x * 2) * 4;
      const iBR = iBL + 4;
      const tl = { r: tmp[iTL]!, g: tmp[iTL + 1]!, b: tmp[iTL + 2]!, a: tmp[iTL + 3]! };
      const tr = { r: tmp[iTR]!, g: tmp[iTR + 1]!, b: tmp[iTR + 2]!, a: tmp[iTR + 3]! };
      const bl = { r: tmp[iBL]!, g: tmp[iBL + 1]!, b: tmp[iBL + 2]!, a: tmp[iBL + 3]! };
      const br = { r: tmp[iBR]!, g: tmp[iBR + 1]!, b: tmp[iBR + 2]!, a: tmp[iBR + 3]! };

      const ox = x * factor;
      const oy = y * factor;
      for (let py = 0; py < factor; py++) {
        for (let px = 0; px < factor; px++) {
          let p = E;
          const left = px === 0;
          const right = px === factor - 1;
          const top = py === 0;
          const bottom = py === factor - 1;
          if (top && left) p = tl;
          else if (top && right) p = tr;
          else if (bottom && left) p = bl;
          else if (bottom && right) p = br;
          else if (top) p = mix(tl, tr, factor - 1 - px, px);
          else if (bottom) p = mix(bl, br, factor - 1 - px, px);
          else if (left) p = mix(tl, bl, factor - 1 - py, py);
          else if (right) p = mix(tr, br, factor - 1 - py, py);
          setPixel(out, outW, ox + px, oy + py, p);
        }
      }
    }
  }
}

export function xbrzScale(src: ScaleSource, factor: 2 | 3 | 4 | 5 | 6): ScaleSource {
  if (factor < 2 || factor > 6 || (factor | 0) !== factor) {
    throw new Error("xbrzScale: factor must be 2..6");
  }
  if (src.width < 1 || src.height < 1) {
    throw new Error("xbrzScale: source size must be >= 1");
  }

  const outW = src.width * factor;
  const outH = src.height * factor;
  const out = new Uint8ClampedArray(outW * outH * 4);

  if (factor === 2) {
    scale2x(src, out, outW);
  } else {
    stampFrom2x(src, factor, out, outW);
  }

  return { data: out, width: outW, height: outH };
}
