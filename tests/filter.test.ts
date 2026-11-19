import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPyramid } from "../src/features/projection/lib/mip.ts";
import {
  filterFootprint,
  footprintAt,
  TIER_BUDGET,
} from "../src/features/projection/lib/filtering.ts";
import { sample } from "../src/features/projection/lib/sampling.ts";
import { projectPoint } from "../src/features/projection/lib/coordinates.ts";
import { defaultProjection } from "../src/shared/defaults.ts";
import type { Asset, Projection } from "../src/shared/types.ts";

/* ---------- 合成测试资产 ---------- */

// Node 22 不提供全局 ImageData，这里给出仅含 width/height/data 的最小实现
class ImageDataShim {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
const ImageDataImpl =
  (globalThis as { ImageData?: typeof ImageDataShim }).ImageData ??
  ImageDataShim;

function makeAsset(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number, number],
): Asset {
  const data = new ImageDataImpl(w, h) as ImageData;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      data.data[i] = r;
      data.data[i + 1] = g;
      data.data[i + 2] = b;
      data.data[i + 3] = a;
    }
  const mip = buildPyramid(data);
  return {
    id: "test",
    name: "synthetic",
    width: w,
    height: h,
    data,
    mip,
    thumbnail: "",
  };
}

const opaque = (r: number, g: number, b: number): [number, number, number, number] => [
  r,
  g,
  b,
  255,
];
const red = opaque(220, 30, 30);
const green = opaque(30, 200, 60);
const blue = opaque(40, 80, 220);

/* ---------- 1. 全景接缝：跨 u=0/1 不能出现裁切黑边 ---------- */

test("接缝处跨边界的过滤与对侧连续，无黑色裁切", () => {
  const w = 36;
  const h = 18;
  // 左半红、右半蓝，接缝恰好落在 u=0/1（同色红的对侧）
  const asset = makeAsset(w, h, (x, y) =>
    y < 2 || y > h - 3 ? green : x < w / 2 ? red : blue,
  );
  const fp = footprintAt(w / 2, h / 2, w, h, {
    ...defaultProjection(),
    yaw: 0,
  });
  // 直接构造一个横跨接缝的足迹（中心 u≈0.01，长轴沿 u 方向覆盖 ±6 纹素）
  const seamFp = {
    u: 0.01,
    v: 0.5,
    duDx: 6 / w,
    duDy: 0,
    dvDx: 0,
    dvDy: 1 / h,
  };
  const out = filterFootprint(asset, seamFp, "quality");
  const [r, g, b] = out.rgba;
  // 接缝两侧都是红色（x=0 附近红，绕回处 x≈w-1 是蓝，覆盖比例如实混合），
  // 但绝不能出现透明黑（a 必须满，RGB 不能整体塌成 0）
  assert.equal(out.rgba[3], 255, "接缝处 alpha 不应丢失");
  assert.ok(r + g + b > 100, "接缝处不能被黑色污染");
  // 未使用变量占位，确保 footprintAt 可用
  assert.ok(fp.u >= 0 && fp.u < 1);
});

/* ---------- 2. 透明黑不参与有色边缘平均（预乘正确性） ---------- */

test("透明纹素零权重，红-透明边界不会发黑", () => {
  const asset = makeAsset(32, 32, (x) =>
    x < 16 ? [200, 40, 40, 255] : [0, 0, 0, 0],
  );
  // 边界正中的大足迹，一半不透明红、一半全透明
  const out = filterFootprint(
    asset,
    { u: 0.5, v: 0.5, duDx: 8 / 32, duDy: 0, dvDx: 0, dvDy: 4 / 32 },
    "quality",
  );
  const [r, g, b, a] = out.rgba;
  assert.ok(a > 0 && a < 255, "边界 alpha 应为中间值");
  // 还原未预乘后，颜色应接近原始红，而不是被透明黑拉暗
  assert.ok(r > 150, `红通道应保持鲜艳，实际 ${r}`);
  assert.ok(g < 90 && b < 90, "绿蓝通道不应被黑像素抬高");
});

