import type { Asset, Projection, QualityTier } from "../../../shared/types";
import { wrap, smoothstep } from "../../../shared/math";
import { filterFootprint, footprintAt } from "./filtering";

export interface SampleTrace {
  /** 本次采样的双线性求值次数，供预算测试读取 */
  evals: number;
}

/**
 * 依据局部投影足迹的自适应过滤入口。
 * seam 仍保留既有的经度中线融合语义，但作用在过滤后的未预乘颜色上，
 * 且只在狭窄接缝带内触发一次额外过滤，不影响普通像素预算。
 */
export function sample(
  asset: Asset,
  x: number,
  y: number,
  width: number,
  height: number,
  projection: Projection,
  tier: QualityTier,
  seam: number,
  trace?: SampleTrace,
): number[] {
  const fp = footprintAt(x, y, width, height, projection);
  const primary = filterFootprint(asset, fp, tier);
  if (trace) trace.evals += primary.evals;
  let rgba = primary.rgba;

  if (seam > 0) {
    const d = Math.min(fp.u, 1 - fp.u);
    if (d < seam) {
      const mirrored = { ...fp, u: wrap(1 - fp.u) };
      const opposite = filterFootprint(asset, mirrored, tier);
      if (trace) trace.evals += opposite.evals;
      const mix = (1 - smoothstep(0, seam, d)) * 0.5;
      rgba = rgba.map((n, i) => n * (1 - mix) + opposite.rgba[i] * mix) as [
        number,
        number,
        number,
        number,
      ];
    }
  }
  return [...rgba];
}
