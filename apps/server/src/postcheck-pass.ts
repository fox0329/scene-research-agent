/**
 * postcheck-pass — 生成后三问自检的模型轮（规则 G-R8，v1.28）
 *
 * 用户定调（原话）：「每个阶段生成后有没有 1、确认来源的真实性 2、确认表述的准确、客观性
 * 3、问三次这真实吗？客观吗？有价值吗？把这个要作为规则在每次生成后检查」
 * 并且明确这不是让用户判断的事：「**这是生成过程的一个步骤，为什么要用户判断**」。
 *
 * 所以本步骤是生成流程的**内部环节**：
 *   第 1 轮：对本次生成的全部行问三问（真实吗 / 客观吗 / 有价值吗）
 *   第 2、3 轮：只复查上一轮被点名还没改掉的行（增量，不为省事而省判断）
 *   三轮之后仍没改掉的硬伤：领域层按实降级（不许继续挂「已核实」），并记入自检报告
 *
 * 分工（AGENTS §三.5：判定不进提示词）：
 *   - 「什么算问题」由 `@scene/domain` 的 `runDeterministicPostcheck` 定（可单测、可审计）
 *   - 模型只负责**按问题清单改写内容**（措辞、口径、核实说明、结论档位），不负责判定
 */

import {
  enforceMidCleanliness,
  enforceTruthfulDowngrade,
  runDeterministicPostcheck,
  summarizePostcheck,
  type InfoRow,
  type PostcheckFinding,
  type PostcheckReport,
  type PostcheckRow,
  type SourceLookup,
} from "@scene/domain";
import { middleColumns, tableDef, type TableDef } from "@scene/contract";
import { createSourceLookup, type DbInstance } from "@scene/infra";
import type { DshClient, FollowEvent, SessionHandle, StageId } from "@scene/contract";

/** 未知表号不该让自检炸掉（历史数据里可能有已下线的表号） */
function safeTableDef(code: string): TableDef | undefined {
  try {
    return tableDef(code);
  } catch {
    return undefined;
  }
}

/** 一张表的全部合法字段（中栏 + 右栏补充 + payload） */
function allowedKeysOf(code: string): ReadonlySet<string> {
  const def = safeTableDef(code);
  if (!def) return new Set<string>();
  const keys = def.columns.map((c) => c.key);
  for (const cols of Object.values(def.payloads ?? {})) {
    for (const c of cols) keys.push(c.key);
  }
  return new Set(keys);
}

/**
 * 三轮固定为：①全量三问（只报告）②只修被点名的 ③复查仍存疑的
 *
 * 用户选的就是"三轮增量"；这里不用循环表达，是因为三问的**职责各不同**
 * （报告 ≠ 修 ≠ 复查），套一个循环反而要在一轮里分支三种行为。
 */

/** 单轮最多处理的行数（超出一批时按批连问，不把一次 prompt 撑爆） */
const MAX_ROWS_PER_ROUND = 60;

/** 单轮模型调用上限：超时就跳过本轮，用确定性结果收口（自检不许把一次生成拖到不可预期） */
const ROUND_TIMEOUT_MS = 180_000;

/**
 * 摘要化时每个字段保留的字符数
 *
 * 第 1 轮是全量行：实跑数据说明**输入量就是耗时主因**（107 行 × 6 字段 ×200 字 ≈ 4 万 token，
 * 一步光自检就 8 分钟）。三问要看的是"主张本身"，所以只带中栏列 + 各 100 字。
 */
const DIGEST_FIELD_CHARS = 100;

/** 模型改不了的那几类问题：只由确定性层收口，别让它在三轮里反复"改" */
const DETERMINISTIC_ONLY_KINDS: ReadonlySet<string> = new Set(["声称有据但无出处", "结论与证据矛盾"]);

/** 允许模型改写的键：内容字段 + 核实两列 + 出处 */
const FIXABLE_KEYS = new Set(["verification", "verification_verdict", "source"]);

export interface PostcheckRunnerDeps {
  /** 取本阶段的行（服务端注入，便于单测用假数据） */
  listRows: () => { id: string; tableCode: string; row: InfoRow; source?: string | null; sourceType?: string | null }[];
  /** 材料库反查（服务端注入 createSourceLookup(db)；领域层只认端口） */
  lookup: SourceLookup;
  dshClient?: DshClient;
  /** 写回修正后的行（`source_type` 只有确定性兜底会用到：声称有据却无出处 → 按实改为 AI推断） */
  applyFix: (
    rowId: string,
    patch: { row?: InfoRow; source?: string | null; source_type?: string | null },
  ) => void;
  /** 进度回调（并发/生成器里不能直接 yield） */
  onProgress?: (message: string) => void;
  /** 本次生成随机种子/会话标题用 */
  scenarioName: string;
  stage: StageId;
}

