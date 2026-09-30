#!/usr/bin/env node
/**
 * 把 infra 的 SQL 迁移文件拷进构建产物目录
 *
 * 为什么需要：`tsc -b` **不会拷贝 .sql**，而运行时是按
 * `resolve(dirname(import.meta.url), "sql", "001_init.sql")` 读的（即 dist/sql/）。
 * 原实现只把这个拷贝挂在 npm `postbuild` 生命周期上——只要有人直接跑
 * `tsc -b`（含 project references 的增量构建、CI 的类型检查），拷贝就不会执行，
 * 于是**任何 SQL 改动都到不了运行时**（表现为 `no such table: xxx`，且旧库看起来正常）。
 *
 * 因此把拷贝做成显式脚本，由 build / typecheck / start / e2e 共同调用。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "packages/infra/src/sql");
const to = resolve(root, "packages/infra/dist/sql");

if (!existsSync(from)) {
  console.error(`✗ 找不到 SQL 源目录：${from}`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`✅ SQL 已同步到构建产物：${to}`);
