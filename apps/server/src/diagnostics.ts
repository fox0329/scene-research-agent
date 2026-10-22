/**
 * 诊断信息（设置 → 导出诊断信息）
 *
 * 目的：用户报障时不用教他翻目录、也不用把整库发出来。只收**能定位问题**的元信息：
 * 版本、平台、数据目录、各表行数、迁移/备份实况、最近日志；**绝不收**模型 Key、
 * 材料正文、场景正文。
 *
 * 为什么放这里而不是路由里：要能纯函数单测（假 db + 假日志），路由只负责下载头。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DbInstance } from "@scene/infra";

/** 日志最多带多少行：够看到一次失败的堆栈，又不会把文件整个发出去 */
const LOG_TAIL_LINES = 200;

export interface DiagnosticsInput {
  db: DbInstance;
  /** registrySummary() 的结果（本身就不含 Key） */
  providers: unknown;
  version: string;
  now?: Date;
}

function tryCount(db: DbInstance, table: string): number | string {
  try {
    const row = db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number };
    return Number(row?.c ?? 0);
  } catch {
    return "无此表";
  }
}

/** 取日志尾部；找不到日志就说明没有，不编造 */
export function readLogTail(path: string, limit = LOG_TAIL_LINES): string[] {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    return lines.slice(Math.max(0, lines.length - limit)).filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

export function buildDiagnosticsText(input: DiagnosticsInput): string {
  const { db, providers, version } = input;
  const now = (input.now ?? new Date()).toISOString();
  const dataDir = db.dbPath !== "" && db.dbPath !== ":memory:" ? dirname(db.dbPath) : "";
  const logPath = dataDir !== "" ? join(dataDir, "..", "logs", "server.log") : "";

  const lines: string[] = [
    "场景通 诊断信息（可直接发给支持人员）",
    `生成时间：${now}`,
    `应用版本：${version}`,
    `平台：${process.platform} ${process.arch}`,
    `Node：${process.version}`,
    "",
    "## 数据位置",
    `数据库：${db.dbPath}`,
    `数据目录：${dataDir || "（内存库）"}`,
    "",
    "## 数据规模（行数）",
    `场景：${tryCount(db, "scenario")}`,
    `信息表行：${tryCount(db, "stage_data")}`,
    `调研来源：${tryCount(db, "research_source")}`,
    `网页抓取缓存：${tryCount(db, "web_source")}`,
    `资料库（产品/规格/能力/边界/限制/报价/可选）：` +
      [
        "product",
        "spec_param",
        "capability",
        "boundary",
        "limitation",
        "price_quote",
        "optional_material",
      ]
        .map((t) => `${t}=${tryCount(db, t)}`)
        .join(" "),
    "",
    "## 模型与检索配置（不含 Key）",
    JSON.stringify(providers, null, 2),
    "",
    "## 最近日志",
    logPath !== "" ? `日志文件：${logPath}（大小 ${safeSize(logPath)}）` : "日志文件：未启用",
    ...(logPath !== "" ? readLogTail(logPath) : ["（无日志）"]),
    "",
  ];
  return lines.join("\n");
}

function safeSize(path: string): string {
  try {
    return `${statSync(path).size} 字节`;
  } catch {
    return "未知";
  }
}
