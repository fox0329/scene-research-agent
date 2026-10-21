import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDiagnosticsText, readLogTail } from "./diagnostics.js";
import type { DbInstance } from "@scene/infra";

function fakeDb(dbPath: string): DbInstance {
  return {
    dbPath,
    dbBackup: { dir: null, warnings: [] },
    db: { prepare: () => ({ get: () => ({ c: 7 }) }) },
  } as unknown as DbInstance;
}

describe("diagnostics", () => {
  it("包含版本、数据规模、备份状态与日志，且不出现 Key 字样", () => {
    const dir = mkdtempSync(join(tmpdir(), "diag-"));
    const dataDir = join(dir, "data");
    mkdirSync(join(dir, "logs"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dir, "logs", "server.log"), "line-1\nline-2\n");
    const text = buildDiagnosticsText({
      db: fakeDb(join(dataDir, "scene.db")),
      providers: { providers: [{ name: "公司网关", base_url: "https://api.example.com/v1" }] },
      version: "0.7.0",
    });
    expect(text).toContain("应用版本：0.7.0");
    expect(text).toContain("场景：7");
    expect(text).toContain("公司网关");
    expect(text).toContain("line-2");
    expect(text).not.toMatch(/api_key|sk-[A-Za-z0-9]/u);
  });

  it("没有日志时如实说明，不抛错", () => {
    expect(readLogTail("/nonexistent/none.log")).toEqual([]);
    const text = buildDiagnosticsText({
      db: fakeDb(":memory:"),
      providers: {},
      version: "dev",
    });
    expect(text).toContain("（内存库）");
    expect(text).toContain("（无日志）");
  });
});
