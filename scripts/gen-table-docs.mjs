#!/usr/bin/env node
/**
 * 由表定义注册表生成 `05-表格定义总表.md`
 *
 * 用法：
 *   pnpm gen:docs     生成
 *   pnpm check:docs   校验（文件与注册表一致则退出 0，否则 1；用于 CI 与收口脚本）
 *
 * 组成：preamble(手写) + 逐表(生成) + appendix(手写) + 汇总(生成) + version(手写)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { composeTableDoc } from "../packages/contract/dist/docgen.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const composed = composeTableDoc({
  preamble: read("docs-src/05-a-preamble.md"),
  appendix: read("docs-src/05-b-appendix.md"),
  version: read("docs-src/05-c-version.md"),
});

const target = resolve(root, "05-表格定义总表.md");

if (process.argv.includes("--check")) {
  const current = read("05-表格定义总表.md");
  if (current !== composed) {
    console.error("❌ 05-表格定义总表.md 与注册表不一致——请跑 `pnpm gen:docs` 重新生成");
    process.exit(1);
  }
  console.log("✅ 05-表格定义总表.md 与注册表一致");
} else {
  writeFileSync(target, composed);
  console.log("✅ 已生成 05-表格定义总表.md");
}