test("全透明区域输出透明黑且无 NaN", () => {
  const asset = makeAsset(16, 16, () => [0, 0, 0, 0]);
  const out = filterFootprint(
    asset,
    { u: 0.5, v: 0.5, duDx: 0.2, duDy: 0.1, dvDx: 0.1, dvDy: 0.2 },
    "quality",
  );
  assert.deepEqual(Array.from(out.rgba), [0, 0, 0, 0]);
});

/* ---------- 3. 细网格缩小：质量档摩尔纹能量低于交互档 ---------- */

function gridAsset(cols: number, rows: number, w = 256, h = 256) {
  return makeAsset(w, h, (x, y) =>
    x % cols < 1 || y % rows < 1 ? red : blue,
  );
}

test("细网格缩小时质量档比交互档更平滑（摩尔纹能量更低）", () => {
  const asset = gridAsset(4, 4);
  const p: Projection = { ...defaultProjection(), zoom: 0.4 };
  const samples: Record<string, number[]> = { interactive: [], quality: [] };
  for (const tier of ["interactive", "quality"] as const) {
    for (let y = 40; y < 200; y += 8)
      for (let x = 40; x < 200; x += 8) {
        const rgba = sample(asset, x, y, 256, 256, p, tier, 0);
        samples[tier].push(rgba[0]);
      }
  }
  const variance = (arr: number[]) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  };
  const vInt = variance(samples.interactive);
  const vQ = variance(samples.quality);
  assert.ok(
    vQ < vInt,
    `质量档方差 ${vQ.toFixed(1)} 应低于交互档 ${vInt.toFixed(1)}`,
  );
});

/* ---------- 4. 各向异性：斜线长足迹下质量档保留方向细节 ---------- */

test("斜线图案在强各向异性足迹下质量档优于各向同性", () => {
  // 45° 斜条纹
  const asset = makeAsset(128, 128, (x, y) =>
    (x + y) % 8 < 4 ? opaque(255, 255, 255) : opaque(0, 0, 0),
  );
  // 长轴沿 u、宽 1 纹素的足迹（对应斜看网格）
  const fp = {
    u: 0.5,
    v: 0.5,
    duDx: 20 / 128,
    duDy: 0,
    dvDx: 0,
    dvDy: 1 / 128,
  };
  const q = filterFootprint(asset, fp, "quality");
  const i = filterFootprint(asset, fp, "interactive");
  // 沿条纹正交方向的长轴会穿过多条黑白条纹，质量档多次探针平均到接近中灰
  assert.ok(
    Math.abs(q.rgba[0] - 128) < 45,
    `质量档应平均到中灰附近，实际 ${q.rgba[0]}`,
  );
  // 交互档各向同性、单点采样不沿长轴积分，结果应与质量档有可观察差异
  assert.ok(
    Math.abs(q.rgba[0] - i.rgba[0]) > 15,
    `两档应存在差异，质量 ${q.rgba[0]} / 交互 ${i.rgba[0]}`,
  );
});

/* ---------- 5. 放大时保留边缘（层号钳 0，结果等同锐利双线性） ---------- */

test("放大场景过滤退化为第 0 层双线性，边缘不被糊掉", () => {
  const asset = makeAsset(32, 32, (x) => (x < 16 ? red : green));
  const tiny = filterFootprint(
    asset,
    { u: 0.5, v: 0.5, duDx: 0.01, duDy: 0, dvDx: 0, dvDy: 0.01 },
    "quality",
  );
  // 足迹不足 1 纹素：跨边界 0.5 处应得到红/绿各半的锐利过渡
  assert.ok(tiny.rgba[0] > 80 && tiny.rgba[1] > 60, "过渡带颜色为两侧混合");
  assert.equal(tiny.evals, 1, "单探针且整数第 0 层只求值一次");
});

/* ---------- 6. 相同方向不同输出尺寸：景物位置一致 ---------- */

