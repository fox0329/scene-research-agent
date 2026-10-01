/**
 * @scene/server — 阶段提示词生成（由表定义注册表驱动）
 *
 * 旧实现把每张表的字段清单**手写**在提示词里（与契约、前端各写一遍，
 * 三处必然漂移——见 04 §1.1）。本版改为**从 `tables.ts` 注册表生成**：
 *   - 表定义（表号/名称/级别/行粒度/列/枚举/必填）→ 直接来自注册表
 *   - 输出契约的 `table_code` 枚举与 `fields` 合法字段名 → 由注册表派生
 *   - 产出行由 `@scene/domain` 的 `validateIncomingRows` 本地校验（补「契约空壳」）
 *
 * 阶段口径：**8 阶段（0-7）**——阶段 6 总结沉淀、阶段 7 最终交付物。
 * 旧编号的阶段 8（交付物）已合并为阶段 7；以 8 调用会抛出明确错误。
 */

import {
  STAGE_DEFS,
  TABLES,
  middleColumns,
  stageDef,
  supplementColumns,
  tablesOfStage,
  type InfoStageId,
  type StageId,
  type TableColumn,
  type TableDef,
} from "@scene/contract";

export interface StagePrompt {
  system: string;
  user: string;
  outputContract: Record<string, unknown>;
}

/** 新口径的阶段编号（0-7） */
export type InfoStage = InfoStageId;

/** 每阶段都适用的硬规则（信息版口径） */
const HARD_RULES = `## 硬规则（违反即视为缺陷）

1. **不产出判断**：不要给出任何结论或建议（例如是否该进入这个场景、我方是否做得成、值不值得投）——本产品只产出**信息**，判断由用户自己做。
2. **依据不足就填「未提供」**：禁止编造客户名、数字、标准号、厂商名称。
3. **每条信息必须带 source**：格式为 \`文件名:页码\`、\`文件名#章节\` 或 URL。
4. **推断必须留痕**：有材料依据的标 \`source_type = "AI提取"\`；无依据的合理推断标 \`"AI推断"\`。**不得自称「用户确认」或「用户补充」**——那两个状态只能由用户操作产生。
5. **场景要素以【场景锚】（表1-1）为准**：锚里没有的信息标"未提供"，禁止臆造。
6. **说人话**（G-R6）：通俗但不失专业，术语首次出现要解释。`;

/** 渲染单个列（用于字段清单） */
function renderColumn(c: TableColumn): string {
  const bits: string[] = [];
  if (c.required) bits.push("必填");
  else if (c.requiredWhen) bits.push(`条件必填：${c.requiredWhen}`);
  if (c.enum) bits.push(`枚举 ${c.enum}`);
  if (c.type === "longText") bits.push(`长文本，中栏截断 ${c.truncate ?? 20} 字`);
  if (c.type === "number") bits.push("数值");
  if (c.type === "ref") bits.push(`引用 ${c.refTable ?? "其他表"}`);
  if (c.note) bits.push(c.note);
  return `  - \`${c.key}\`（${c.label}）${bits.length ? "：" + bits.join("；") : ""}`;
}

/** 渲染一张表的完整定义（表号/名称/级别/行粒度/中栏列/右栏补充列/完整度规则） */
export function renderTableSpec(t: TableDef, category?: string): string {
  const lines: string[] = [
    `### ${t.code} ${t.name}（级别：${t.tier}；行粒度：${t.rowUnit}）`,
    `目的：${t.purpose}`,
  ];
  if (t.fixedRows) {
    lines.push("固定行（项 / 内容，逐行填写）：");
    for (const r of t.fixedRows) {
      lines.push(`  - ${r.label}${r.required ? "（必填）" : ""}${r.confirmRequired ? "（需用户确认）" : ""}`);
    }
  }
  const mid = middleColumns(t, category);
  if (mid.length) {
    lines.push("中栏列（表格主信息）：");
    for (const c of mid) lines.push(renderColumn(c));
  }
  const sup = supplementColumns(t, category);
  if (sup.length) {
    lines.push("右栏补充列（说明类信息，也要填）：");
    for (const c of sup) lines.push(renderColumn(c));
  }
  if (t.payloads) {
    lines.push("payload 按类别切换（category 取哪个就用哪组字段）：");
    for (const cat of Object.keys(t.payloads)) {
      lines.push(`  - ${cat}：` + t.payloads[cat]!.map((c) => c.key).join("、"));
    }
  }
  if (t.groupBy) lines.push(`分组维度：\`${t.groupBy}\`（不进列，按它分组）`);
  lines.push(`完整度规则：${t.completeness.map((c, i) => `${i + 1}) ${c}`).join(" ")}`);
  if ((t.filledInStages?.length ?? 0) > 1) {
    lines.push(`跨阶段填写：${t.filledInStages!.map((s) => `阶段 ${s}`).join("、")}（本次只填本阶段负责的列）`);
  }
  return lines.join("\n");
}

