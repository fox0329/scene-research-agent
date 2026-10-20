/**
 * output-gates — 跑门限（确定性层）
 *
 * 契约里登记的是**规则**（`TABLE_GATES`），这里负责**执行**：逐表逐行跑，
 * 输出「哪张表、哪一行、哪条门限、为什么不达标」，供生成后自检点名与人工复核。
 *
 * 用户定调（2026-10-20）：「明确每个表格的生成要求，输出检查门限，一定要确保输出内容的价值。
 * 没价值的内容删除」。所以这里的判定不追求"宽松放过"，而是**宁可点名让人看**——
 * 但也不许误杀：凡是有内容、只是不够具体的，判「存疑」；整行没有实质内容的才判「硬伤」。
 */

import {
  ENUMS,
  middleColumns,
  tableDef,
  TABLE_GATES,
  type GateSpec,
  type ScopedGate,
  type TableDef,
} from "@scene/contract";
import { judgeConstraint } from "./constraint-check.js";
import { judgeGate } from "./gate-check.js";
import { judgeRowValue } from "./value-check.js";

export type GateSeverity = "硬伤" | "存疑";

export interface GateFinding {
  tableCode: string;
  rowId: string;
  /** 行标识（中栏首列），便于人一眼定位 */
  label: string;
  /** 门限类型（调用方按类型定级：必填缺失属完整性，不重复判硬伤） */
  kind: GateSpec["kind"];
  gate: string;
  detail: string;
  severity: GateSeverity;
}

/** 待检的一行 */
export interface GateRow {
  id: string;
  tableCode: string;
  row: Record<string, unknown>;
  /**
   * 所属场景。
   *
   * 去重、合计、覆盖、跨表核对都**必须在同一场景内**做：两个场景复用同一套公司能力
   * （`表4-1` 28 + 50 行里有大量同名能力）是正常的，跨场景去重会把正常数据判成重复。
   * 不传时视为单场景（生成后自检本来就是按场景跑的）。
   */
  scenarioId?: string;
}

const PLACEHOLDER = /^(未提供|待补|待补充|待确认|待核实|不详|未知|无|暂无|材料未含|-|—|\/|n\/a|na)$/i;
/** 「泛称」：看起来填了，其实没点名 */
const GENERIC_NAMED = /行业主流|主流厂商|多家|若干|相关厂商|业内领先|头部厂商|待确认|未提供|TBD|待定/i;
const NUMBERISH = /\d+(?:\.\d+)?\s*(?:%|％|万元|万|元|亿元|年|个月|天|小时|h|min|分钟|秒|s|ms|次|℃|dB|ppm|mg|TOPS|GB|TB|级|类|人天|台|路|套)?/;
/** 中文量级（「单台百万元级」「十万元级」——报量级本来就不必写阿拉伯数字） */
const MAGNITUDE = /[十百千万亿]{1,3}\s*元\s*(?:级|左右|上下)?/;
/** 空话：写了等于没写的处置建议 */
/**
 * 空话词表（用户定调「没价值的内容删除」；专家审阅指出原词表只有 5 个整句、
 * 对「稳定运行」「客户满意」「操作更便捷」全放行，等于没有）
 */
const VAGUE_ADVICE =
  /注意风险|注意安全|加强管理|加强沟通|密切关注|做好沟通|做好联调|及时跟进|视情况而定|酌情|按需|原则上|尽快|稳定运行|运行稳定|客户满意|操作更便捷|体验更好|显著|大幅|明显提升|有效提升|有待提升|不够用|效率低|易出错|各系统|各类|多个|若干/;
/** 中文数词（「四类停机」「三项验收」也算给了量化口径） */
const CN_NUMERAL = /[一二三四五六七八九十百千万]{1,3}\s*(类|项|个|台|套|条|人|天|年|月|小时)/;
/** 合计行：派生的汇总不是一行发现 */
const AGGREGATE_LABEL = /^(合计|总计|小计|汇总|总分|综合赢面|加权总分)([（(:：].*)?$/;
const STANDARD_OR_PROTOCOL =
  /GB\/?T?\s*\d|HJ\s*\d|JJG\s*\d|JJF\s*\d|ISO\s*\d|IEC\s*\d|IATF\s*\d|VDA\s*\d|SEMI\s*\w?\d|OPC\s*UA|Modbus|PROFINET|Profibus|MQTT|HART|REST|API|SIL\s*[1-4]|Ex\s*t?[a-zA-Z]*/i;
/** 厂商名特征：公司/厂/集团/科技/机械/自动化/股份/有限/Inc/Co/Ltd，或带括号的英文名 */
const VENDOR_LIKE = /(公司|集团|股份|科技|机械|自动化|电气|电子|智能|重工|精机|软件|工业|Inc|Co\.|Ltd|GmbH|AG|·)|[A-Za-z]{2,}/;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** 枚举列的实填值常带括注（「分散（多家可选，行业口径）」），比对时去掉括注与空白 */
function enumBase(value: string): string {
  return value.replace(/[（(][^）)]*[)）]/g, "").replace(/\s/g, "").trim();
}