export interface PostcheckOutcome {
  report: PostcheckReport;
  /** 三轮里模型改写并落库的行数 */
  fixedRows: number;
  /** 三轮后确定性降级的行数（硬伤没改掉） */
  downgraded: number;
  /** 每一步的可观测记录（便于排查"自检到底干了什么"） */
  trace: string[];
}

/**
 * 建材料库反查端口（应用层兜底）
 *
 * 为什么兜底：自检是生成的内部环节，**不许因为它自己起不来而连累一次生成**。
 * 拿不到 FTS 索引时退化为"查不了就不指控"（全返回 true）——宁可这一轮少查来源，
 * 也不能让用户白等一次生成，更不能凭空给行扣上"出处查不到"。
 */
export function makeSourceLookup(db: DbInstance): SourceLookup {
  try {
    return createSourceLookup(db.db);
  } catch {
    return { hasSource: () => true, hasContent: () => true };
  }
}

// ─── 行 → 待检对象 ───────────────────────────────────────

export function toPostcheckRows(
  raw: ReturnType<PostcheckRunnerDeps["listRows"]>,
): PostcheckRow[] {
  return raw.map((r) => {
    const def = safeTableDef(r.tableCode);
    const mid = def ? middleColumns(def) : [];
    const label =
      mid
        .map((c) => String((r.row as Record<string, unknown>)[c.key] ?? "").trim())
        .find((v) => v !== "") ?? "(未命名条目)";
    return {
      tableCode: r.tableCode,
      rowId: r.id,
      label,
      row: r.row,
      source: r.source ?? null,
      sourceType: r.sourceType ?? null,
    };
  });
}

// ─── 提示词 ──────────────────────────────────────────────

/**
 * 第 1/3 轮的"三问"提示词：**只找问题，不给修法**
 *
 * 为什么拆开（v1.28 实跑教训）：第一版让模型"遍查 97 行 + 顺手改"，它改了 25 行长文本，
 * 一步从 105 秒涨到 592 秒——检查的成本必须**与真问题数成正比**，不能与全量行数成正比。
 * 拆开后：第 1 轮输出只有"哪几行有问题"（几百 token），第 2 轮才只对这几行给修法。
 */
const SYSTEM_TRIAGE = `你是「生成后自检」环节的执行者。刚刚由你（或上一轮的你）生成了这批阶段信息行，
现在你要**对每一行连问三遍**：这真实吗？客观吗？有价值吗？

规则：
1. **逐行过，不抽检**，但**只回有问题的行**：没问题的行一条都不要回（省 token）。
2. 三问怎么判：
   - 真实吗：出处能不能对上材料？数据/专名/量级像不像编的？没有出处的推断有没有被写成事实？
   - 客观吗：有没有绝对化、营销化措辞（最好/唯一/必然/彻底解决/零门槛…）？有没有把行业通例写成本客户事实？口径是谁的？
   - 有价值吗：价值类主张有没有可测指标、有没有**本客户基线**？没基线的收益等于无法验证。
3. **本轮只报告，不给修法**：输出 row_id + 哪一问不合格 + 一句话说到点上（哪句话/哪个出处/哪个数）。
4. 上面「自检已发现问题」是系统已经判定过的事实，不必复述、不必争辩。
5. 不许把判断推给读者：不写"待核实""建议抽查""请用户确认"。`;

