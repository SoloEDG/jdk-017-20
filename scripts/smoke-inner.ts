import assert from "node:assert/strict";
import { buildPyramid } from "../src/features/projection/lib/mip.ts";
import { renderRows } from "../src/features/projection/lib/render.ts";
import { defaultProjection, defaultEdge } from "../src/shared/defaults.ts";
import type { Asset, RenderSnapshot } from "../src/shared/types.ts";

function asset(
  name: string,
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number, number],
): Asset & { name: string } {
  const data = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      data.data[i] = r;
      data.data[i + 1] = g;
      data.data[i + 2] = b;
      data.data[i + 3] = a;
    }
  return {
    id: name,
    name,
    width: w,
    height: h,
    data,
    mip: buildPyramid(data),
    thumbnail: "",
  };
}

export function buildCases() {
  return [
    // 细网格：摩尔纹压力样本
    asset("grid", 256, 128, (x, y) =>
      x % 6 < 1 || y % 6 < 1
        ? [230, 40, 40, 255]
        : [30, 60, 160, 255],
    ),
    // 斜线：各向异性压力样本
    asset("diagonal", 256, 128, (x, y) =>
      (x + y * 2) % 12 < 6 ? [245, 245, 245, 255] : [15, 15, 20, 255],
    ),
    // 透明边缘：右半透明，边界为纯红，检查是否被透明黑拉暗
    asset(
      "transparent-edge",
      256,
      128,
      (x) => (x < 128 ? [220, 30, 30, 255] : [0, 0, 0, 0]),
    ),
  ];
}

export function renderCase(
  source: Asset,
  size: number,
  tier: "interactive" | "quality",
) {
  const image = new ImageData(size, size);
  const snapshot: RenderSnapshot = {
    asset: source,
    projection: { ...defaultProjection(), zoom: 0.55, yaw: 25, pitch: 8 },
    edge: { ...defaultEdge(), seam: 0, feather: 0, transparent: true },
    tier,
  };
  renderRows(snapshot, image, 0, size, 0, size);
  return image;
}

/** 关键不变量，全部在合成数据上可重复验证 */
export function assertInvariants(cases: Asset[]) {
  const transparent = cases.find((c) => c.name === "transparent-edge")!;

  // 1) 透明边缘：半透明像素的未预乘颜色不得发黑（红通道保持高饱和）
  const img = renderCase(transparent, 256, "quality");
  let checked = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3];
    if (a > 40 && a < 230) {
      assert.ok(
        img.data[i] > 150,
        `半透明边缘红通道被透明黑污染：${img.data[i]}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, "应存在半透明过渡像素");

  // 2) 接缝连续：同方向下 u≈0 与 u≈1 的过滤结果一致（环形 wrap）
  const grid = cases.find((c) => c.name === "grid")!;
  const snap = (tier: "interactive" | "quality"): RenderSnapshot => ({
    asset: grid,
    projection: { ...defaultProjection(), zoom: 0.5 },
    edge: { ...defaultEdge(), seam: 0, transparent: true },
    tier,
  });
  for (const tier of ["interactive", "quality"] as const) {
    const a = new ImageData(512, 1);
    const b = new ImageData(512, 1);
    // yaw 偏移 360° 后投影位置应完全相同
    renderRows(
      { ...snap(tier), projection: { ...snap(tier).projection, yaw: 0 } },
      a,
      0,
      1,
      0,
      512,
    );
    renderRows(
      { ...snap(tier), projection: { ...snap(tier).projection, yaw: 360 } },
      b,
      0,
      1,
      0,
      512,
    );
    for (let i = 0; i < a.data.length; i++)
      assert.equal(a.data[i], b.data[i], `yaw 0/360 应逐通道相等（${tier}）`);
  }

  // 3) 两档预算差异：质量档在网格缩小时输出方差更低（摩尔纹更少）
  const q = renderCase(grid, 256, "quality");
  const it = renderCase(grid, 256, "interactive");
  const variance = (img: ImageData) => {
    const vals: number[] = [];
    for (let i = 0; i < img.data.length; i += 4)
      if (img.data[i + 3] > 0) vals.push(img.data[i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  };
  assert.ok(
    variance(q) < variance(it),
    `质量档方差 ${variance(q)} 应低于交互档 ${variance(it)}`,
  );
}