function matchesEnum(value: string, values: readonly string[]): boolean {
  const base = enumBase(value);
  return values.some((v) => enumBase(v) === base || base.startsWith(enumBase(v)));
}

function isBlank(value: unknown): boolean {
  const t = text(value);
  return t === "" || PLACEHOLDER.test(t);
}

/** 并列项个数（、，,；; 分隔，去掉空项） */
function itemCount(value: unknown): number {
  return text(value)
    .split(/[、，,；;]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0).length;
}

/** 跑单行门限；需要整表/跨表数据的规则单独处理（见 evaluateGates） */
function judgeRowGates(
  def: TableDef,
  row: Record<string, unknown>,
  gates: readonly ScopedGate[],
): { kind: GateSpec["kind"]; gate: string; detail: string; severity: GateSeverity }[] {
  const out: { kind: GateSpec["kind"]; gate: string; detail: string; severity: GateSeverity }[] = [];
  for (const raw of gates) {
    const g = raw;
    /* 作用域：一张表装两类行时（表5-1 架构行/接口行），门限只对相应那类生效 */
    if (raw.when) {
      if (raw.when.equals !== undefined) {
        if (text(row[raw.when.column]) !== raw.when.equals) continue;
      } else {
        const has = !isBlank(row[raw.when.column]);
        if (has !== raw.when.present) continue;
      }
    }
    switch (g.kind) {
      case "non-empty": {
        /* 枚举列里「未知」是合法取值（表4-4 的胜负允许未知），占位词检测不该把它算空；
           其余列照旧把「未知/未提供」当空 */
        const blanks = g.columns.filter((c) => {
          if (!isBlank(row[c])) return false;
          const enumKey = def.columns.find((x) => x.key === c)?.enum;
          const allowed: readonly string[] = enumKey ? (ENUMS[enumKey] ?? []) : [];
          return !allowed.includes(text(row[c]));
        });
        if (blanks.length) {
          const labels = blanks.map((c) => def.columns.find((x) => x.key === c)?.label ?? c);
          out.push({ kind: g.kind, gate: g.text, detail: `这些格是空的或只写了占位词：${labels.join("、")}`, severity: "硬伤" });
        }
        break;
      }
      case "has-number": {
        const ok = g.columns.some((c) => {
          const t = text(row[c]);
          if (isBlank(t)) return false;
          return (NUMBERISH.test(t) && /\d/.test(t)) || MAGNITUDE.test(t) || CN_NUMERAL.test(t);
        });
        if (!ok) out.push({ kind: g.kind, gate: g.text, detail: "没有给出可比对的数值（不许「较高」「显著」）", severity: "存疑" });
        break;
      }
      case "named": {
        const bad = g.columns.filter((c) => {
          const t = text(row[c]);
          if (isBlank(t)) return true;
          /* 落到具名主体即通过：名单后面补一句「多家分散」不影响它已经点了名 */
          if (VENDOR_LIKE.test(t) || STANDARD_OR_PROTOCOL.test(t)) return false;
          /* 只有泛称、没有任何具体名字：不通过 */
          return GENERIC_NAMED.test(t) || t.length < 6;
        });
        if (bad.length) {
          const labels = bad.map((c) => def.columns.find((x) => x.key === c)?.label ?? c);
          out.push({ kind: g.kind, gate: g.text, detail: `没落到具名主体（写的是泛称或空）：${labels.join("、")}`, severity: "存疑" });
        }
        break;
      }
      case "min-items": {
        if (itemCount(row[g.column]) < g.min) {
          out.push({ kind: g.kind, gate: g.text, detail: `只写了 ${itemCount(row[g.column])} 项，至少要 ${g.min} 项`, severity: "存疑" });
        }
        break;
      }
      case "enum": {
        const t = text(row[g.column]);
        if (t && !matchesEnum(t, g.values)) {
          out.push({ kind: g.kind, gate: g.text, detail: `取值「${t}」不在允许范围（${g.values.join(" / ")}）`, severity: "硬伤" });
        }
        break;
      }
      case "enum-of-column": {
        const col = def.columns.find((c) => c.key === g.column);
        const values: readonly string[] = col?.enum ? (ENUMS[col.enum] ?? []) : [];
        const t = text(row[g.column]);
        if (values.length && t && !matchesEnum(t, values)) {
          out.push({
            kind: g.kind,
            gate: g.text,
            detail: `取值「${t}」不在该列枚举内（${values.join(" / ")}）`,
            severity: "硬伤",
          });
        }
        break;
      }
      case "gate-questions": {
        const v = judgeGate(row);
        if (!v.isGate) {
          out.push({
            kind: g.kind,
            gate: g.text,
            detail: `${v.failures.join("；")}${v.suggestTable ? `。去向：${v.suggestTable}` : ""}`,
            severity: "存疑",
          });
        }
        break;
      }
      case "constraint-check": {
        const v = judgeConstraint(row);
        if (!v.isConstraint) {
          out.push({
            kind: g.kind,
            gate: g.text,
            detail: `${v.failures.join("；")}${v.suggestTable ? `。去向：${v.suggestTable}` : ""}`,
            severity: "存疑",
          });
        }
        break;
      }
      case "not-vague": {
        const vague = g.columns.filter((c) => {
          const t = text(row[c]);
          return t !== "" && (VAGUE_ADVICE.test(t.replace(/[\s]/g, "")) || /注意风险|加强管理|密切关注/.test(t) && t.length < 12);
        });
        if (vague.length) {
          const labels = vague.map((c) => def.columns.find((x) => x.key === c)?.label ?? c);
          out.push({ kind: g.kind, gate: g.text, detail: `写的是空话，落不了地：${labels.join("、")}`, severity: "存疑" });
        }
        break;
      }
      case "no-aggregate-row": {
        const t = text(row[g.column]);
        if (AGGREGATE_LABEL.test(t)) {
          out.push({ kind: g.kind, gate: g.text, detail: `「${t}」是派生值，删掉；合计由门限核对`, severity: "存疑" });
        }
        break;
      }
      /* 整表级规则在 evaluateGates 里跑 */
      case "unique":
      case "coverage":
      case "cross-ref":
      case "sum-to":
        break;
    }
  }
  return out;
}

