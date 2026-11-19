export interface Projection {
  mode: "planet" | "tunnel";
  zoom: number;
  yaw: number;
  pitch: number;
  roll: number;
}
export interface Edge {
  seam: number;
  feather: number;
  background: string;
  transparent: boolean;
}
/**
 * 预乘 alpha 的 mip 金字塔。
 * levels[0] 为原始分辨率（预乘后），每层宽高各减半，u 方向循环、v 方向钳制。
 * 生成时在循环方向做环形 2×2 盒式降采样，绝不把接缝当裁切。
 */
export interface MipPyramid {
  width: number;
  height: number;
  levels: Uint8ClampedArray[];
  levelWidth: number[];
  levelHeight: number[];
}
export interface Asset {
  id: string;
  name: string;
  width: number;
  height: number;
  /** 原始未预乘像素，保留给既有流程与调试 */
  data: ImageData;
  /** 预乘 alpha mip 金字塔，过滤的唯一采样来源 */
  mip: MipPyramid;
  thumbnail: string;
}
/** 渲染质量档位：交互优先 vs 成品质量 */
export type QualityTier = "interactive" | "quality";
export interface StudioDocument {
  asset: Asset | null;
  projection: Projection;
  edge: Edge;
}
export interface ExportSettings {
  size: number;
  format: "png" | "jpeg";
  quality: number;
  tier: QualityTier;
}
export interface RenderSnapshot {
  asset: Asset;
  projection: Projection;
  edge: Edge;
  tier: QualityTier;
}