/** 第 2/3 轮的"修"提示词：只处理被点名的行，给出可直接落库的字段值 */
const SYSTEM = `你是「生成后自检」环节的执行者。刚刚由你（或上一轮的你）生成了这批阶段信息行，
现在你要**对自己的产出连问三遍**：这真实吗？客观吗？有价值吗？

规则：
1. **三问逐条过**，不是抽检：
   - 真实吗：这条的出处能不能对上材料？数据/专名/量级像不像编的？没有出处的推断有没有被写成事实？
   - 客观吗：有没有绝对化、营销化措辞（最好/唯一/必然/彻底解决/零门槛…）？有没有把行业通例写成本客户事实？口径是谁的？
   - 有价值吗：价值类主张有没有可测指标、有没有**本客户基线**？没基线的收益等于无法验证。
2. **只改被点名的行，能改就改**（没被点名的行不要回）：
   - 措辞问题 → 改写成可复算、可被反驳的客观表述（保留原意，删掉绝对化词）
   - 口径问题（把行情写成客户事实）→ 改成本客户事实就写"未提供"，或把表述退回行情口径
   - 出处对不上 → **不要把出处改成别的**（你不许编造来源）；把核实结论按实降级（单一来源/无法核实），
     并在核实说明里写清"哪一处对不上"
   - 价值缺基线 → 基线条写「未提供（本客户材料未含）」，并在核实说明里点明"价值不可验证"
   - **中栏夹带出处**（用户在内容格里看到文件名/页码/「（M5）」/「材料未提供」）→ 把引用**移到 fix.source**，
     内容格改写成**结论性的短句**（谁、做什么、多少、能不能、意味着什么）；搬空了的格子要用一句话补上结果，
     不许把格子留空、也不许写"待补"
   - **中栏太长**（一格塞了几件事）→ 压到一句话（≤40 字），只留结论 + 最关键的一个理由，
     其余细节删掉（右栏核实说明里已有过程留痕）
   - **依据未落到事实**（依据列里又写了一遍结论，或写「通常由第三方承载」这种行业套话）→
     改成**我方凭什么**：我方有哪些具体产品/型号/能力、明确没有什么、边界在哪；
     **不许复述"程度/角色/判定"那几列的词**（"属外围配合""只能配合"），也不许写换谁都成立的套话
3. **不许把判断推给读者**：不写"待核实""建议抽查""请用户确认"。
4. 没有问题的行**不要返回**（省 token）；返回的每一条必须给出可直接落库的字段值。
5. 同一行可以同时有多个问题，合并成一条返回，fix 里带上所有要改的字段。
6. 上面「自检已发现问题」是**系统已经判定过的事实**，不必复述、不必争辩；你只补它没看出来的问题，并给出修法。
7. **没有可定位出处的行不要去编出处**（不许凭空造文件名+页码）：这类行系统会自己按实降级，你重复处理只会白花时间；
   把力气花在"改得动"的地方——措辞、口径、基线说明。`;

/** 行摘要：只留判三问需要的字段，值截断——第 1 轮是全量行，完整 JSON 太贵 */
function digestRow(r: PostcheckRow): Record<string, string> {
  const cut = (v: unknown): string => {
    const text = Array.isArray(v) ? v.join("；") : String(v ?? "");
    return text.length > DIGEST_FIELD_CHARS ? `${text.slice(0, DIGEST_FIELD_CHARS)}…` : text;
  };
  const out: Record<string, string> = {};
  // 只带"中栏主张"（+ 核实结论）：三问判的是主张，右栏长文本不进全量轮，否则输入就是几万 token
  const def = safeTableDef(r.tableCode);
  const keys = def ? [...middleColumns(def).map((c) => c.key), "verification_verdict"] : Object.keys(r.row);
  for (const k of keys) {
    if (k === "verification") continue;
    if (Object.keys(out).length >= 5) break;
    const text = cut(r.row[k]);
    if (text !== "") out[k] = text;
  }
  return out;
}

function buildUser(rows: readonly PostcheckRow[], findings: readonly PostcheckFinding[], round: number): string {
  const byRow = new Map<string, PostcheckFinding[]>();
  for (const f of findings) {
    const list = byRow.get(f.rowId) ?? [];
    list.push(f);
    byRow.set(f.rowId, list);
  }
  const payload = rows.map((r) => ({
    row_id: r.rowId,
    table_code: r.tableCode,
    label: r.label,
    出处: r.source ?? "",
    来源类型: r.sourceType ?? "",
    行: digestRow(r),
    自检已发现问题: (byRow.get(r.rowId) ?? []).map((f) => `${f.kind}（${f.severity}）：${f.detail}`),
  }));
  return [
    `第 ${round} 轮自检。本阶段共 ${rows.length} 行（第 1 轮为全量，之后只复查上一轮没改掉的行）。`,
    "",
    "对每一行依次问：①这真实吗 ②这客观吗 ③这有价值吗。把有问题的行按下面的 JSON 返回。",
    "",
    "```json",
    JSON.stringify(payload, null, 1),
    "```",
  ].join("\n");
}