/** 名目归一：去掉空白、括号注、标点，用于跨表与去重比对 */
/** 只做空白与大小写归一，保留括注——用于「不许重复」这类需要看整格原文的判定 */
function canonKeepNotes(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function canon(value: unknown): string {
  return text(value)
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/[\s，,。.、；;：:!？?—\-"'「」【】]/g, "")
    .toLowerCase();
}

/**
 * 跑全部门限
 *
 * @param rows - 待检行（一次给同一场景的全部行，跨表规则才有依据）
 * @returns 不达标清单（按表、行排序）
 */
export function evaluateGates(rows: readonly GateRow[]): GateFinding[] {
  /* 分组键带上场景：跨场景的同名能力、同名分层是正常的，不能判重复 */
  const byTable = new Map<string, GateRow[]>();
  const tableOf = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.scenarioId ?? "__single__"}|${r.tableCode}`;
    const list = byTable.get(key) ?? [];
    list.push(r);
    byTable.set(key, list);
    tableOf.set(key, r.tableCode);
  }

  const findings: GateFinding[] = [];
  for (const [groupKey, tableRows] of byTable) {
    const tableCode = tableOf.get(groupKey) ?? "";
    const gates = TABLE_GATES[tableCode];
    if (!gates?.length) continue;
    let def: TableDef;
    try {
      def = tableDef(tableCode);
    } catch {
      continue;
    }
    const labelOf = (row: Record<string, unknown>): string => {
      const first = middleColumns(def)[0];
      return first ? text(row[first.key]) || "（无标识）" : "（无标识）";
    };

    for (const r of tableRows) {
      const perRow = judgeRowGates(def, r.row, gates);
      for (const f of perRow) {
        findings.push({ tableCode, rowId: r.id, label: labelOf(r.row), ...f });
      }

      /* 价值闸：整行没有实质内容 */
      const value = judgeRowValue(middleColumns(def).map((c) => r.row[c.key]));
      if (!value.hasValue) {
        findings.push({
          tableCode,
          rowId: r.id,
          label: labelOf(r.row),
          kind: "non-empty",
          gate: "行必须有实质内容",
          detail: value.reason ?? "整行没有实质内容",
          severity: "硬伤",
        });
      }
    }

    /* 整表级规则 */
    for (const g of gates) {
      if (g.kind === "unique") {
        const seen = new Map<string, string[]>();
        for (const r of tableRows) {
          /* 去重看「整格原文」，不能像 enum 那样剥括注：
             表3-1 的环节形如「器件（在线仪表与传感器…）」「器件（PLC/DCS…）」，
             两条都是真实存在的不同环节，剥掉括注只剩「器件」会误判重复。 */
          const key = g.columns.map((c) => canonKeepNotes(r.row[c])).join("|");
          if (!key.replace(/\|/g, "")) continue;
          seen.set(key, [...(seen.get(key) ?? []), r.id]);
        }
        for (const [key, ids] of seen) {
          if (ids.length < 2) continue;
          for (const id of ids) {
            const row = tableRows.find((x) => x.id === id)?.row ?? {};
            findings.push({
              tableCode,
              rowId: id,
              label: labelOf(row),
              kind: g.kind,
              gate: g.text,
              detail: `与另外 ${ids.length - 1} 行重复（${key.split("|").join(" / ")}），重复登记会虚增结论`,
              severity: "存疑",
            });
          }
        }
      }

      if (g.kind === "coverage") {
        const present = new Set(tableRows.map((r) => text(r.row[g.column])));
        const missing = g.values.filter((v) => !present.has(v));
        if (missing.length) {
          findings.push({
            tableCode,
            rowId: "",
            label: "（整表）",
            kind: g.kind,
            gate: g.text,
            detail: `缺少：${missing.join("、")}`,
            severity: "存疑",
          });
        }
      }

      if (g.kind === "sum-to") {
        const nums = tableRows
          .filter((r) => !AGGREGATE_LABEL.test(text(r.row["dimension"] ?? r.row["item"] ?? "")))
          .map((r) => Number.parseFloat(text(r.row[g.column]).replace(/[^\d.-]/g, "")))
          .filter((n) => Number.isFinite(n));
        if (nums.length) {
          const sum = nums.reduce((a, b) => a + b, 0);
          if (Math.abs(sum - g.target) > g.tolerance) {
            findings.push({
              tableCode,
              rowId: "",
              label: "（整表）",
              kind: g.kind,
              gate: g.text,
              detail: `实际合计 ${Math.round(sum * 10) / 10}，要求 ${g.target}±${g.tolerance}`,
              severity: "存疑",
            });
          }
        }
      }

      if (g.kind === "cross-ref") {
        const scenario = groupKey.split("|")[0] ?? "__single__";
        const targetRows = byTable.get(`${scenario}|${g.table}`) ?? [];
        if (!targetRows.length) continue; // 目标表还没数据时不判，避免级联报错
        const targets = targetRows.map((r) => canon(r.row[g.target])).filter(Boolean);
        /* 外部主体不是「场景要素」，但关系必须能具名对端（监管平台、电网、运营商…） */
        const EXTERNAL = /监管|环保|生态环境|电网|供电|运营商|云平台|上级|集团|第三方|客户/;
        const failures: string[] = [];
        for (const r of tableRows) {
          const raw = text(r.row[g.column]);
          if (!raw) continue;
          /* 关系类字段（A → B）两端都要能对上；普通字段整体比对 */
          /* 引用常带前缀与括注（「表3-8 缺口：28 台压铸机联网取数（…）」），
             所以先剥前缀，再按**包含**比对，而不是要求一字不差 */
          const stripped = raw.replace(/^(表\s*\d+-\d+\s*(缺口|需求|依据)?\s*\d*\s*[:：]?\s*)/, "");
          /* 只按关系箭头拆两端：型号里的连字符（YS-EC3200）不能当分隔符 */
          const parts = stripped.split(/[→↔]+/).map((x) => canon(x)).filter(Boolean);
          /* 短标签（环节名、能力名）要求规范化后全等；长句才允许前缀/包含匹配。
             专家审阅指出：「注塑」命中「注塑机联网」这类截断匹配会漏环节。 */
          const strict = parts.every((p) => p.length <= 12);
          const missing = (parts.length > 1 ? parts : [canon(stripped)]).filter((p) => {
            if (EXTERNAL.test(p)) return false;
            /* 短标签：全等，或整格文本包含目标（「CT15 边缘计算网关」含「CT15」算对上）；
               反向（「注塑」对上「注塑机联网」）仍算截断，要拦 */
            if (strict) return !targets.some((t) => t === p || p.includes(t));
            return !targets.some((t) => t.includes(p) || p.includes(t));
          });
          if (missing.length > 0) {
            failures.push(`${r.id}:${(missing[0] ?? "").slice(0, 20)}`);
            findings.push({
              tableCode,
              rowId: r.id,
              label: labelOf(r.row),
              kind: g.kind,
              gate: g.text,
              detail: `「${raw.slice(0, 30)}」里有对端在 ${g.table} 找不到`,
              severity: "存疑",
            });
          }
        }
        /* 整表失配率超过 30%：不是个别行写错，而是引用体系失效（表4-3 的 36 行事故） */
        const judged = tableRows.filter((r) => text(r.row[g.column]) !== "").length;
        if (judged >= 5 && failures.length / judged > 0.3) {
          const first = findings.find((f) => f.tableCode === tableCode && f.gate === g.text);
          if (first) first.severity = "硬伤";
          findings.push({
            tableCode,
            rowId: "",
            label: "（整表）",
            kind: g.kind,
            gate: g.text,
            detail: `${failures.length}/${judged} 行对端找不到（超过 30%），引用体系失效：源表与下游表的名称/编号必须重新对齐`,
            severity: "硬伤",
          });
        }
      }
    }
  }
  return findings;
}
