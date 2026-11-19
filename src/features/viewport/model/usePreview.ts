import { watch, onBeforeUnmount, type Ref, ref } from "vue";
import type { QualityTier, StudioDocument } from "../../../shared/types";
import { renderPreview, PREVIEW_SIZE } from "../../projection";

type Phase = "idle" | "interactive" | "quality";

export function usePreview(
  doc: StudioDocument,
  canvas: Ref<HTMLCanvasElement | undefined>,
) {
  const rendering = ref(false);
  const phase = ref<Phase>("idle");
  let frame = 0;
  let settleTimer = 0;
  /** 单调递增的取景世代号：任何异步阶段只在仍是最新世代时落盘 */
  let generation = 0;

  function snapshot(tier: QualityTier) {
    return {
      asset: doc.asset!,
      projection: { ...doc.projection },
      edge: { ...doc.edge },
      tier,
    };
  }

  function clearTimers() {
    cancelAnimationFrame(frame);
    clearTimeout(settleTimer);
  }

  watch(
    () => [
      canvas.value,
      doc.asset,
      JSON.stringify(doc.projection),
      JSON.stringify(doc.edge),
    ],
    () => {
      if (!canvas.value || !doc.asset) return;
      clearTimers();
      const gen = ++generation;
      rendering.value = true;

      // 第一阶段：下一帧即以交互档低分辨率出快速结果
      frame = requestAnimationFrame(() => {
        if (gen !== generation || !canvas.value || !doc.asset) return;
        phase.value = "interactive";
        renderPreview(
          canvas.value,
          snapshot("interactive"),
          PREVIEW_SIZE.interactive,
        );

        // 第二阶段：停止操作 180ms 后自动补高质量；期间新取景会作废本世代
        settleTimer = window.setTimeout(() => {
          if (gen !== generation || !canvas.value || !doc.asset) return;
          phase.value = "quality";
          // 分帧让出主线程，渲染本身在单帧内完成（600² 规模可接受）
          frame = requestAnimationFrame(() => {
            if (gen !== generation || !canvas.value || !doc.asset) return;
            renderPreview(
              canvas.value,
              snapshot("quality"),
              PREVIEW_SIZE.quality,
            );
            if (gen === generation) {
              phase.value = "idle";
              rendering.value = false;
            }
          });
        }, 180);
      });
    },
    { immediate: true, flush: "post" },
  );

  onBeforeUnmount(() => {
    generation++;
    clearTimers();
  });

  return { rendering, phase };
}
