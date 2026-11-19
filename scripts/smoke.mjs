// 端到端冒烟：用斜线、细网格、透明边缘三类合成全景，走与应用完全相同的
// renderRows 管线，分别以两档质量渲染并写出 PAM（RGBA）图像到 test-output/。
// 另对关键不变量做断言：透明边缘无黑色镶边、接缝连续、跨尺寸位置一致。
import { build } from "esbuild";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

class ImageDataShim {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
globalThis.ImageData = ImageDataShim;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "orbit-smoke-"));
const bundle = join(outDir, "smoke.mjs");
await build({
  entryPoints: [join(root, "scripts", "smoke-inner.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: bundle,
});

const mod = await import(bundle);
const dumpDir = join(root, "test-output");
mkdirSync(dumpDir, { recursive: true });

function writePAM(path, image) {
  const header = Buffer.from(
    `P7\nWIDTH ${image.width}\nHEIGHT ${image.height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
  );
  writeFileSync(path, Buffer.concat([header, Buffer.from(image.data)]));
}

const cases = mod.buildCases();
for (const c of cases) {
  for (const size of [256, 512]) {
    for (const tier of ["interactive", "quality"]) {
      const image = mod.renderCase(c, size, tier);
      writePAM(join(dumpDir, `${c.name}-${size}-${tier}.pam`), image);
    }
  }
}
mod.assertInvariants(cases);
rmSync(outDir, { recursive: true, force: true });
console.log(`PAM 样本已写入 ${dumpDir}（可用 GIMP/ImageMagick 打开）`);