/** 第 1/3 轮（只报告）的返回契约：不要 fix，输出越小越省 */
const TRIAGE_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    problems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          row_id: { type: "string", description: "必须是上面给过的 row_id" },
          question: { type: "string", enum: ["真实", "客观", "价值"], description: "哪一问不合格" },
          detail: { type: "string", description: "一句话说到点上：哪句话/哪个出处/哪个数" },
        },
        required: ["row_id", "question", "detail"],
      },
    },
  },
  required: ["problems"],
};

/** 模型返回的 JSON 契约（不给它自由发挥的余地） */
const OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    problems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          row_id: { type: "string", description: "必须是上面给过的 row_id" },
          question: { type: "string", enum: ["真实", "客观", "价值"], description: "哪一问不合格" },
          detail: { type: "string", description: "具体到哪句话/哪个出处/哪个数" },
          fix: {
            type: "object",
            description:
              "要落库的字段值：内容字段原名（改写后的完整值）、verification（核实说明）、verification_verdict（按实降级）",
            additionalProperties: { type: "string" },
          },
        },
        required: ["row_id", "question", "detail", "fix"],
      },
    },
  },
  required: ["problems"],
};

// ─── 模型一轮 ────────────────────────────────────────────

interface LlmProblem {
  row_id?: unknown;
  question?: unknown;
  detail?: unknown;
  fix?: unknown;
}

/** 从模型输出里抠出 problems（容忍 ```json 包裹与前后废话） */
export function parseProblems(text: string): LlmProblem[] {
  const tryParse = (s: string): LlmProblem[] | null => {
    try {
      const parsed = JSON.parse(s) as { problems?: unknown };
      return Array.isArray(parsed.problems) ? (parsed.problems as LlmProblem[]) : null;
    } catch {
      return null;
    }
  };
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1].trim());
    if (inner) return inner;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const inner = tryParse(trimmed.slice(start, end + 1));
    if (inner) return inner;
  }
  return [];
}

/** 给一轮自检加超时：自检是生成的一部分，不许把它拖成"不知道还要多久" */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collect(
  session: SessionHandle,
  dsh: DshClient,
  system: string,
  user: string,
  contract: Record<string, unknown> = OUTPUT_CONTRACT,
): Promise<string> {
  const stream = dsh.prompt(session, { system, user, outputContract: contract });
  let text = "";
  for await (const event of stream as AsyncIterable<FollowEvent>) {
    if (event.type === "text") text += (event as { type: "text"; text: string }).text;
    if (event.type === "error") throw new Error(String((event as { message?: string }).message ?? "模型调用出错"));
  }
  return text;
}

/**
 * 第 1/3 轮：全量三问，只收集"哪几行有问题"
 *
 * 分批问（每批 ≤ MAX_ROWS_PER_ROUND 行），每批独立超时；某批失败只丢那一批。
 */
