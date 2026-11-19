// 测试运行器：用 esbuild 把 node:test 风格的 TS 用例打包为 ESM，再交给 node --test。
// 产物写入系统临时目录，仓库内不留下构建文件。
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "orbit-tests-"));
const outFile = join(outDir, "tests.mjs");

try {
  await build({
    entryPoints: [join(root, "tests", "filter.test.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: outFile,
  });
  const res = spawnSync(process.execPath, ["--test", outFile], {
    stdio: "inherit",
  });
  process.exitCode = res.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