test("同一取景在 256/512/1024 输出下标志物方位一致", () => {
  // 8 个 4×4 黄色标志块沿经度环带分布，保证任意 yaw 下都有标志落入星球盘面
  const asset = makeAsset(128, 64, (x, y) => {
    const marker = [0, 16, 32, 48, 64, 80, 96, 112].some(
      (mx) =>
        x >= mx && x < mx + 4 && ((y >= 20 && y < 24) || (y >= 40 && y < 44)),
    );
    return marker ? opaque(255, 255, 0) : opaque(20, 24, 30);
  });
  const p: Projection = { ...defaultProjection(), yaw: 40, pitch: 12 };
  function centroid(size: number) {
    let sx = 0;
    let sy = 0;
    let wsum = 0;
    for (let y = 0; y < size; y += 2)
      for (let x = 0; x < size; x += 2) {
        const rgba = sample(asset, x + 0.5, y + 0.5, size, size, p, "quality", 0);
        // 仅黄色标志给出正权重，深色背景被钳为 0
        const w = Math.max(0, rgba[0] + rgba[1] - rgba[2] - 120);
        sx += x * w;
        sy += y * w;
        wsum += w;
      }
    assert.ok(wsum > 0, "标志物应可被检测到");
    return { nx: sx / wsum / size, ny: sy / wsum / size };
  }
  const c256 = centroid(256);
  const c512 = centroid(512);
  const c1024 = centroid(1024);
  for (const [name, c] of [
    ["512", c512],
    ["1024", c1024],
  ] as const) {
    assert.ok(
      Math.abs(c.nx - c256.nx) < 0.02 && Math.abs(c.ny - c256.ny) < 0.02,
      `${name} 下标志物位置 ${JSON.stringify(c)} 偏离 256 基准 ${JSON.stringify(c256)}`,
    );
  }
});

test("projectPoint 本身与输出分辨率无关（归一化坐标一致）", () => {
  const p = defaultProjection();
  const a = projectPoint(33.5, 77.5, 100, 100, p);
  const b = projectPoint(167.5, 387.5, 500, 500, p);
  assert.ok(Math.abs(a.u - b.u) < 1e-9);
  assert.ok(Math.abs(a.v - b.v) < 1e-9);
});

/* ---------- 7. 采样预算可验证：两档硬上限 ---------- */

test("每像素双线性求值次数不超过档位预算", () => {
  const asset = gridAsset(2, 2, 64, 64);
  let maxInteractive = 0;
  let maxQuality = 0;
  for (const zoom of [0.3, 0.6, 1, 2, 3]) {
    const p = { ...defaultProjection(), zoom };
    for (let y = 8; y < 64; y += 7)
      for (let x = 8; x < 64; x += 7) {
        const tI = { evals: 0 };
        sample(asset, x, y, 64, 64, p, "interactive", 0, tI);
        maxInteractive = Math.max(maxInteractive, tI.evals);
        const tQ = { evals: 0 };
        sample(asset, x, y, 64, 64, p, "quality", 0, tQ);
        maxQuality = Math.max(maxQuality, tQ.evals);
      }
  }
  assert.ok(maxInteractive <= TIER_BUDGET.interactive.maxBilinearPerPixel);
  assert.ok(maxQuality <= TIER_BUDGET.quality.maxBilinearPerPixel);
  // 极端缩小时质量档确实动用了多探针，证明各向异性路径被触发
  assert.ok(maxQuality > TIER_BUDGET.interactive.maxBilinearPerPixel);
});

/* ---------- 8. 极点：v 方向钳制不产生 NaN/越界 ---------- */

test("极点附近采样稳定且有限", () => {
  const asset = makeAsset(64, 32, () => opaque(120, 180, 90));
  for (const pitch of [-85, 0, 85]) {
    const p = { ...defaultProjection(), pitch };
    for (let y = 0; y < 64; y += 4)
      for (let x = 0; x < 64; x += 4) {
        const rgba = sample(asset, x, y, 64, 64, p, "quality", 0);
        for (const c of rgba) assert.ok(Number.isFinite(c));
      }
  }
});

/* ---------- 9. 金字塔：层级尺寸与环形降采样 ---------- */

test("mip 金字塔层级尺寸正确且顶层为 1×1", () => {
  const asset = makeAsset(40, 20, () => opaque(10, 20, 30));
  const { levels, levelWidth, levelHeight } = asset.mip;
  assert.deepEqual(levelWidth, [40, 20, 10, 5, 2, 1]);
  assert.deepEqual(levelHeight, [20, 10, 5, 2, 1, 1]);
  assert.equal(levels.length, 6);
  // 不透明资产所有层 alpha 恒为 255
  for (const lvl of levels)
    for (let i = 3; i < lvl.length; i += 4) assert.equal(lvl[i], 255);
});
