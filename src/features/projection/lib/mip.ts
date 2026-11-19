import type { MipPyramid } from "../../../shared/types";

/**
 * 从原始 ImageData 构建预乘 alpha 的 mip 金字塔。
 *
 * 关键约定：
 * - RGB 一律预乘 alpha（a=0 的纹素贡献为 0，权重由 alpha 决定），
 *   因此透明黑不会污染有色边缘，未预乘在最终输出时还原。
 * - u（全景经度方向）按周期循环，降采样跨接缝时取对侧纹素，绝不裁切。
 * - v（纬度方向）钳制到边界并复制边界纹素，极点按等纬度边界处理。
 */
export function buildPyramid(source: ImageData): MipPyramid {
  const width = source.width;
  const height = source.height;
  const levels: Uint8ClampedArray[] = [];
  const levelWidth: number[] = [];
  const levelHeight: number[] = [];

  // level 0：预乘拷贝
  const base = new Uint8ClampedArray(source.data.length);
  for (let i = 0; i < width * height; i++) {
    const a = source.data[i * 4 + 3] / 255;
    base[i * 4] = source.data[i * 4] * a;
    base[i * 4 + 1] = source.data[i * 4 + 1] * a;
    base[i * 4 + 2] = source.data[i * 4 + 2] * a;
    base[i * 4 + 3] = source.data[i * 4 + 3];
  }
  levels.push(base);
  levelWidth.push(width);
  levelHeight.push(height);

  let curW = width;
  let curH = height;
  let cur = base;
  while (curW > 1 || curH > 1) {
    const nextW = Math.max(1, curW >> 1);
    const nextH = Math.max(1, curH >> 1);
    const next = new Uint8ClampedArray(nextW * nextH * 4);
    for (let y = 0; y < nextH; y++) {
      // 源 2×2 块；v 方向钳制（极点复制边界）
      const sy0 = Math.min(y * 2, curH - 1);
      const sy1 = Math.min(y * 2 + 1, curH - 1);
      for (let x = 0; x < nextW; x++) {
        // u 方向循环：跨接缝自然绕回
        const sx0 = (x * 2) % curW;
        const sx1 = (x * 2 + 1) % curW;
        const idx = [
          sy0 * curW + sx0,
          sy0 * curW + sx1,
          sy1 * curW + sx0,
          sy1 * curW + sx1,
        ];
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (const id of idx) {
          r += cur[id * 4];
          g += cur[id * 4 + 1];
          b += cur[id * 4 + 2];
          a += cur[id * 4 + 3];
        }
        const o = (y * nextW + x) * 4;
        next[o] = r / 4;
        next[o + 1] = g / 4;
        next[o + 2] = b / 4;
        next[o + 3] = a / 4;
      }
    }
    levels.push(next);
    levelWidth.push(nextW);
    levelHeight.push(nextH);
    cur = next;
    curW = nextW;
    curH = nextH;
  }

  return { width, height, levels, levelWidth, levelHeight };
}

/** 读取某层纹素（已预乘），u 循环、v 钳制 */
export function texel(
  mip: MipPyramid,
  level: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const w = mip.levelWidth[level];
  const h = mip.levelHeight[level];
  const cx = ((x % w) + w) % w;
  const cy = Math.max(0, Math.min(h - 1, y));
  const i = (cy * w + cx) * 4;
  const d = mip.levels[level];
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}