async function triage(
  session: SessionHandle,
  dsh: DshClient,
  rows: readonly PostcheckRow[],
  findings: readonly PostcheckFinding[],
  progress: (m: string) => void,
): Promise<{ rowId: string; question: string; detail: string }[]> {
  const out: { rowId: string; question: string; detail: string }[] = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_ROUND) {
    const batch = rows.slice(i, i + MAX_ROWS_PER_ROUND);
    try {
      const problems = parseProblems(
        await withTimeout(
          collect(session, dsh, SYSTEM_TRIAGE, buildUser(batch, findings, 1), TRIAGE_CONTRACT),
          ROUND_TIMEOUT_MS,
          `三问自检超时（${Math.round(ROUND_TIMEOUT_MS / 1000)} 秒）`,
        ),
      );
      for (const p of problems) {
        const rowId = String(p.row_id ?? "");
        if (rowId === "") continue;
        out.push({
          rowId,
          question: String(p.question ?? ""),
          detail: String(p.detail ?? "").slice(0, 200),
        });
      }
    } catch (err: unknown) {
      progress(`三问自检这一批失败（跳过）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ─── 应用修正 ────────────────────────────────────────────

/** 只认合法行、合法字段、合法档位的修正；其余一律丢弃（模型不能靠自检越权改结构） */
export function sanitizeFix(
  row: InfoRow,
  fix: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): { row: InfoRow } | null {
  const next: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  let touched = false;
  for (const [key, raw] of Object.entries(fix)) {
    if (typeof raw !== "string") continue;
    if (!allowedKeys.has(key) && !FIXABLE_KEYS.has(key)) continue;
    if (raw.length > 4000) continue;
    // 只允许按实降级，不许把结论升到「已核实」（升级必须有可定位出处，由确定性层判）
    if (key === "verification_verdict" && raw.trim() === "已核实") continue;
    if (String(next[key] ?? "") === raw) continue;
    next[key] = raw;
    touched = true;
  }
  return touched ? { row: next as InfoRow } : null;
}

// ─── 主流程 ──────────────────────────────────────────────

/**
 * 跑完整个自检（三轮增量）
 *
 * 返回自检结果与报告；调用方负责把它写进总结/事件。**不抛异常**：自检本身失败
 * 不能让一次生成前功尽弃（宁可少一轮自检，也不能丢用户的产出）。
 */
export async function runPostcheck(deps: PostcheckRunnerDeps): Promise<PostcheckOutcome> {
  const trace: string[] = [];
  const progress = (m: string): void => {
    trace.push(m);
    deps.onProgress?.(m);
  };
  const { lookup } = deps;

  let all = toPostcheckRows(deps.listRows());
  if (all.length === 0) {
    return { report: summarizePostcheck({ checked: 0, fixed: 0, findings: [] }), fixedRows: 0, downgraded: 0, trace };
  }

  // 判定始终由领域层给：模型只改内容，不判"什么算问题"
  let findings = runDeterministicPostcheck({ rows: all, lookup });
  progress(`生成后自检：初查 ${all.length} 行，命中 ${findings.length} 处待处理`);
  const allFindings = [...findings];
  let fixedRows = 0;

  const dsh = deps.dshClient;
  if (findings.length > 0 && dsh) {
    const session = await dsh.createSession({ title: `生成后自检 · ${deps.scenarioName}` });
    try {
      // 第 1/3 轮：全量三问，只报告（输出小 → 成本与"真问题数"成正比）
      progress(`第 1/3 轮三问自检：全量 ${all.length} 行（只报告不改写）`);
      let triaged = await triage(session, dsh, all, findings, progress);
      if (triaged.length > 0) {
        progress(`第 1 轮：模型另指出 ${triaged.length} 处问题`);
      }

      // 第 2/3 轮：只修被点名的行（确定性判出的 + 模型刚指出的）
      const fixRows = new Set<string>([
        ...findings.filter((f) => !DETERMINISTIC_ONLY_KINDS.has(f.kind)).map((f) => f.rowId),
        ...triaged.map((t) => t.rowId),
      ]);
      const fixTargets = all.filter((r) => fixRows.has(r.rowId));
      if (fixTargets.length > 0) {
        progress(`第 2/3 轮：只改被点名的 ${fixTargets.length} 行`);
        const batches: PostcheckRow[][] = [];
        for (let i = 0; i < fixTargets.length; i += MAX_ROWS_PER_ROUND) {
          batches.push(fixTargets.slice(i, i + MAX_ROWS_PER_ROUND));
        }
        for (const batch of batches) {
          let problems: LlmProblem[] = [];
          try {
            problems = parseProblems(
              await withTimeout(
                collect(session, dsh, SYSTEM, buildUser(batch, findings, 2)),
                ROUND_TIMEOUT_MS,
                `第 2 轮自检修法超时（${Math.round(ROUND_TIMEOUT_MS / 1000)} 秒）`,
              ),
            );
          } catch (err: unknown) {
            progress(`第 2 轮自检调用失败（跳过剩余批次）：${err instanceof Error ? err.message : String(err)}`);
            break;
          }
          const byId = new Map(batch.map((r) => [r.rowId, r]));
          for (const p of problems) {
            const rowId = String(p.row_id ?? "");
            const target0 = byId.get(rowId);
            if (!target0 || typeof p.fix !== "object" || p.fix === null) continue;
            const sanitized = sanitizeFix(
              target0.row,
              p.fix as Record<string, unknown>,
              allowedKeysOf(target0.tableCode),
            );
            if (!sanitized) continue;
            const sourceFix = (p.fix as Record<string, unknown>)["source"];
            deps.applyFix(rowId, {
              row: sanitized.row,
              ...(typeof sourceFix === "string" ? { source: sourceFix } : {}),
            });
            all = all.map((r) => (r.rowId === rowId ? { ...r, row: sanitized.row } : r));
            fixedRows++;
          }
        }
        progress(`第 2 轮：模型改写 ${fixedRows} 行`);
      } else {
        progress("第 2/3 轮：没有被点名的行，无须改写");
      }

      // 改完再判一遍——判定权始终在确定性层
      findings = runDeterministicPostcheck({ rows: all, lookup });
      allFindings.push(...findings);

      // 第 3/3 轮：对"改完还存疑"的行再问一遍（第三问）
      const stillFlagged = new Set([
        ...findings.filter((f) => !DETERMINISTIC_ONLY_KINDS.has(f.kind)).map((f) => f.rowId),
        ...triaged.map((t) => t.rowId),
      ]);
      const recheck = all.filter((r) => stillFlagged.has(r.rowId));
      if (recheck.length > 0) {
        progress(`第 3/3 轮：复查仍有存疑的 ${recheck.length} 行`);
        triaged = await triage(session, dsh, recheck, findings, progress);
        progress(`第 3 轮：模型仍指出 ${triaged.length} 处存疑`);
      } else {
        progress("第 3/3 轮：已无存疑行");
      }
    } catch (err: unknown) {
      progress(`自检会话异常（按现有结果收口）：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await dsh.cancel(session).catch(() => undefined);
    }
  }

  // 三轮之后仍没改掉的硬伤：按实降级（来源不存在则作废——G-R0）
  const downgrades = enforceTruthfulDowngrade(all, findings);
  const downgradedIds = new Set(downgrades.map((d) => d.rowId));
  for (const d of downgrades) {
    if (d.sourceType) all = all.map((r) => (r.rowId === d.rowId ? { ...r, sourceType: d.sourceType } : r));
  }
  for (const d of downgrades) {
    deps.applyFix(d.rowId, {
      row: d.row,
      ...(d.sourceType ? { source_type: d.sourceType } : {}),
    });
  }
  if (downgrades.length > 0) {
    // 报出来的必须是**实际做了什么**：有的行是结论降级，有的行只是来源属性改成 AI 推断（行情不动结论）
    const verdictDown = downgrades.filter(
      (d) => String(d.row["verification_verdict"] ?? "").trim() === "无法核实",
    ).length;
    const provenanceOnly = downgrades.length - verdictDown;
    const parts: string[] = [];
    if (verdictDown > 0) parts.push(`${verdictDown} 行结论按实降为「无法核实」`);
    if (provenanceOnly > 0) parts.push(`${provenanceOnly} 行出处给不出来、按实标为「AI 推断」`);
    progress(`三轮后仍有硬伤 ${downgrades.length} 行：${parts.join("，")}（都不许当结论用）`);
  }
  // 三轮后中栏仍夹带出处的：确定性搬走（版面口径，不靠模型自觉）
  const sweeps = enforceMidCleanliness(all);
  for (const sw of sweeps) {
    deps.applyFix(sw.rowId, {
      row: sw.row,
      ...(typeof sw.row["source"] === "string" ? { source: String(sw.row["source"]) } : {}),
    });
    all = all.map((r) => (r.rowId === sw.rowId ? { ...r, row: sw.row, source: String(sw.row["source"] ?? r.source ?? "") } : r));
  }
  if (sweeps.length > 0) {
    const movedAll = sweeps.reduce((n, sw) => n + sw.movedCount, 0);
    const emptyAll = sweeps.reduce((n, sw) => n + sw.emptied.length, 0);
    progress(
      `中栏夹带出处 ${sweeps.length} 行：已把 ${movedAll} 处引用搬到右栏「来源」，正文一字未删` +
        (emptyAll > 0 ? `；有 ${emptyAll} 个格子只剩引用、已留空（完整度会报缺，需要重填）` : ""),
    );
  }

  // 降级行的矛盾已消解，不再是"待办"；但 byKind 仍保留，便于看这一轮抓到了什么
  const open = findings.filter(
    (f) => !downgradedIds.has(f.rowId) && !sweeps.some((sw) => sw.rowId === f.rowId),
  );

  const report = summarizePostcheck({
    checked: all.length,
    fixed: fixedRows,
    downgraded: downgrades.length,
    findings: allFindings,
    open,
  });
  trace.push(`自检收口：检 ${report.checked} 行 / 模型改写 ${report.fixed} 行 / 降级 ${downgrades.length} 行 / 仍存疑 ${report.remaining} 条`);
  return { report, fixedRows, downgraded: downgrades.length, trace };
}
