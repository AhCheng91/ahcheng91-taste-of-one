import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// A top-down bowl of ramen, shaded from signed distance fields.
// Render at 2048 and box-downsample to 1024 before encoding a PNG by hand.
const RENDER = 2048;
const SIZE = 1024;
const SS = RENDER / SIZE;
const TAU = Math.PI * 2;
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const BOWL_X = 512;
const BOWL_Y = 520;
const BOWL_R = 432;
const BROTH_R = 359;
const frame = new Float32Array(RENDER * RENDER * 3);
const scratchN = { x: 0, y: 0, z: 1 };
const LX = -0.60, LY = -0.72, LZ = 0.35;
const HX = -0.365, HY = -0.438, HZ = 0.821;
const FX = 0.58, FY = 0.70, FZ = 0.41;
// Deterministic noise and seeded generators
function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, seed: number): number { // Smooth 2D value noise on a unit lattice.
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2i(ix, iy, seed);
  const b = hash2i(ix + 1, iy, seed);
  const c = hash2i(ix, iy + 1, seed);
  const d = hash2i(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
function fbm(x: number, y: number, seed: number, octaves: number): number { // Fractal Brownian motion from layered value noise.
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 97) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
function makeRng(seed: number): () => number { // Small seeded PRNG so every garnish position is fixed.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Scalar helpers and the float frame
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function mix(a: number, b: number, t: number): number { // Linear interpolation between two scalars.
  return a + (b - a) * t;
}
function smoothstep(a: number, b: number, x: number): number { // Hermite step between two edges.
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function put(px: number, py: number, r: number, g: number, b: number, a: number): void { // Alpha-composite one render pixel into the float frame.
  if (a <= 0.001 || px < 0 || py < 0 || px >= RENDER || py >= RENDER) return;
  const k = 1 - a;
  const i = (py * RENDER + px) * 3;
  frame[i] = frame[i] * k + r * a;
  frame[i + 1] = frame[i + 1] * k + g * a;
  frame[i + 2] = frame[i + 2] * k + b * a;
}
function eachPixel(x0: number, y0: number, x1: number, y1: number, fn: (u: number, v: number, px: number, py: number) => void): void { // Visit render pixels whose centres fall in a design-space box.
  const ix0 = Math.max(0, Math.floor(x0 * SS));
  const iy0 = Math.max(0, Math.floor(y0 * SS));
  const ix1 = Math.min(RENDER - 1, Math.ceil(x1 * SS));
  const iy1 = Math.min(RENDER - 1, Math.ceil(y1 * SS));
  for (let py = iy0; py <= iy1; py++) {
    const v = (py + 0.5) / SS;
    for (let px = ix0; px <= ix1; px++) {
      fn((px + 0.5) / SS, v, px, py);
    }
  }
}
// Signed distance fields
function sdfCircle(u: number, v: number, cx: number, cy: number, r: number): number {
  return Math.hypot(u - cx, v - cy) - r;
}
function sdfEllipse(u: number, v: number, cx: number, cy: number, rx: number, ry: number, ang: number): number { // Approximate signed distance to a rotated ellipse.
  const dx = u - cx, dy = v - cy;
  const c = Math.cos(ang), s = Math.sin(ang);
  const x = c * dx + s * dy;
  const y = -s * dx + c * dy;
  return (Math.hypot(x / rx, y / ry) - 1) * Math.min(rx, ry);
}
function sdfRoundRect(u: number, v: number, cx: number, cy: number, hw: number, hh: number, rad: number, ang: number): number { // Signed distance to a rotated rounded rectangle.
  const dx = u - cx, dy = v - cy;
  const c = Math.cos(ang), s = Math.sin(ang);
  const x = c * dx + s * dy;
  const y = -s * dx + c * dy;
  const qx = Math.abs(x) - hw + rad;
  const qy = Math.abs(y) - hh + rad;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - rad;
}
function ellipseNormal(u: number, v: number, cx: number, cy: number, rx: number, ry: number, ang: number): typeof scratchN { // Reusable fake dome normal from an ellipse distance field.
  const dx = u - cx, dy = v - cy;
  const c = Math.cos(ang), s = Math.sin(ang);
  const x = c * dx + s * dy;
  const y = -s * dx + c * dy;
  const gx = x / (rx * rx), gy = y / (ry * ry);
  const wx = c * gx - s * gy, wy = s * gx + c * gy;
  const gl = Math.hypot(wx, wy);
  const k = Math.min(1, Math.hypot(x / rx, y / ry));
  const nz = Math.sqrt(Math.max(0, 1 - k * k));
  if (gl < 1e-7) {
    scratchN.x = 0; scratchN.y = 0; scratchN.z = 1;
  } else {
    scratchN.x = (wx / gl) * k;
    scratchN.y = (wy / gl) * k;
    scratchN.z = nz;
  }
  return scratchN;
}
function keyDiffuse(nx: number, ny: number, nz: number): number { // Lambert term for the warm upper-left key light.
  return Math.max(0, nx * LX + ny * LY + nz * LZ);
}
function fillDiffuse(nx: number, ny: number, nz: number): number { // Lambert term for the cool lower-right fill light.
  return Math.max(0, nx * FX + ny * FY + nz * FZ);
}
function specular(nx: number, ny: number, nz: number, power: number): number { // Blinn specular term for a given exponent.
  const d = Math.max(0, nx * HX + ny * HY + nz * HZ);
  return Math.pow(d, power);
}
// Soft shadows
function ellipseShadow(cx: number, cy: number, rx: number, ry: number, ang: number, blur: number, strength: number, dx: number, dy: number): void {
  eachPixel(cx - rx - blur + dx, cy - ry - blur + dy, cx + rx + blur + dx, cy + ry + blur + dy,
    (u, v, px, py) => {
      const d = sdfEllipse(u - dx, v - dy, cx, cy, rx, ry, ang);
      const a = (1 - smoothstep(-blur * 0.35, blur, d)) * strength;
      if (a <= 0.002) return;
      const i = (py * RENDER + px) * 3;
      frame[i] *= (1 - a) + 0.34 * a;
      frame[i + 1] *= (1 - a) + 0.31 * a;
      frame[i + 2] *= (1 - a) + 0.35 * a;
    });
}
function roundRectShadow(cx: number, cy: number, hw: number, hh: number, rad: number, ang: number, blur: number, strength: number, dx: number, dy: number): void { // Soft shadow under a rotated rounded rectangle.
  eachPixel(cx - hw - blur + dx, cy - hh - blur + dy, cx + hw + blur + dx, cy + hh + blur + dy,
    (u, v, px, py) => {
      const d = sdfRoundRect(u - dx, v - dy, cx, cy, hw, hh, rad, ang);
      const a = (1 - smoothstep(-blur * 0.35, blur, d)) * strength;
      if (a <= 0.002) return;
      const i = (py * RENDER + px) * 3;
      frame[i] *= (1 - a) + 0.34 * a;
      frame[i + 1] *= (1 - a) + 0.31 * a;
      frame[i + 2] *= (1 - a) + 0.35 * a;
    });
}
// Tabletop: dark slate with grain, a warm pool upper-left, a cool corner
function paintTabletop(): void {
  eachPixel(0, 0, SIZE, SIZE, (u, v, px, py) => {
    const streak = fbm(u * 0.010, v * 0.135, 11, 3) - 0.5;
    const broad = fbm(u * 0.0022, v * 0.0032, 23, 2) - 0.5;
    const fine = valueNoise(u * 0.55, v * 0.55, 41) - 0.5;
    const pool = Math.exp(-(((u - 165) ** 2) / (2 * 310 * 310) +
      ((v - 120) ** 2) / (2 * 250 * 250)));
    const cool = Math.exp(-((u - 900) ** 2 + (v - 880) ** 2) / (2 * 360 * 360));
    const shade = streak * 0.075 + broad * 0.05 + fine * 0.022;
    const r = 0.078 + shade + pool * 0.115 - cool * 0.004;
    const g = 0.094 + shade * 0.94 + pool * 0.079 - cool * 0.002;
    const b = 0.102 + shade * 0.88 + pool * 0.052 + cool * 0.009;
    put(px, py, r, g, b, 1);
  });
}
// Bowl: drop shadow, dark ceramic wall, matte rim, red lacquer band
function paintBowl(): void {
  const cx = BOWL_X, cy = BOWL_Y;
  eachPixel(cx - 540, cy - 540, cx + 540, cy + 540, (u, v, px, py) => {
    const d = Math.hypot(u - (cx + 16), v - (cy + 24));
    const a = (1 - smoothstep(424, 520, d)) * 0.52;
    if (a <= 0.003) return;
    const i = (py * RENDER + px) * 3;
    frame[i] *= (1 - a) + 0.30 * a;
    frame[i + 1] *= (1 - a) + 0.27 * a;
    frame[i + 2] *= (1 - a) + 0.31 * a;
  });
  eachPixel(cx - BOWL_R - 6, cy - BOWL_R - 6, cx + BOWL_R + 6, cy + BOWL_R + 6,
    (u, v, px, py) => {
      const dx = u - cx, dy = v - cy;
      const d = Math.hypot(dx, dy);
      if (d > BOWL_R + 3.5) return;
      const rho = Math.max(d, 0.001);
      const ux = dx / rho, uy = dy / rho;
      const upper = Math.max(0, -ux * 0.70 - uy * 0.72);
      const lower = Math.max(0, ux * 0.55 + uy * 0.72);
      const ang = Math.atan2(dy, dx);
      const grain = fbm(Math.cos(ang) * 11 + 8, Math.sin(ang) * 11, 31, 3) - 0.5;
      const radialNoise = fbm(ux * 3.2 + 7, uy * 3.2, 57, 2) - 0.5;
      let r: number, g: number, b: number;
      if (d >= 396) {
        const t = (d - 396) / (BOWL_R - 396);
        r = 0.075 + grain * 0.020 + radialNoise * 0.008;
        g = 0.094 + grain * 0.018 + radialNoise * 0.007;
        b = 0.098 + grain * 0.016 + radialNoise * 0.006;
        const lacquer = 1 - smoothstep(6, 13, Math.abs(d - 408));
        r = mix(r, 0.215, lacquer * 0.34);
        g = mix(g, 0.040, lacquer * 0.34);
        b = mix(b, 0.045, lacquer * 0.34);
        const broad = upper * smoothstep(396, 410, d) * (1 - smoothstep(422, 432, d));
        r += broad * 0.25;
        g += broad * 0.145;
        b += broad * 0.072;
        const lip = Math.pow(upper, 2.4) * Math.exp(-(((d - 430) / 3.2) ** 2));
        r += lip * 0.72;
        g += lip * 0.47;
        b += lip * 0.22;
        const innerRim = Math.exp(-(((d - 397) / 2.6) ** 2)) * (0.35 + 0.65 * lower);
        r += innerRim * 0.045;
        g += innerRim * 0.05;
        b += innerRim * 0.052;
        const matte = specular(0, 0, 1, 9);
        r += matte * 0.05;
        g += matte * 0.045;
        b += matte * 0.04;
      } else {
        const t = clamp01((d - 356) / (396 - 356));
        r = 0.030 + grain * 0.014;
        g = 0.036 + grain * 0.013;
        b = 0.036 + grain * 0.012;
        const wallLight = 0.30 + 0.70 * t;
        const warm = Math.pow(upper, 1.5);
        r += warm * 0.17 * wallLight;
        g += warm * 0.078 * wallLight;
        b += warm * 0.027 * wallLight;
        const refl = Math.exp(-(((d - 359) / 8) ** 2)) * (0.30 + 0.70 * lower);
        r += refl * 0.20;
        g += refl * 0.095;
        b += refl * 0.028;
        const deep = 1 - smoothstep(0.25, 1.0, lower);
        r *= 0.66 + 0.34 * deep;
        g *= 0.66 + 0.34 * deep;
        b *= 0.68 + 0.32 * deep;
        r += (fbm(u * 0.35 + 4, v * 0.35, 63, 3) - 0.5) * 0.012;
        g += (fbm(u * 0.35 + 9, v * 0.35, 67, 3) - 0.5) * 0.012;
        b += (fbm(u * 0.35 + 14, v * 0.35, 71, 3) - 0.5) * 0.011;
      }
      const a = 1 - smoothstep(BOWL_R - 0.5, BOWL_R + 2.5, d);
      put(px, py, Math.max(0, r), Math.max(0, g), Math.max(0, b), a);
    });
}
// Broth: amber radial gradient, gloss, ripples, oil droplets
function paintOilDroplets(): void {
  const rng = makeRng(0x51ee12);
  const drops: Array<[number, number, number, number, number, number]> = [];
  for (let i = 0; i < 190; i++) {
    const a = rng() * TAU;
    const rad = Math.sqrt(rng()) * (BROTH_R - 20);
    const x = BOWL_X + Math.cos(a) * rad;
    const y = BOWL_Y + Math.sin(a) * rad * 0.98;
    const rx = 1.4 + rng() * 4.6;
    const ry = rx * (0.55 + rng() * 0.45);
    const rot = rng() * TAU;
    const op = 0.35 + rng() * 0.5;
    drops.push([x, y, rx, ry, rot, op]);
  }
  for (const [x, y, rx, ry, rot, op] of drops) {
    eachPixel(x - rx - 2, y - ry - 2, x + rx + 2, y + ry + 2, (u, v, px, py) => {
      const dx = u - x, dy = v - y;
      const c = Math.cos(rot), s = Math.sin(rot);
      const lx = c * dx + s * dy, ly = -s * dx + c * dy;
      const q = Math.hypot(lx / rx, ly / ry);
      const a = (1 - smoothstep(0.90, 1.06, q)) * op;
      if (a <= 0.003) return;
      const ring = smoothstep(0.50, 0.88, q) * (1 - smoothstep(0.88, 1.04, q));
      const hl = Math.exp(-(((lx + rx * 0.30) ** 2 + (ly + ry * 0.34) ** 2) /
        (2 * (Math.max(1.1, rx * 0.18)) ** 2)));
      const r = 0.62 + ring * 0.35 + hl * 0.55;
      const g = 0.31 + ring * 0.32 + hl * 0.50;
      const b = 0.07 + ring * 0.15 + hl * 0.42;
      put(px, py, r, g, b, a);
    });
  }
}
function paintBroth(): void { // Amber broth with gloss, ripples and a dark edge contact line.
  const cx = BOWL_X, cy = BOWL_Y;
  eachPixel(cx - BROTH_R - 5, cy - BROTH_R - 5, cx + BROTH_R + 5, cy + BROTH_R + 5,
    (u, v, px, py) => {
      const dx = u - cx, dy = v - cy;
      const d = Math.hypot(dx, dy);
      if (d > BROTH_R + 3) return;
      const edge = clamp01(d / BROTH_R);
      const t = Math.pow(1 - edge, 1.25);
      const ripple = fbm(u * 0.018 + 3, v * 0.018, 81, 3) - 0.5;
      const fine = valueNoise(u * 0.62, v * 0.62, 83) - 0.5;
      let r = mix(0.472, 0.688, t) + ripple * 0.030 + fine * 0.012;
      let g = mix(0.230, 0.416, t) + ripple * 0.024 + fine * 0.010;
      let b = mix(0.074, 0.166, t) + ripple * 0.014 + fine * 0.008;
      const bloom = Math.exp(-(((u - 424) ** 2) / (2 * 190 * 190) +
        ((v - 405) ** 2) / (2 * 165 * 165)));
      const hot = Math.exp(-(((u - 452) ** 2 + (v - 386) ** 2) / (2 * 52 * 52)));
      r += bloom * 0.155 + hot * 0.20;
      g += bloom * 0.122 + hot * 0.155;
      b += bloom * 0.075 + hot * 0.085;
      const rimAO = smoothstep(0.84, 1.0, edge);
      const ao = 1 - rimAO * 0.38;
      r *= ao; g *= ao; b *= ao;
      r *= 0.985 + 0.015 * fine;
      g *= 0.985 + 0.015 * fine;
      const a = 1 - smoothstep(BROTH_R - 0.5, BROTH_R + 2.2, d);
      put(px, py, Math.max(0, r), Math.max(0, g), Math.max(0, b), a);
    });
  paintOilDroplets();
}
// Noodles: a tangle of pale golden tubes in the centre-right
type Point = { x: number; y: number };
type Strand = { pts: Point[]; width: number; lift: number };
function buildNoodles(): Strand[] { // Seeded loop and sweep paths for the noodle tangle.
  const rng = makeRng(0x1a2b3c);
  const strands: Strand[] = [];
  const cx = 660, cy = 552;
  for (let i = 0; i < 23; i++) {
    const r = 58 + rng() * 132;
    const a0 = rng() * TAU;
    const sweep = (1.3 + rng() * 2.8) * (rng() < 0.5 ? 1 : -1);
    const ox = cx + (rng() - 0.5) * 120;
    const oy = cy + (rng() - 0.5) * 110;
    const squash = 0.66 + rng() * 0.30;
    const modFreq = 1.6 + rng() * 0.1;
    const pts: Point[] = [];
    const count = 320;
    for (let j = 0; j <= count; j++) {
      const s = j / count;
      const ang = a0 + sweep * s;
      const rr = r * (0.88 + 0.12 * Math.sin(s * Math.PI * modFreq));
      pts.push({ x: ox + Math.cos(ang) * rr, y: oy + Math.sin(ang) * rr * squash });
    }
    strands.push({ pts, width: 5.8 + rng() * 3.4, lift: i > 18 ? 0.35 + rng() * 0.4 : rng() * 0.2 });
  }
  for (let i = 0; i < 4; i++) {
    const startA = 1.0 + i * 0.55;
    const pts: Point[] = [];
    for (let j = 0; j < 90; j++) {
      const s = j / 89;
      const x = 520 + s * 330 + Math.sin(s * 5.2 + i * 1.4) * 28;
      const y = 610 - s * 190 + Math.cos(s * 4.1 + i * 1.1) * 30;
      pts.push({ x, y });
    }
    strands.push({ pts, width: 6.4 + i * 0.8, lift: 0.8 });
  }
  return strands;
}
function paintStrand(strand: Strand): void { // Shade one continuous noodle tube and its offset shadow.
  const { pts, width, lift } = strand;
  const n = pts.length;
  let xMin = 1e9, yMin = 1e9, xMax = -1e9, yMax = -1e9;
  for (const p of pts) {
    if (p.x < xMin) xMin = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
  }
  const pad = width + 12;
  eachPixel(xMin - pad, yMin - pad, xMax + pad, yMax + pad, (u, v, px, py) => {
    let best = 1e18, bi = 0;
    for (let i = 0; i < n; i += 4) {
      const d = (u - pts[i].x) ** 2 + (v - pts[i].y) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    const lo = Math.max(0, bi - 5), hi = Math.min(n - 1, bi + 5);
    for (let i = lo; i <= hi; i++) {
      const d = (u - pts[i].x) ** 2 + (v - pts[i].y) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    let qx = pts[bi].x, qy = pts[bi].y;
    let dist = Math.sqrt(best);
    const s0 = Math.max(0, bi - 1);
    const s1 = Math.min(n - 2, bi);
    for (let si = s0; si <= s1; si++) {
      const ax = pts[si].x, ay = pts[si].y;
      const vx = pts[si + 1].x - ax, vy = pts[si + 1].y - ay;
      const t = clamp01(((u - ax) * vx + (v - ay) * vy) / (vx * vx + vy * vy + 1e-6));
      const nx = ax + vx * t, ny = ay + vy * t;
      const d = Math.hypot(u - nx, v - ny);
      if (d < dist) { dist = d; qx = nx; qy = ny; }
    }
    const shadowD = Math.hypot(u - qx - 4.5, v - qy - 7.5) - width * 1.03;
    const sa = (1 - smoothstep(-2.5, 4.8, shadowD)) * 0.32;
    if (sa > 0.003) {
      const si = (py * RENDER + px) * 3;
      frame[si] *= (1 - sa) + 0.27 * sa;
      frame[si + 1] *= (1 - sa) + 0.23 * sa;
      frame[si + 2] *= (1 - sa) + 0.26 * sa;
    }
    const q = dist / width;
    if (q > 1.10) return;
    const a = 1 - smoothstep(0.93, 1.06, q);
    if (a <= 0.003) return;
    const k = Math.min(1, q);
    const dx = u - qx, dy = v - qy;
    const nx = dist > 1e-5 ? (dx / dist) * k : 0;
    const ny = dist > 1e-5 ? (dy / dist) * k : 0;
    const nz = Math.sqrt(Math.max(0, 1 - k * k));
    const diff = keyDiffuse(nx, ny, nz);
    const fill = fillDiffuse(nx, ny, nz);
    const broad = specular(nx, ny, nz, 18);
    const tight = specular(nx, ny, nz, 90);
    const lit = clamp01(0.18 + 0.92 * diff + lift * 0.16);
    let cr = mix(0.41, 0.945, lit) + fill * 0.030 + broad * 0.10 + tight * 0.20;
    let cg = mix(0.27, 0.775, lit) + fill * 0.034 + broad * 0.085 + tight * 0.19;
    let cb = mix(0.105, 0.405, lit) + fill * 0.045 + broad * 0.075 + tight * 0.17;
    const starchy = valueNoise(u * 1.4 + qy * 0.05, v * 1.4, 91) - 0.5;
    cr += starchy * 0.018; cg += starchy * 0.016; cb += starchy * 0.012;
    put(px, py, Math.max(0, cr), Math.max(0, cg), Math.max(0, cb), a);
  });
}
function paintNoodles(): void { // Lay down all noodle strands back to front.
  for (const strand of buildNoodles()) paintStrand(strand);
}
// Egg halves: set white with an irregular edge, jammy orange yolk
function paintEgg(cx: number, cy: number, rx: number, ry: number, ang: number, yolkX: number, yolkY: number, yolkRx: number, yolkRy: number, seed: number): void {
  ellipseShadow(cx, cy, rx * 1.02, ry * 1.02, ang, 15, 0.46, 7, 12);
  ellipseShadow(cx, cy, rx, ry, ang, 4, 0.26, 1, 2);
  eachPixel(cx - rx - 8, cy - ry - 8, cx + rx + 8, cy + ry + 8, (u, v, px, py) => {
    const dcx = u - cx, dcy = v - cy;
    const edgeAng = Math.atan2(dcy, dcx);
    const wobble = (fbm(Math.cos(edgeAng) * 2.1 + 3, Math.sin(edgeAng) * 2.1, seed, 2) - 0.5) * 4.0 +
      Math.sin(edgeAng * 5 + seed) * 1.1 + Math.sin(edgeAng * 9 + seed * 0.7) * 0.55;
    const d = sdfEllipse(u, v, cx, cy, rx, ry, ang) + wobble;
    if (d > 2.5) return;
    const a = 1 - smoothstep(-0.9, 1.0, d);
    if (a <= 0.003) return;
    const n = ellipseNormal(u, v, cx, cy, rx, ry, ang);
    const diff = keyDiffuse(n.x, n.y, n.z);
    const fill = fillDiffuse(n.x, n.y, n.z);
    const broad = specular(n.x, n.y, n.z, 22);
    const tight = specular(n.x, n.y, n.z, 110);
    const rim = smoothstep(-8, 0, d);
    let r = 0.915 * (0.50 + 0.62 * diff) + fill * 0.030;
    let g = 0.862 * (0.50 + 0.62 * diff) + fill * 0.038;
    let b = 0.760 * (0.50 + 0.62 * diff) + fill * 0.052;
    r += broad * 0.07 + tight * 0.11;
    g += broad * 0.065 + tight * 0.105;
    b += broad * 0.060 + tight * 0.10;
    r -= rim * 0.11; g -= rim * 0.095; b -= rim * 0.06;
    const streak = fbm(u * 0.20 + seed, v * 0.05, seed + 9, 2) - 0.5;
    const curd = fbm(u * 0.42 + seed, v * 0.42, seed + 21, 3) - 0.5;
    r += streak * 0.014 + curd * 0.021;
    g += streak * 0.011 + curd * 0.019;
    b += streak * 0.008 + curd * 0.016;
    put(px, py, Math.max(0, r), Math.max(0, g), Math.max(0, b), a);
  });
  ellipseShadow(yolkX, yolkY, yolkRx * 1.05, yolkRy * 1.05, ang, 4, 0.22, 2, 3);
  eachPixel(yolkX - yolkRx - 6, yolkY - yolkRy - 6,
    yolkX + yolkRx + 6, yolkY + yolkRy + 6, (u, v, px, py) => {
      const edgeAng = Math.atan2(v - yolkY, u - yolkX);
      const wobble = (fbm(Math.cos(edgeAng) * 3, Math.sin(edgeAng) * 3, seed + 5, 2) - 0.5) * 2.2;
      const d = sdfEllipse(u, v, yolkX, yolkY, yolkRx, yolkRy, ang) + wobble;
      if (d > 2.5) return;
      const a = 1 - smoothstep(-0.8, 1.0, d);
      if (a <= 0.003) return;
      const n = ellipseNormal(u, v, yolkX, yolkY, yolkRx, yolkRy, ang);
      const diff = keyDiffuse(n.x, n.y, n.z);
      const fill = fillDiffuse(n.x, n.y, n.z);
      const broad = specular(n.x, n.y, n.z, 24);
      const tight = specular(n.x, n.y, n.z, 120);
      const q = clamp01(Math.hypot((u - yolkX) / yolkRx, (v - yolkY) / yolkRy));
      const centre = 1 - Math.pow(q, 1.8);
      let r = mix(0.700, 0.955, centre) * (0.55 + 0.58 * diff) + fill * 0.02;
      let g = mix(0.235, 0.500, centre) * (0.55 + 0.58 * diff) + fill * 0.025;
      let b = mix(0.018, 0.060, centre) * (0.55 + 0.58 * diff) + fill * 0.028;
      const yolkGrain = fbm(u * 0.30 + seed, v * 0.30, seed + 13, 3) - 0.5;
      r += yolkGrain * 0.022; g += yolkGrain * 0.018; b += yolkGrain * 0.008;
      r += broad * 0.11;
      g += broad * 0.10;
      b += broad * 0.06;
      const glint = Math.exp(-(((u - yolkX + yolkRx * 0.34) ** 2 +
        (v - yolkY + yolkRy * 0.40) ** 2) / (2 * Math.max(3, yolkRx * 0.22) ** 2)));
      r += glint * (0.42 + tight * 0.5);
      g += glint * (0.46 + tight * 0.5);
      b += glint * (0.40 + tight * 0.5);
      const ring = smoothstep(0.86, 1.0, q);
      r -= ring * 0.10; g -= ring * 0.07; b -= ring * 0.02;
      put(px, py, Math.max(0, r), Math.max(0, g), Math.max(0, b), a);
    });
}
// Chashu: three overlapping pork slices with fat rim and marbled face
function paintChashuSlice(cx: number, cy: number, r: number, ang: number, seed: number): void {
  ellipseShadow(cx, cy, r * 1.02, r * 1.02, ang, 15, 0.43, 8, 12);
  ellipseShadow(cx, cy, r, r, ang, 4, 0.22, 1, 2);
  eachPixel(cx - r - 8, cy - r - 8, cx + r + 8, cy + r + 8, (u, v, px, py) => {
    const edgeAng = Math.atan2(v - cy, u - cx);
    const wobble = (fbm(Math.cos(edgeAng) * 2.5 + 4, Math.sin(edgeAng) * 2.5,
      seed, 2) - 0.5) * 2.6;
    const d = sdfCircle(u, v, cx, cy, r) + wobble;
    if (d > 2) return;
    const a = 1 - smoothstep(-0.8, 1.0, d);
    if (a <= 0.003) return;
    const n = ellipseNormal(u, v, cx, cy, r, r, ang);
    const flat = 0.46;
    const nl = Math.hypot(n.x * flat, n.y * flat, n.z);
    const nx = (n.x * flat) / nl, ny = (n.y * flat) / nl, nz = n.z / nl;
    const diff = keyDiffuse(nx, ny, nz);
    const fill = fillDiffuse(nx, ny, nz);
    const broad = specular(nx, ny, nz, 22);
    const tight = specular(nx, ny, nz, 110);
    const q = clamp01(Math.hypot(u - cx, v - cy) / r);
    const localX = (u - cx) * Math.cos(ang) - (v - cy) * Math.sin(ang);
    const localY = (u - cx) * Math.sin(ang) + (v - cy) * Math.cos(ang);
    const marble = fbm(localX * 0.060 + 7, localY * 0.115, seed + 3, 3) - 0.5;
    const fineMarble = fbm(localX * 0.20, localY * 0.36, seed + 29, 2) - 0.5;
    const swirl = fbm(localX * 0.016, localY * 0.016, seed + 17, 2) - 0.5;
    let r0 = mix(0.630, 0.790, swirl + 0.5) + marble * 0.150 + fineMarble * 0.050;
    let g0 = mix(0.310, 0.438, swirl + 0.5) + marble * 0.100 + fineMarble * 0.032;
    let b0 = mix(0.210, 0.305, swirl + 0.5) + marble * 0.072 + fineMarble * 0.023;
    const fibre = Math.sin(localY * 0.24 + fbm(localX * 0.03, localY * 0.012,
      seed + 41, 2) * 7.0);
    const streak2 = fbm(localX * 0.075, localY * 0.42, seed + 53, 2) - 0.5;
    r0 += fibre * 0.045 + streak2 * 0.055;
    g0 += fibre * 0.027 + streak2 * 0.034;
    b0 += fibre * 0.020 + streak2 * 0.024;
    const outer = smoothstep(0.944, 0.988, q);
    r0 = mix(r0, 0.365, outer * 0.88);
    g0 = mix(g0, 0.145, outer * 0.88);
    b0 = mix(b0, 0.050, outer * 0.88);
    const fat = smoothstep(0.862, 0.900, q) * (1 - smoothstep(0.936, 0.968, q));
    r0 = mix(r0, 0.965, fat);
    g0 = mix(g0, 0.880, fat);
    b0 = mix(b0, 0.700, fat);
    const char = smoothstep(0.50, 0.86, fbm(Math.cos(edgeAng) * 3.4 + 2,
      Math.sin(edgeAng) * 3.4, seed + 71, 2)) * smoothstep(0.905, 0.975, q);
    r0 = mix(r0, 0.285, char * 0.55);
    g0 = mix(g0, 0.105, char * 0.55);
    b0 = mix(b0, 0.040, char * 0.55);
    const caramel = smoothstep(0.790, 0.868, q) * (1 - smoothstep(0.895, 0.942, q));
    r0 = mix(r0, 0.500, caramel * 0.78);
    g0 = mix(g0, 0.220, caramel * 0.78);
    b0 = mix(b0, 0.078, caramel * 0.78);
    const seam = Math.exp(-(((q - 0.858) / 0.013) ** 2));
    r0 *= 1 - seam * 0.22; g0 *= 1 - seam * 0.24; b0 *= 1 - seam * 0.20;
    const pinkEdge = smoothstep(0.972, 1.0, q);
    r0 = mix(r0, 0.760, pinkEdge * 0.30);
    g0 = mix(g0, 0.380, pinkEdge * 0.30);
    b0 = mix(b0, 0.260, pinkEdge * 0.30);
    const light = 0.62 + 0.52 * diff;
    let cr = r0 * light + fill * 0.032 + broad * 0.055 + tight * 0.14;
    let cg = g0 * light + fill * 0.038 + broad * 0.050 + tight * 0.13;
    let cb = b0 * light + fill * 0.052 + broad * 0.045 + tight * 0.12;
    const wet = Math.exp(-(((u - cx + r * 0.26) ** 2 + (v - cy + r * 0.30) ** 2) /
      (2 * (r * 0.34) ** 2)));
    const wet2 = Math.exp(-(((u - cx - r * 0.12) ** 2 + (v - cy + r * 0.46) ** 2) /
      (2 * (r * 0.16) ** 2)));
    cr += wet * 0.105 + wet2 * 0.06;
    cg += wet * 0.090 + wet2 * 0.045;
    cb += wet * 0.068 + wet2 * 0.030;
    const fatGlint = fat * specular(nx, ny, nz, 36);
    cr += fat * 0.04 + fatGlint * 0.10;
    cg += fat * 0.036 + fatGlint * 0.095;
    cb += fat * 0.030 + fatGlint * 0.080;
    const rimDark = smoothstep(0.978, 1.0, q);
    cr -= rimDark * 0.07; cg -= rimDark * 0.06; cb -= rimDark * 0.05;
    put(px, py, Math.max(0, cr), Math.max(0, cg), Math.max(0, cb), a);
  });
}
function paintChashu(): void { // Three overlapping chashu slices at the lower left.
  paintChashuSlice(300, 630, 78, -0.20, 131);
  paintChashuSlice(374, 692, 74, 0.30, 149);
  paintChashuSlice(320, 748, 76, -0.50, 163);
}
// Nori: dark fibre-lined sheet with a lift shadow
function paintNori(): void {
  const cx = 664, cy = 316, hw = 80, hh = 67, rad = 7, ang = -0.32;
  roundRectShadow(cx, cy, hw, hh, rad, ang, 18, 0.50, 9, 14);
  roundRectShadow(cx, cy, hw, hh, rad, ang, 5, 0.25, 1, 2);
  eachPixel(cx - 110, cy - 110, cx + 110, cy + 110, (u, v, px, py) => {
    const d = sdfRoundRect(u, v, cx, cy, hw, hh, rad, ang);
    if (d > 2.5) return;
    const a = 1 - smoothstep(-0.8, 1.0, d);
    if (a <= 0.003) return;
    const dx = u - cx, dy = v - cy;
    const c = Math.cos(ang), s = Math.sin(ang);
    const lx = c * dx + s * dy;
    const ly = -s * dx + c * dy;
    const fibre = fbm(lx * 0.045, ly * 0.62 + 3, 181, 3) - 0.5;
    const weave = Math.sin(ly * 1.25 + fbm(lx * 0.12, ly * 0.08, 183, 2) * 5.5);
    let r = 0.064 + fibre * 0.035 + weave * 0.008;
    let g = 0.108 + fibre * 0.048 + weave * 0.012;
    let b = 0.080 + fibre * 0.036 + weave * 0.009;
    const dry = fbm(lx * 0.15 + 9, ly * 0.15, 187, 2) - 0.5;
    r += dry * 0.030; g += dry * 0.045; b += dry * 0.032;
    const sheen = Math.max(0, -(lx * 0.6 + ly * 0.8) / Math.max(1, Math.hypot(lx, ly))) *
      (1 - smoothstep(0.70, 1.02, Math.hypot(lx / hw, ly / hh)));
    r += sheen * 0.055; g += sheen * 0.070; b += sheen * 0.050;
    const edge = smoothstep(-3, 0, d);
    r += edge * 0.020; g += edge * 0.028; b += edge * 0.016;
    const side = smoothstep(-2, 0, d) * smoothstep(0.35, 1.0, (v - (cy + hh * 0.55)) / 22);
    r -= side * 0.030; g -= side * 0.024; b -= side * 0.024;
    put(px, py, Math.max(0, r), Math.max(0, g), Math.max(0, b), a);
  });
  const score = Math.sin(ang + 1.5708) * hw * 0.72;
  eachPixel(cx - 100, cy - 100, cx + 100, cy + 100, (u, v, px, py) => {
    const lx = (u - cx) * Math.cos(ang) - (v - cy) * Math.sin(ang);
    const ly = (u - cx) * Math.sin(ang) + (v - cy) * Math.cos(ang);
    if (sdfRoundRect(u, v, cx, cy, hw, hh, rad, ang) > -2) return;
    const line = Math.abs(((ly + score) % 26 + 26) % 26 - 13) < 0.8 &&
      Math.abs(lx) < hw - 8 ? 0.30 : 0;
    if (line <= 0) return;
    put(px, py, 0.035, 0.050, 0.038, line);
  });
}
// Scallion rings, sesame seeds, and a small knot of chili threads
const scallionRings: Array<[number, number, number, number, number]> = [];
const sesameSeeds: Array<[number, number, number, number, number]> = [];
const chiliThreads: Array<[number, number, number, number, number, number]> = [];
function buildGarnishes(): void { // Seeded positions for scallions, sesame and chili.
  const rng = makeRng(0x7a11ce);
  for (let i = 0; i < 30; i++) {
    const a = rng() * TAU;
    const rad = Math.pow(rng(), 1.55) * (BROTH_R - 35);
    const x = BOWL_X + Math.cos(a) * rad;
    const y = BOWL_Y + Math.sin(a) * rad * 0.97;
    if (Math.hypot(x - 330, y - 300) < 98) continue;
    if (Math.hypot(x - 408, y - 372) < 86) continue;
    if (Math.abs(x - 664) < 92 && Math.abs(y - 316) < 82) continue;
    if (Math.hypot(x - 300, y - 630) < 86) continue;
    if (Math.hypot(x - 374, y - 692) < 82) continue;
    if (Math.hypot(x - 320, y - 748) < 84) continue;
    if (Math.hypot(x - 245, y - 790) < 66) continue;
    const ro = 5.4 + rng() * 4.8;
    const ri = ro * (0.38 + rng() * 0.18);
    scallionRings.push([x, y, ro, ri, rng() * TAU]);
  }
  for (let i = 0; i < 16; i++) {
    const a = rng() * TAU;
    const rad = Math.pow(rng(), 1.6) * (BROTH_R - 45);
    const x = BOWL_X + Math.cos(a) * rad;
    const y = BOWL_Y + Math.sin(a) * rad * 0.98;
    if (Math.hypot(x - 330, y - 300) < 92) continue;
    if (Math.hypot(x - 408, y - 372) < 80) continue;
    sesameSeeds.push([x, y, 1.9 + rng() * 1.3, 0.9 + rng() * 0.4, rng() * TAU]);
  }
  const chiliX = 768, chiliY = 462;
  for (let i = 0; i < 34; i++) {
    const a = rng() * TAU;
    const rad = Math.sqrt(rng()) * 27;
    const x = chiliX + Math.cos(a) * rad;
    const y = chiliY + Math.sin(a) * rad;
    const len = 8 + rng() * 19;
    const dir = rng() * TAU;
    chiliThreads.push([x, y, x + Math.cos(dir) * len, y + Math.sin(dir) * len,
      1.0 + rng() * 0.9, rng()]);
  }
}
function paintScallions(): void { // Scatter bright green scallion rings over the bowl.
  for (const [x, y, ro, ri, rot] of scallionRings) {
    eachPixel(x - ro - 4, y - ro - 4, x + ro + 4, y + ro + 4, (u, v, px, py) => {
      const dx = u - x, dy = v - y;
      const c = Math.cos(rot), s = Math.sin(rot);
      const lx = c * dx + s * dy, ly = -s * dx + c * dy;
      const qo = Math.hypot(lx / ro, ly / (ro * 0.82));
      const qi = Math.hypot(lx / ri, ly / (ri * 0.82));
      if (qo > 1.15 || qi < 0.7) return;
      const a = (1 - smoothstep(0.92, 1.08, qo)) * (1 - smoothstep(0.78, 1.02, qi));
      if (a <= 0.004) return;
      const ringT = clamp01((qo - 0.55) / 0.45);
      const inner = 1 - smoothstep(0.72, 1.0, qi);
      const n = ellipseNormal(u, v, x, y, ro, ro * 0.82, rot);
      const diff = keyDiffuse(n.x, n.y, n.z);
      let r = mix(0.115, 0.365, ringT) + diff * 0.055;
      let g = mix(0.360, 0.730, ringT) + diff * 0.075;
      let b = mix(0.115, 0.245, ringT) + diff * 0.030;
      r = mix(r, 0.56, inner * 0.25);
      g = mix(g, 0.83, inner * 0.30);
      b = mix(b, 0.34, inner * 0.22);
      const shine = specular(n.x, n.y, n.z, 40);
      r += shine * 0.20; g += shine * 0.20; b += shine * 0.10;
      put(px, py, clamp01(r), clamp01(g), clamp01(b), a);
    });
  }
}
function paintSesame(): void { // Add a few glossy sesame seeds.
  for (const [x, y, rx, ry, rot] of sesameSeeds) {
    ellipseShadow(x, y, rx, ry, rot, 1.6, 0.34, 1.2, 2.0);
    eachPixel(x - 5, y - 5, x + 5, y + 5, (u, v, px, py) => {
      const q = Math.hypot((u - x) / rx, (v - y) / ry);
      const a = 1 - smoothstep(0.88, 1.05, q);
      if (a <= 0.004) return;
      const t = clamp01((u - x + v - y) / 6 + 0.5);
      let r = mix(0.90, 0.66, t);
      let g = mix(0.84, 0.54, t);
      let b = mix(0.66, 0.34, t);
      const hl = Math.exp(-(((u - x + rx * 0.25) ** 2 + (v - y + ry * 0.3) ** 2) /
        (2 * (rx * 0.38) ** 2)));
      r += hl * 0.30; g += hl * 0.28; b += hl * 0.22;
      put(px, py, r, g, b, a);
    });
  }
}
function paintChili(): void { // Draw a small knot of red chili threads.
  for (const [ax, ay, bx, by, w, seed] of chiliThreads) {
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy + 1e-6;
    eachPixel(Math.min(ax, bx) - 5, Math.min(ay, by) - 5, Math.max(ax, bx) + 5, Math.max(ay, by) + 5,
      (u, v, px, py) => {
        const t = clamp01(((u - ax) * vx + (v - ay) * vy) / len2);
        const qx = ax + vx * t, qy = ay + vy * t;
        const dist = Math.hypot(u - qx, v - qy);
        const q = dist / w;
        if (q > 1.2) return;
        const a = 1 - smoothstep(0.82, 1.08, q);
        if (a <= 0.004) return;
        const lit = clamp01(0.35 + 0.65 * (1 - q) + (seed - 0.5) * 0.30);
        let r = mix(0.44, 0.84, lit);
        let g = mix(0.045, 0.23, lit);
        let b = mix(0.018, 0.075, lit);
        const glint = Math.exp(-((q - 0.28) ** 2) / 0.10) * 0.25;
        r += glint; g += glint * 0.5; b += glint * 0.35;
        put(px, py, r, g, b, a);
      });
  }
}
// Chopsticks and a ceramic spoon
function woodStick(ax: number, ay: number, bx: number, by: number, w0: number, w1: number, seed: number): void {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy + 1e-6;
  ellipseShadow((ax + bx) / 2, (ay + by) / 2, (Math.hypot(vx, vy) / 2 + 14) * 0.5,
    34, Math.atan2(vy, vx), 16, 0.40, 9, 15);
  eachPixel(Math.min(ax, bx) - w0 - 4, Math.min(ay, by) - w0 - 4,
    Math.max(ax, bx) + w0 + 4, Math.max(ay, by) + w0 + 4, (u, v, px, py) => {
      const t = clamp01(((u - ax) * vx + (v - ay) * vy) / len2);
      const qx = ax + vx * t, qy = ay + vy * t;
      const width = mix(w0, w1, t);
      const dx = u - qx, dy = v - qy;
      const dist = Math.hypot(dx, dy);
      const q = dist / width;
      if (q > 1.12) return;
      const a = 1 - smoothstep(0.94, 1.07, q);
      if (a <= 0.003) return;
      const k = Math.min(1, q);
      const nx = dist > 1e-5 ? (dx / dist) * k : 0;
      const ny = dist > 1e-5 ? (dy / dist) * k : 0;
      const nz = Math.sqrt(Math.max(0, 1 - k * k));
      const diff = keyDiffuse(nx, ny, nz);
      const fill = fillDiffuse(nx, ny, nz);
      const broad = specular(nx, ny, nz, 16);
      const tight = specular(nx, ny, nz, 70);
      const grain = fbm((qx * 0.9 + qy * 0.1) * 0.12, t * 22, seed, 3) - 0.5;
      const light = 0.45 + 0.62 * diff;
      let r = mix(0.115, 0.265, light) + grain * 0.035 + broad * 0.10 + tight * 0.16;
      let g = mix(0.065, 0.165, light) + grain * 0.025 + broad * 0.08 + tight * 0.14;
      let b = mix(0.040, 0.100, light) + grain * 0.018 + broad * 0.06 + tight * 0.11;
      const gloss = Math.max(0, -(nx * 0.62 + ny * 0.72)) * (1 - smoothstep(0.6, 1.0, q));
      r += gloss * 0.28; g += gloss * 0.18; b += gloss * 0.08;
      if (t > 0.965) { r += 0.06; g += 0.04; b += 0.02; }
      put(px, py, clamp01(r), clamp01(g), clamp01(b), a);
    });
}
function paintChopsticks(): void { // Two chopsticks resting across the lower-right rim.
  woodStick(570, 946, 842, 642, 9.5, 7.2, 211);
  woodStick(598, 968, 870, 664, 9.5, 7.2, 223);
}
function paintSpoon(): void { // Ceramic spoon lying at the lower-left rim.
  const cx = 222, cy = 818, rx = 50, ry = 37, ang = 0.18;
  const hx = 176, hy = 832, tx = 66, ty = 874;
  ellipseShadow(cx + 7, cy + 12, rx * 1.05, ry * 1.08, ang, 18, 0.46, 7, 12);
  const vx = tx - hx, vy = ty - hy;
  const len2 = vx * vx + vy * vy;
  eachPixel(tx - 24, Math.min(hy, ty) - 24, hx + 24, Math.max(hy, ty) + 24,
    (u, v, px, py) => {
      const t = clamp01(((u - hx) * vx + (v - hy) * vy) / len2);
      const qx = hx + vx * t, qy = hy + vy * t;
      const width = mix(12.5, 9.5, t);
      const dist = Math.hypot(u - qx, v - qy);
      const q = dist / width;
      if (q > 1.1) return;
      const a = 1 - smoothstep(0.94, 1.08, q);
      if (a <= 0.003) return;
      const k = Math.min(1, q);
      const nx = dist > 1e-5 ? (u - qx) / dist * k : 0;
      const ny = dist > 1e-5 ? (v - qy) / dist * k : 0;
      const nz = Math.sqrt(Math.max(0, 1 - k * k));
      const diff = keyDiffuse(nx, ny, nz);
      const fill = fillDiffuse(nx, ny, nz);
      let cr = 0.86 * (0.55 + 0.62 * diff) + fill * 0.045;
      let cg = 0.875 * (0.55 + 0.62 * diff) + fill * 0.055;
      let cb = 0.855 * (0.55 + 0.62 * diff) + fill * 0.070;
      const gloss = specular(nx, ny, nz, 34);
      cr += gloss * 0.16; cg += gloss * 0.15; cb += gloss * 0.14;
      const edge = smoothstep(0.94, 1.02, q);
      cr -= edge * 0.13; cg -= edge * 0.12; cb -= edge * 0.11;
      put(px, py, clamp01(cr), clamp01(cg), clamp01(cb), a);
    });
  eachPixel(cx - rx - 8, cy - ry - 8, cx + rx + 8, cy + ry + 8, (u, v, px, py) => {
    const d = sdfEllipse(u, v, cx, cy, rx, ry, ang);
    if (d > 2.5) return;
    const a = 1 - smoothstep(-0.8, 1.0, d);
    if (a <= 0.003) return;
    const n = ellipseNormal(u, v, cx, cy, rx, ry, ang);
    const diff = keyDiffuse(n.x, n.y, n.z);
    const fill = fillDiffuse(n.x, n.y, n.z);
    const spec = specular(n.x, n.y, n.z, 50);
    const q = clamp01(Math.hypot((u - cx) / rx, (v - cy) / ry));
    const cavity = 1 - smoothstep(0.42, 0.82, q);
    const rimRing = smoothstep(0.76, 0.90, q) * (1 - smoothstep(0.95, 1.02, q));
    let cr = 0.91 * (0.48 + 0.62 * diff) + fill * 0.035;
    let cg = 0.925 * (0.48 + 0.62 * diff) + fill * 0.045;
    let cb = 0.905 * (0.48 + 0.62 * diff) + fill * 0.060;
    cr -= cavity * 0.28; cg -= cavity * 0.27; cb -= cavity * 0.24;
    cr += rimRing * 0.10; cg += rimRing * 0.10; cb += rimRing * 0.09;
    cr += spec * 0.24; cg += spec * 0.23; cb += spec * 0.22;
    const glint = Math.exp(-(((u - cx + rx * 0.30) ** 2 + (v - cy + ry * 0.34) ** 2) /
      (2 * (rx * 0.25) ** 2)));
    cr += glint * 0.22; cg += glint * 0.21; cb += glint * 0.20;
    const edge = smoothstep(-2.2, 0, d);
    cr -= edge * 0.14; cg -= edge * 0.13; cb -= edge * 0.11;
    put(px, py, clamp01(cr), clamp01(cg), clamp01(cb), a);
  });
}
// Steam: a few soft filaments drifting up-right
function paintSteam(): void {
  const wisps = [
    [430, 356, 432, 245, 476, 95, 27, 0.20, 3],
    [548, 330, 616, 200, 626, 62, 24, 0.16, 7],
    [666, 366, 744, 238, 826, 112, 25, 0.14, 11],
    [352, 438, 330, 320, 372, 180, 22, 0.13, 15],
  ];
  for (const [x0, y0, x1, y1, x2, y2, w, amp, seed] of wisps) {
    const xMin = Math.min(x0, x1, x2) - w - 8;
    const xMax = Math.max(x0, x1, x2) + w + 8;
    const yMin = Math.min(y0, y1, y2) - w - 8;
    const yMax = Math.max(y0, y1, y2) + w + 8;
    const n = 54;
    const path: Array<[number, number]> = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      path.push([a * x0 + b * x1 + c * x2, a * y0 + b * y1 + c * y2]);
    }
    eachPixel(xMin, yMin, xMax, yMax, (u, v, px, py) => {
      let best = 1e9, bestT = 0;
      for (let i = 0; i < path.length; i++) {
        const d = (u - path[i][0]) ** 2 + (v - path[i][1]) ** 2;
        if (d < best) { best = d; bestT = i / n; }
      }
      const dist = Math.sqrt(best);
      const widow = smoothstep(0.02, 0.14, bestT) * (1 - smoothstep(0.64, 0.99, bestT));
      if (widow <= 0.002) return;
      const width = w * (0.72 + 0.34 * Math.sin(bestT * Math.PI * 1.15 + 0.4));
      const halo = Math.exp(-((dist / width) ** 2) * 2.0);
      const core = Math.exp(-((dist / (width * 0.38)) ** 2) * 2.6);
      const breakup = 0.42 + 0.58 * fbm(u * 0.060 + seed * 3, v * 0.050, 241 + seed, 3);
      const a = amp * (0.45 * halo + 0.70 * core) * widow * breakup;
      if (a <= 0.002) return;
      put(px, py, 0.985, 0.955, 0.895, a);
    });
  }
}
// Post: downsample, depth of field, vignette, warm grade, grain, bytes
function downsample(): Float32Array {
  const out = new Float32Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 3;
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (((y * SS + sy) * RENDER) + (x * SS + sx)) * 3;
          r += frame[i]; g += frame[i + 1]; b += frame[i + 2];
        }
      }
      const n = SS * SS;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}
function applyDepthOfField(buf: Float32Array): void { // Gentle edge blur, leaving the bowl centre sharp.
  const src = buf.slice();
  const weights = [1, 4, 7, 4, 1];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const edge = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y) / SIZE;
      const sharp = smoothstep(0.045, 0.135, edge);
      if (sharp >= 0.999) continue;
      const blurred = 1 - sharp;
      if (blurred <= 0.001) continue;
      const o = (y * SIZE + x) * 3;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let j = -2; j <= 2; j++) {
        const yy = Math.min(SIZE - 1, Math.max(0, y + j));
        for (let i = -2; i <= 2; i++) {
          const xx = Math.min(SIZE - 1, Math.max(0, x + i));
          const w = weights[i + 2] * weights[j + 2];
          const k = (yy * SIZE + xx) * 3;
          r += src[k] * w; g += src[k + 1] * w; b += src[k + 2] * w;
          wsum += w;
        }
      }
      r /= wsum; g /= wsum; b /= wsum;
      buf[o] = mix(r, src[o], sharp);
      buf[o + 1] = mix(g, src[o + 1], sharp);
      buf[o + 2] = mix(b, src[o + 2], sharp);
    }
  }
}
function paintVignette(buf: Float32Array): void { // Soft radial darkening towards the frame corners.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const nx = (x + 0.5) / SIZE - 0.5;
      const ny = (y + 0.5) / SIZE - 0.5;
      const rr = Math.hypot(nx, ny * 1.03) / 0.707;
      const v = 1 - 0.52 * smoothstep(0.40, 1.02, rr);
      const i = (y * SIZE + x) * 3;
      buf[i] *= v; buf[i + 1] *= v; buf[i + 2] *= v;
    }
  }
}
function applyGrade(buf: Float32Array): void { // Slight warm grade and saturation lift.
  for (let i = 0; i < buf.length; i += 3) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const l = (r + g + b) / 3;
    buf[i] = clamp01(r * 1.035 + 0.003 + (r - l) * 0.05);
    buf[i + 1] = clamp01(g * 1.006 + 0.001 + (g - l) * 0.02);
    buf[i + 2] = clamp01(b * 0.962 + (b - l) * 0.01);
  }
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function toRgba(buf: Float32Array): Uint8Array { // Quantise to 8-bit RGBA with ordered dither and fine grain.
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 3;
      const o = (y * SIZE + x) * 4;
      const bd = BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.47;
      const grain = (hash2i(x, y, 991) - 0.5) * 0.55;
      out[o] = clamp01((buf[i] + bd / 255 + grain / 255)) * 255 + 0.5;
      out[o + 1] = clamp01((buf[i + 1] + bd / 255 + grain / 255)) * 255 + 0.5;
      out[o + 2] = clamp01((buf[i + 2] + bd / 255 + grain / 255)) * 255 + 0.5;
      out[o + 3] = 255;
    }
  }
  return out;
}
// PNG: CRC32, adler32, filtered scanlines, deflate
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number { // CRC32 over PNG chunk type and data.
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes: Uint8Array): number { // Simple adler32 checksum for the verification report.
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer { // Assemble one length-prefixed, CRC-checked PNG chunk.
  const typed = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  Buffer.from(data).copy(out, 8);
  const crcInput = Buffer.concat([typed, Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}
function paeth(a: number, b: number, c: number): number { // Paeth predictor used by PNG filtering.
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function filterScanlines(rgba: Uint8Array): Buffer { // Choose the cheapest PNG filter for each scanline.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < SIZE; y++) {
    const row = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const v = rgba[row + x];
      const a = x >= 4 ? rgba[row + x - 4] : 0;
      const b = y > 0 ? rgba[prev + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[prev + x - 4] : 0;
      cand[0][x] = v;
      cand[1][x] = (v - a) & 0xff;
      cand[2][x] = (v - b) & 0xff;
      cand[3][x] = (v - ((a + b) >> 1)) & 0xff;
      cand[4][x] = (v - paeth(a, b, c)) & 0xff;
    }
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = cand[f][x];
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (stride + 1)] = best;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = cand[best][x];
  }
  return raw;
}
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer { // Encode RGBA bytes as a filtered, deflated PNG.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = filterScanlines(rgba);
  const compressed = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
function finishFrame(names: string[]): { rgba: Uint8Array; png: Buffer } { // Downsample, post-process, encode and write.
  const buf = downsample();
  applyDepthOfField(buf);
  paintVignette(buf);
  applyGrade(buf);
  const rgba = toRgba(buf);
  const png = encodePng(rgba, SIZE, SIZE);
  for (const name of names) writeFileSync(join(OUT_DIR, name), png);
  return { rgba, png };
}
function pixelReport(rgba: Uint8Array, label: string, x: number, y: number): void { // Print one sampled RGB value with its coordinate.
  const i = (y * SIZE + x) * 4;
  const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  console.log(`${label.padEnd(13)} (${x}, ${y})  rgb(${r}, ${g}, ${b})  ${hex}`);
}
// Paint the scene in stages and write the review frames
mkdirSync(OUT_DIR, { recursive: true });
buildGarnishes();
paintTabletop();
paintBowl();
paintBroth();
finishFrame(['stage2.png', 'entry.png']);
paintNoodles();
paintEgg(330, 300, 84, 66, -0.34, 336, 302, 38, 33, 301);
paintEgg(410, 372, 76, 60, 0.26, 408, 376, 33, 29, 317);
paintChashu();
finishFrame(['stage4.png', 'entry.png']);
paintNori();
paintScallions();
paintSesame();
paintChili();
paintSpoon();
paintChopsticks();
paintSteam();
const final = finishFrame(['stage6.png', 'entry.png']);
console.log(`ramen entry: ${SIZE}x${SIZE}, entry.png ${final.png.length} bytes, adler32 ${adler32(final.rgba).toString(16)}`);
pixelReport(final.rgba, 'bowl rim', 512, 92);
pixelReport(final.rgba, 'broth centre', 500, 450);
pixelReport(final.rgba, 'egg white', 284, 300);
pixelReport(final.rgba, 'egg yolk', 336, 302);
pixelReport(final.rgba, 'chashu', 300, 630);
pixelReport(final.rgba, 'steam', 443, 235);