/** 渲染上游数据摘要（F2 上下文控制：只给本阶段需要的表） */
function renderUpstream(upstreamData: Record<string, unknown>): string {
  const sections: string[] = [];
  for (const [code, rowsRaw] of Object.entries(upstreamData)) {
    const rows = Array.isArray(rowsRaw) ? (rowsRaw as Record<string, unknown>[]) : [];
    if (rows.length === 0) continue;
    const t = TABLES.find((x) => x.code === code);
    const raw =
      t && middleColumns(t).length > 0
        ? middleColumns(t).map((c) => c.key)
        : Object.keys(rows[0] ?? {}).filter((k) => !["id", "scenario_id", "stage", "is_stale", "created_at", "updated_at"].includes(k));
    // 资料来源（主库 / 本场景 / 引用库）置首列：合并后仍可区分，模型引用时能说清出处
    const hasScope = rows.some((r) => typeof r["data_scope"] === "string");
    const keys = hasScope ? ["data_scope", ...raw.filter((k) => k !== "data_scope")] : raw;
    const header = (k: string): string => (k === "data_scope" ? "资料来源" : k);
    const head = `| ${keys.map(header).join(" | ")} |`;
    const sep = `| ${keys.map(() => "---").join(" | ")} |`;
    const body = rows
      .slice(0, 50)
      .map((r) => `| ${keys.map((k) => String(r[k] ?? "").replace(/\|/g, "/")).join(" | ")} |`);
    sections.push(`### ${code}${t ? " " + t.name : ""}（${rows.length} 行）\n${[head, sep, ...body].join("\n")}`);
  }
  return sections.length ? sections.join("\n\n") : "（暂无上游数据）";
}

/** 渲染场景锚（表1-1 当前内容） */
function renderAnchor(anchorRows: Record<string, unknown>[]): string {
  if (anchorRows.length === 0) return "（场景锚尚未填写——本次请只填有依据的项，其余留「未提供」）";
  const lines = anchorRows
    .filter((r) => String(r["content"] ?? "").trim() !== "")
    .map((r) => `- ${String(r["item"])}：${String(r["content"])}`);
  return lines.length ? lines.join("\n") : "（场景锚为空）";
}

/**
 * 构建阶段 prompt（system + user + outputContract）
 *
 * @param stage 阶段编号（0-7；旧编号 8 已合并为 7）
 * @param upstreamData 上游表数据（table_code → 行数组）
 * @param scenario 场景（名称与派生描述；场景锚行由 upstreamData["表1-1"] 传入）
 */
