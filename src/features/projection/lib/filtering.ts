import type {
  Asset,
  MipPyramid,
  Projection,
  QualityTier,
} from "../../../shared/types";
import { clamp, wrap } from "../../../shared/math";
import { projectPoint } from "./coordinates";

/**
 * 单像素在全景 uv 空间的局部投影足迹。
 * 导数由 ±1 屏幕像素的有限差分得到，天然随输出分辨率缩放，
 * 因此同一方向在任何输出尺寸下景物位置一致，只有过滤宽度变化。
 */
export interface Footprint {
  u: number;
  v: number;
  duDx: number;
  duDy: number;
  dvDx: number;
  dvDy: number;
}

/**
 * 两档预算（单位：每像素双线性求值次数，可在测试中核验）。
 * interactive：各向同性 + 三线性，最多 2 次（相邻两条 mip 各一次）。
 * quality：最长 8 个各向异性探针 × 两条 mip，最多 16 次。
 */
export const TIER_BUDGET = {
  interactive: { maxAnisotropy: 1, maxBilinearPerPixel: 2 },
  quality: { maxAnisotropy: 8, maxBilinearPerPixel: 16 },
} as const;

/** 把经度差规整到 [-0.5, 0.5)，使跨接缝的差分不被误判成大跳变 */
function wrapDelta(d: number) {
  let r = d;
  while (r >= 0.5) r -= 1;
  while (r < -0.5) r += 1;
  return r;
}

export function footprintAt(
  x: number,
  y: number,
  width: number,
  height: number,
  projection: Projection,
): Footprint {
  const c = projectPoint(x, y, width, height, projection);
  const x1 = projectPoint(x + 1, y, width, height, projection);
  const x0 = projectPoint(x - 1, y, width, height, projection);
  const y1 = projectPoint(x, y + 1, width, height, projection);
  const y0 = projectPoint(x, y - 1, width, height, projection);
  return {
    u: c.u,
    v: c.v,
    // 中央差分（步长 2 像素），接缝处绕回，极点处由投影自身的 clamp 收敛
    duDx: wrapDelta(x1.u - x0.u) / 2,
    duDy: wrapDelta(y1.u - y0.u) / 2,
    dvDx: (x1.v - x0.v) / 2,
    dvDy: (y1.v - y0.v) / 2,
  };
}

/** mip 层上的双线性读取（预乘空间）；u 循环、v 钳制 */
function bilinearLevel(
  mip: MipPyramid,
  level: number,
  u: number,
  v: number,
): [number, number, number, number] {
  const w = mip.levelWidth[level];
  const h = mip.levelHeight[level];
  const d = mip.levels[level];
  const x = wrap(u) * w - 0.5;
  const y = clamp(v, 0, 1) * h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const x0w = ((x0 % w) + w) % w;
  const x1w = (x0w + 1) % w;
  const i00 = (y0 * w + x0w) * 4;
  const i01 = (y0 * w + x1w) * 4;
  const i10 = (y1 * w + x0w) * 4;
  const i11 = (y1 * w + x1w) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w01 = fx * (1 - fy);
  const w10 = (1 - fx) * fy;
  const w11 = fx * fy;
  return [
    d[i00] * w00 + d[i01] * w01 + d[i10] * w10 + d[i11] * w11,
    d[i00 + 1] * w00 + d[i01 + 1] * w01 + d[i10 + 1] * w10 + d[i11 + 1] * w11,
    d[i00 + 2] * w00 + d[i01 + 2] * w01 + d[i10 + 2] * w10 + d[i11 + 2] * w11,
    d[i00 + 3] * w00 + d[i01 + 3] * w01 + d[i10 + 3] * w10 + d[i11 + 3] * w11,
  ];
}

