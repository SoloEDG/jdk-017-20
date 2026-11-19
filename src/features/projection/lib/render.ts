import type {
  QualityTier,
  RenderSnapshot,
} from "../../../shared/types";
import { sample, type SampleTrace } from "./sampling";
import { applyEdge } from "../../edge/lib/composite";

export function renderRows(
  s: RenderSnapshot,
  image: ImageData,
  start: number,
  end: number,
  offset = 0,
  fullHeight = image.height,
  trace?: SampleTrace,
) {
  for (let y = start; y < end; y++)
    for (let x = 0; x < image.width; x++) {
      const rgba = sample(
        s.asset,
        x + 0.5,
        y + 0.5,
        image.width,
        fullHeight,
        s.projection,
        s.tier,
        s.edge.seam,
        trace,
      );
      const result = applyEdge(
        rgba,
        x + 0.5,
        y + 0.5,
        image.width,
        fullHeight,
        s.edge,
      );
      const at = ((y - offset) * image.width + x) * 4;
      for (let c = 0; c < 4; c++) image.data[at + c] = result[c];
    }
}

/** 同步整帧渲染（预览尺寸使用），可返回预算核验轨迹 */
export function renderPreview(
  canvas: HTMLCanvasElement,
  s: RenderSnapshot,
  size: number,
  trace?: SampleTrace,
) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  renderRows(s, image, 0, size, 0, size, trace);
  ctx.putImageData(image, 0, 0);
}

/** 两档对应的预览分辨率：拖动期低分辨率快速出图，停下后全尺寸精修 */
export const PREVIEW_SIZE: Record<QualityTier, number> = {
  interactive: 320,
  quality: 600,
};