export function buildStagePrompt(
  stage: StageId,
  upstreamData: Record<string, unknown>,
  scenario?: { name: string; description?: string | null; brief?: string | null },
  /**
   * 限定本步要产出的表集（流程步的表集比阶段窄）
   *
   * 关键场景：阶段 1 的第 2 步（场景定义与边界）走"起草 + 用户确认"，
   * 第 3 步（认识场景）只做模型分析——**模型不该重复产出场景锚**。
   */
  opts?: { tables?: readonly string[] },
): StagePrompt {
  // StageId 已收窄为 0-7，但**运行期仍可能被塞进老编号 8**（老数据/老调用）：
  // 这里按数值比较主动拦截并给出可执行的修正提示
  if ((stage as number) === 8) {
    throw new Error(
      "阶段 8 已合并为阶段 7（8 阶段口径：6 总结沉淀、7 最终交付物）——请改用 0-7",
    );
  }
  const id = stage as InfoStage;
  const def = stageDef(id);
  const all = tablesOfStage(id);
  const tables = opts?.tables
    ? all.filter((t) => opts.tables!.includes(t.code))
    : all;

  const anchorRows = Array.isArray(upstreamData["表1-1"])
    ? (upstreamData["表1-1"] as Record<string, unknown>[])
    : [];

  const system = [
    `你是场景落地分析助手，当前处于**阶段 ${id} · ${def.name}**。`,
    "",
    `**本阶段要获得什么信息**：${def.goal}`,
    "",
    HARD_RULES,
    "",
    "## 本阶段要产出的表（严格按此填，字段名不得自创、不得少填必填列）",
    "",
    ...(tables.length
      ? tables.map((t) => renderTableSpec(t))
      : ["（本阶段无信息表——交付物由系统按章节 ← 表映射生成，不需要你填表）"]),
  ].join("\n");

  const user = [
    "## 场景诉求（第一输入，唯一基准）",
    scenario?.brief ? scenario.brief : `场景名称：${scenario?.name ?? "（未命名）"}`,
    "",
    "## 场景锚（表1-1，全链唯一场景定义；与之冲突的以锚为准）",
    renderAnchor(anchorRows),
    "",
    "## 上游数据（只给本阶段需要的，F2 上下文控制）",
    renderUpstream(upstreamData),
    "",
    "## 输出要求",
    "输出一个 JSON 对象：",
    "```json",
    '{"rows":[{"table_code":"<本阶段表号>","fields":{...},"source":"文件名:页码","source_type":"AI提取|AI推断"}]}',
    "```",
    `- \`table_code\` 只能取：${tables.map((t) => t.code).join("、") || "（本阶段无表）"}`,
    "- `fields` 的键必须来自对应表的列定义（含右栏补充列）。",
    "- 依据不足的列填空字符串或「未提供」，**不要编造**。",
  ].join("\n");

  return { system, user, outputContract: getStageOutputContract(stage, opts?.tables) };
}

/**
 * 阶段输出 JSON Schema
 *
 * 与旧版的区别（补「契约空壳」）：
 *   - `table_code` 的 enum 由注册表派生（不再手写）
 *   - `fields.properties` 列出**本阶段全部合法字段名**（模型不能自创键名）
 *   - `source_type` 限 `AI提取` / `AI推断`（模型不得自称用户确认）
 * 真正的一致性由 `@scene/domain` 的 `validateIncomingRows` 本地校验兜底。
 */
export function getStageOutputContract(
  stage: StageId,
  allowedTables?: readonly string[],
): Record<string, unknown> {
  if ((stage as number) === 8) {
    throw new Error("阶段 8 已合并为阶段 7——请改用 0-7");
  }
  const all = tablesOfStage(stage as InfoStage);
  const tables = allowedTables ? all.filter((t) => allowedTables.includes(t.code)) : all;
  if (tables.length === 0) {
    // 阶段 7（交付物）：不填表，产出两份文档
    return {
      type: "object",
      properties: {
        internal_report: { type: "string", description: "内部调研报告（Markdown）" },
        external_report: { type: "string", description: "对外汇报材料（Markdown）" },
      },
      required: ["internal_report", "external_report"],
    };
  }

  // 本阶段全部合法字段名（中栏 + 右栏补充 + payload），带中文标签说明
  const properties: Record<string, unknown> = {};
  for (const t of tables) {
    const all = [...t.columns, ...Object.values(t.payloads ?? {}).flat()];
    for (const c of all) {
      if (properties[c.key]) continue;
      properties[c.key] = {
        description: `${c.label}${c.enum ? `（枚举：${c.enum}）` : ""}${c.required ? "｜必填" : ""}`,
      };
    }
  }

  return {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          required: ["table_code", "fields", "source"],
          properties: {
            table_code: { type: "string", enum: tables.map((t) => t.code) },
            fields: {
              type: "object",
              description: "按 table_code 对应表的列定义填写（键名取自 properties 清单）",
              properties,
            },
            source: { type: "string", description: "文件名:页码 / 文件名#章节 / URL" },
            source_type: { type: "string", enum: ["AI提取", "AI推断"] },
          },
        },
      },
    },
    required: ["rows"],
  };
}

/** 阶段元信息（供服务端与前端复用，避免各处硬编码阶段名） */
export function stageMeta(): readonly { id: number; name: string; goal: string; tables: string[] }[] {
  return STAGE_DEFS.map((s) => ({
    id: s.id,
    name: s.name,
    goal: s.goal,
    tables: [...tablesOfStage(s.id).map((t) => t.code)],
  }));
}