/** 小数层号的三线性读取，返回预乘 RGBA；整数层号只求值一次 */
function trilinear(mip: MipPyramid, u: number, v: number, level: number) {
  const maxLevel = mip.levels.length - 1;
  if (level >= maxLevel) return bilinearLevel(mip, maxLevel, u, v);
  const lo = Math.floor(level);
  const t = level - lo;
  if (t === 0) return bilinearLevel(mip, lo, u, v);
  const hi = lo + 1;
  const a = bilinearLevel(mip, lo, u, v);
  const b = bilinearLevel(mip, hi, u, v);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ] as [number, number, number, number];
}

export interface FilterResult {
  rgba: [number, number, number, number];
  /** 本次实际触发的双线性求值次数，用于预算核验 */
  evals: number;
}

/**
 * 依据局部足迹的 EWA 过滤：
 * - 缩小时沿足迹长轴布置各向异性探针，短轴长度决定 mip 层（预过滤）；
 * - 放大时短轴不足 1 纹素，层号钳到 0 且单探针，退化为普通双线性，保留边缘；
 * - 全程在预乘 alpha 空间平均，透明纹素零贡献，接缝绕回、极点钳制。
 */
export function filterFootprint(
  asset: Asset,
  fp: Footprint,
  tier: QualityTier,
): FilterResult {
  const mip = asset.mip;
  const W = mip.width;
  const H = mip.height;
  const maxLevel = mip.levels.length - 1;
  const budget = TIER_BUDGET[tier];

  // 纹素空间的足迹二次型 G = JᵀJ
  const A = (fp.duDx * fp.duDx + fp.duDy * fp.duDy) * W * W;
  const B =
    (fp.duDx * fp.dvDx + fp.duDy * fp.dvDy) * W * H;
  const C = (fp.dvDx * fp.dvDx + fp.dvDy * fp.dvDy) * H * H;

  const eps = 1e-12;
  const disc = Math.sqrt(Math.max(0, ((A - C) / 2) ** 2 + B * B));
  const lambdaMajor = (A + C) / 2 + disc;
  const lambdaMinor = Math.max(eps, (A + C) / 2 - disc);
  const sigmaMajor = Math.sqrt(lambdaMajor);
  const sigmaMinor = Math.sqrt(lambdaMinor);

  // 短轴 1σ 半径达到 1 纹素时开始进入 mip；放大场景钳制在第 0 层
  const level = clamp(Math.log2(sigmaMinor * 2), 0, maxLevel);

  // 各向异性程度，放大时以 0.5 纹素为下限避免探针爆炸
  const ratio = sigmaMajor / Math.max(sigmaMinor, 0.5);
  const taps =
    budget.maxAnisotropy === 1
      ? 1
      : Math.min(budget.maxAnisotropy, Math.max(1, Math.ceil(ratio)));

  // 长轴特征向量方向（纹素空间）
  const phi = 0.5 * Math.atan2(2 * B, A - C || eps);
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);

  let R = 0;
  let G = 0;
  let Bc = 0;
  let Al = 0;
  for (let k = 0; k < taps; k++) {
    // 探针沿长轴在 ±2σ 内等距分布，位置完全确定，无随机采样
    const t = taps === 1 ? 0 : (k / (taps - 1)) * 4 - 2;
    const tTexel = t * sigmaMajor;
    const uu = fp.u + (cosP * tTexel) / W;
    const vv = clamp(fp.v + (sinP * tTexel) / H, 0, 1);
    const [r, g, b, a] = trilinear(mip, uu, vv, level);
    R += r;
    G += g;
    Bc += b;
    Al += a;
  }
  R /= taps;
  G /= taps;
  Bc /= taps;
  Al /= taps;

  // 预乘 → 未预乘；全透明时输出透明黑而非 NaN
  const alpha = Al / 255;
  const rgba: [number, number, number, number] =
    alpha > 1e-4
      ? [R / alpha, G / alpha, Bc / alpha, Al]
      : [0, 0, 0, 0];

  // 与 trilinear 的实际求值次数保持一致：整数层号或顶层只评一次
  const perTap = level >= maxLevel || Number.isInteger(level) ? 1 : 2;
  return { rgba, evals: taps * perTap };
}
