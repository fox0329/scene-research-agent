/**
 * @scene/server — 阶段提示词生成（由表定义注册表驱动）
 *
 * 旧实现把每张表的字段清单**手写**在提示词里（与契约、前端各写一遍，
 * 三处必然漂移——见 04 §1.1）。本版改为**从 `tables.ts` 注册表生成**：
 *   - 表定义（表号/名称/级别/行粒度/列/枚举/必填）→ 直接来自注册表
 *   - 输出契约的 `table_code` 枚举与 `fields` 合法字段名 → 由注册表派生
 *   - 产出行由 `@scene/domain` 的 `validateIncomingRows` 本地校验（补「契约空壳」）
 *
 * 阶段口径：**7 阶段（0-6）**——阶段 1-5 是分析步，阶段 6 是最终交付物（系统组装，不填表）。
 * v1.31 删掉原阶段 6「总结沉淀」（只产表7-1，且回写没有执行路径），交付物由阶段 7 收到阶段 6；
 * 老编号 8（交付物）与老编号 7（总结沉淀）都以 8/7 调用会被拦下并给出可执行的修正提示。
 */

import {
  STAGE_DEFS,
  TABLES,
  enumValues,
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

1. **不给决策建议，但每条信息必须由你核实**（用户定调 v1.27：「你的输出要核实客观性……对每一条信息问几个问题，这准确吗、客观吗？为什么准确，为什么客观。**不是要提示**，告诉用户来源准不准」）：
   - **不给决策建议**：不写「该不该进这个场景」「值不值得投」「建议先做哪一步」——决定由用户自己做。
   - **必须核实**：**每一条信息**都要自己回答三个问题，并写进 \`verification_verdict\` + \`verification\` 两列——**这准确吗？客观吗？为什么准确、为什么客观？**
     - **准确**：对得上哪份材料的哪一处（\`文件名:页码\`）、数值能不能复算、有没有反例或互相矛盾的地方（有就写出来）。
     - **客观**：这条是**事实记录**还是**你的推断/行业通例**；是谁的口径（客户台账 / 厂商宣传 / 第三方评测）；**有没有利益相关方在替自己说话**。
     - **为什么**：凭什么采信（材料原文、多源同向、可复算、可交叉验算），哪里还不确定。
   - \`verification_verdict\` 六选一，**按信息性质选**（选错等于把行情作废或把推断当事实）：
     \`已核实\`（本客户事实，材料能直接对上、数值可复算）｜\`交叉一致\`（≥2 处独立来源同向）｜
     **\`行业通例\`（行业公开常识/通行做法：可以自证——公开可查、无利益相关方，但不是本客户事实）**｜
     \`单一来源\`（本客户事实只有一处材料、无第二来源）｜
     \`无法核实\`（**只限这两种**：本客户具体事实材料里没有；或材料冲突到判不了）｜
     \`有反证\`（材料之间互相矛盾，冲突点写进核实说明）。
     **注意**：按行业通例口径写的信息（\`source_type="AI推断"\`、\`source="行业通例（模型知识）"\`）一律给 **\`行业通例\`**，
     **不许写「无法核实」**——行情是能自证的；「无法核实」只留给"本客户事实缺材料"。
   - **禁止把核实推给读者**：不许写「待核实」「建议抽查」「来源待确认」「请用户核实／请用户确认」——**核实没做完就是你没做完**；写不出来就如实给 \`无法核实\` 并说明缺什么。
   - **产出后你还会被三问自检**（v1.28 G-R8）：写完这批行，系统会立刻对**每一条**再问三轮「这真实吗？客观吗？有价值吗？」，
     并**真查材料库**（\`文件名:页码\` 必须能在材料里找到，且那一页确有这句话）。所以：
     - 出处必须**能定位**：给不出\`文件名:页码\`就不要标 \`AI提取\`，也不要挂 \`已核实\`（自检会把对不上的出处挑出来，三轮还改不掉就按实降级为\`无法核实\`）。
     - 措辞必须**可被反驳**：不写「最好／唯一／必然／彻底解决／零门槛」这类绝对化、营销化表述（自检会点名这些词）。
     - 价值必须**可验证**：收益类条目要给出指标 + **本客户基线**；材料里没有基线就写「未提供（本客户材料未含）」，不要拿行情数字假装成客户的现状。
2. **分清「本场景的具体事实」与「行业公共知识」——两者要求相反，别搞混**：
   - **本场景/本客户/我方的具体事实**（客户与供应商真名、本项目预算与报价、具体标准号与证书编号、某公司的内部情况、材料页码）：**没有材料依据就写「未提供」，这类禁止编造**。
   - **行业公共知识**（产业链由哪些环节构成、各环节常见毛利量级、市面有哪几种主流方案形态与主导厂商、通行的采购与决策机制、行业门槛与监管方向、技术趋势与时间窗口、行业里公认的厂商名）：**必须用你自己的行业知识写出来**——这是你该给用户的行情，**不许整列留「未提供」、不许把问题退回给用户**。写法：\`source_type="AI推断"\`、\`source="行业通例（模型知识）"\`、\`evidence_level="C"\`、\`authority="T4"\`。**不要把来源标记写进内容**——用户定调「要谁去核实？没必要写」：格子里只放信息本身，来源属性一律写在这三列；\`authority="T4"\` 本身就是「待验证」，不必在每一格里复述。
   - 判据：一句"××行业里公开的行情/常识"就能说清的是**行业知识**（要写）；只有查了这家客户/这个项目才知道的是**具体事实**（可留「未提供」）。
3. **每条信息必须带 source**：有材料依据的写 \`文件名:页码\` / \`文件名#章节\` / URL；行业通例写 \`行业通例（模型知识）\`。
4. **推断必须留痕**：有材料依据的标 \`source_type = "AI提取"\`；无依据的合理推断标 \`"AI推断"\`。**不得自称「用户确认」或「用户补充」**——那两个状态只能由用户操作产生。
5. **场景要素以【场景锚】（表1-1）为准**：锚里没有的**场景本体信息**标"未提供"，禁止臆造（行业行情不受此限，按第 2 条写）。
6. **说人话**（G-R6）：通俗但不失专业，术语首次出现要解释。
7. **中栏说结果，来源归右栏**（用户定调 v1.32：「中栏的表格要说价值，说结果，来源、引用什么的可以放到右栏」
   「大量的文字在说明来源」）：
   - **中栏格子只写结果**：谁、做什么、多少、能不能、意味着什么——**先结论、后理由，一格一句话**。
     建议 ≤40 字；**超过 60 字算超标**（自检会点名压回）。
   - **中栏里不许出现任何出处/引用痕迹**：文件名、\`ingest-…\`、\`.pdf:页码\`、\`M1\`–\`M6\`/\`O1\`–\`O6\`、
     「来源：」「出处：」「材料显示」「文档未说明」「未见材料」「按 XX 白皮书」——**一句都不许**。
     出处写右栏 \`source\`；证明材料／判断依据写右栏 \`proof\`；核对过程写右栏核实说明。
   - **不许用文字代替数字**：数值列给数字（口径/假设写在右栏），不许写「约几万元」「若干人天」。
   - 缺材料时：中栏**不写**"材料里没有"，只在右栏核实说明里如实标注。`;

/**
 * 阶段专属口径（只在该阶段追加进 system）
 *
 * 为什么需要它：第 3 步（理解商业）产出的是**行业行情**——毛利、玩家、采购机制、
 * 门槛、趋势。这些是模型本来就该知道的公共知识，可硬规则里的「不许编造厂商名/数字」
 * 让它整列写「未提供」，等于把市场调研退回给用户（用户原话：「你全都不填，要用户
 * 自己填吗？」）。这里把该阶段的判定口径写死：行情必须写满并标 C/T4（待验证由 authority 列表达）。
 */
const STAGE_NOTES: Partial<Record<InfoStage, string>> = {
  1: `## 本阶段重点：只写这个场景**现在是什么样**

本阶段回答的是**场景现状**，不是我们的产品能不能做。写成"谁在做、用什么做、现在怎么做、卡在哪"：
现有系统与设备、现有流程与频次、现有责任归属、现在的人工/纸质环节、已有的认证与合规现状。

**禁止出现**「我方／我们／公司／我们的产品／我司能力／切入点／优势／劣势／该不该做／能不能做」——
公司能力要到**阶段 3（能力匹配）**才进场（那时会有表4-2 我方参与地图专门回答能不能碰、以什么角色参与）。
本阶段任何一行里出现我方视角，都算缺陷。`,
  2: `## 本阶段重点：市场行情必须由你写出来（不许退回给用户）

本阶段回答的是**行业行情**，不是"这家客户的具体底牌"。下面每一类都要给出内容；
没有材料依据的一律按行业通例口径写（\`AI推断\` + \`行业通例（模型知识）\` + \`C\` + \`T4\`）：

- **表3-1 利润池**：产业链有哪些环节（芯片/模组 → 终端硬件 → OS 与平台 → 集成实施 → 运营服务 等）、每个环节的**常见毛利区间或量级**（如"硬件 15–30%""软件 60%+"，禁写"较高/较低"）、该环节**代表性的厂商类型与典型厂商**（写行业里公开的玩家名）。
- **表3-2 方案形态**：市面有哪几种打法（传统集成 / 云 SaaS / 平台化 / 信创国产化 等）、每种打法的要点、**主导者是谁**（哪一类厂商在主导，能写厂商名就写）、当前地位（主流/新兴/衰退）、**这种打法适合什么客户与什么预算档**。
- **表3-3 采购机制**：不同客户类型（政企/国企集团/民营/园区 等）的决策角色、使用角色、付费方、默认选择、预算科目、采购方式与决策周期。
- **表3-4 竞争对手对照**：≥3 家公开可查的竞品（写厂商/产品名），按 ≥3 个维度对照——**只写对手之间谁强在哪**，不写我方（我方与对手的对照在阶段 3 表4-5）。
- **表3-6 替代方案**：这个场景客户手上还有什么可选项（必须含"什么都不做"）、客户得到什么、成本结构、**价格量级**（区间或估算口径，标"估算"）、**谁在用、什么条件下选它**。
- **表3-5 上游供给格局**：这个场景的上游分成哪几环（关键器件 / 基础软件 / 集成服务…），每环是谁在供、集不集中、能不能换、议价权在谁、最容易被卡在哪（交期/产能/单一来源/认证绑定/国产替代）。**只写这个市场现在的供给事实**，不写我方能不能搞定。
- **表3-7 同行踩过的坑**：这类项目同行踩过什么坑——**坑**写具体场面（谁在哪个环节干了什么、出了什么事），**后果**落到钱/工期/安全，**我们方案里怎么避**写成可验收的硬指标或交付条款（如「验收含批量交付节拍」「合同写明变更控制」），不写「加强管理」「提高意识」这类空话。
- **表3-8 未满足需求**：行业里普遍存在、现有方案普遍没解决的需求缺口。
- **表3-9 行业趋势**：政策/技术/需求趋势 + 驱动力 + **对场景各方（客户、在位供应商）的影响** + **具体时间窗口**（如"2025–2027 年"）。

只有"这一家客户/这一个项目"的具体事实（他们的预算、他们的决策人姓名、他们已有的系统型号）才允许留「未提供」。

**同样禁止出现我方视角**（「我方／我们／公司的产品／切入点／优势／劣势」）——本步是**市场侧**的梳理：
钱在哪个环节、市面有哪几种打法、客户怎么买、对手什么水平、缺口在哪、趋势往哪走。
我方与这些行情怎么对上，是**阶段 3（能力匹配）**的活（表4-2 我方参与地图、表4-4 细分优先级、表4-5 竞争力判断）。`,
  3: `## 本阶段重点：公司能力从这里进场

前三步（场景定义 / 认识场景 / 商业梳理）只梳理了场景与市场，本阶段才把**公司能力**放进来对照：

- **表4-2 我方参与地图**：逐个业务环节（对齐表1-2）判定我方可参与程度与角色，依据必须引自
  M3 能力清单 / M4 边界声明 / M5 已知限制的具体条目——这几张表**只在本阶段及之后**才会给你。
- **表4-3 需求-能力对照**：把表3-8 的每条缺口与 M3 能力逐条对上，写清匹配判定与边界说明。
- **表4-4 细分优先级**：把表3-2 的市场形态、表3-9 的趋势与我方能力对起来，给出切入与排序。
- **表4-5 竞争力判断**：与表3-4 的竞品、表3-6 的替代方案逐维度比，给出赢面评分与依据
  （「我方优势／劣势／对我方意味着什么」都写在这里）。

口径：涉及**我方能力**的判断必须能回溯到 M1–M6 的具体条目；没有对应能力就如实写「需补齐」「不能做」，
不许拔高。

**中栏说结果**（本阶段用户点名的重点）：
- **表4-1 能力底账**：中栏三列就回答三件事——\`ability\` 有什么能力（写产品/型号/能力名，不写材料名）、
  \`maturity\` 到什么程度、\`limitation\` 边界在哪（一句话："依赖 X，缺 Y 时做不到 Z"）。
  **证明材料 \`proof\` 属引用，已移到右栏**，不要往中栏塞。
- **表4-2 角色判定依据 / 表4-3 边界说明 / 表4-5 打分依据**：写**判断理由**，不写材料出处——
  一句话说清"凭什么"（如"我方 CT15 系列 IO 控制器已量产交付，可覆盖现场点位"），
  **不许**出现文件名、页码、"据 M3"之类字样（出处写右栏 \`source\`）。
- **依据列里不许有废话**（用户定调 v1.32：「角色判定依据 里面有不少的废话」）：
  ① **不复述结论**——"属外围配合""只能配合""属辅助"这类话，前面「程度/角色」两列已经说了；
  ② **不写行业套话**——"通常由第三方软件承载""一般由专业厂商提供"换谁都成立，等于没给依据。
  要写就写**我方有什么/没有什么**（产品、型号、已交付能力、明确不具备的能力、端层限制）。
- 每条都要能被人一句话复述：**能不能做、做到什么程度、边界在哪**。`,
  4: `## 本阶段重点：把方案说到"能落地、能验收、能算钱"

本阶段回答的是**怎么干**：架构长什么样、接口有哪些、分几步、多少钱、交付后怎么运维。
每一格都写结果，不写过程与出处（出处归右栏）：

- **表5-1 架构与接口**：只写三件事——**方案全貌**（分层 + 组件/设备 + 接口协议）、
  **与既有系统怎么对接**、**边界声明（不做什么）**。**本表不写工作量**（v1.32 已删「适配工作量」列）：
  口径不统一、且容易和表5-3「人天」打架；**人天只写表5-3**，估算假设写在右栏。
- **表5-3 实施计划**：\`content\` 一句话说清"做什么、做完是什么样"（≤40 字，不写材料名与页码）；
  \`man_days\` **必须给数字**（量级估算也可以，但口径写右栏）；\`rollback\` 写可执行的退路，不写"做好备份"。
- **表5-4 交付与运维**：\`SLA\` 写**可验收的量化承诺**（可用率、响应时长、恢复时长、备件到货时长），
  **不写**"及时响应""快速处理""有保障"这类空话。
- **表5-5 成本估算**：每块都要落到数字（数量 × 单价 = 小计、工时 × 人天单价 = 费用），
  估算口径与假设写右栏，**不写进中栏的项目/型号格**。
- 出现我方产品时写型号（如 CT15/CT32），不写"我司产品"。`,
};

/** 每阶段都适用的硬规则（信息版口径） */

/** 渲染单个列（用于字段清单） */
function renderColumn(c: TableColumn): string {
  const bits: string[] = [];
  if (c.required) bits.push("必填");
  else if (c.requiredWhen) bits.push(`条件必填：${c.requiredWhen}`);
  // 枚举必须把**合法取值**写出来：只给枚举名（如 level_hml）时模型会自己编
  // （实机把「痛到什么程度」写成 high/mid/low、把门槛类型写成「资质门槛」——共 61 处非法值）
  if (c.enum) bits.push(`枚举 ${c.enum}，只能取：${enumValues(c.enum).join(" / ")}`);
  // 中栏**不截断**（用户定调 2026-09-26），所以别再告诉模型"会被截断"——它照写长文，用户就得逐字看
  if (c.type === "longText") bits.push("长文本，中栏不截断（整段都会显示，按 G-R9 压成一句话）");
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
      lines.push(
        `  - ${r.label}${r.required ? "（必填）" : ""}${r.owner === "用户" ? "（用户输入）" : ""}`,
      );
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
    // 资料来源（本场景 / 主库）置首列：合并后仍可区分，模型引用时能说清出处
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

/** 兄弟表清单（表号 + 名称 + 目的），供按表并发生成时对齐口径 */
function siblingSpec(codes: readonly string[]): string {
  return codes
    .map((code) => {
      const t = TABLES.find((x) => x.code === code);
      return t ? `${t.code} ${t.name}（${t.purpose}）` : code;
    })
    .join("；");
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
  opts?: {
    tables?: readonly string[];
    /**
     * 本步的其它表（按表并发生成时用）
     *
     * 并发的代价是失去"一次看到整步"的视野：这里把兄弟表名列出来，让模型知道
     * 同一批还有哪些表、口径要一致（如要素间关系引用的要素名要与要素清单一致），
     * 同时明确要求**不要产出它们**。
     */
    siblings?: readonly string[];
  },
): StagePrompt {
  // StageId 已收窄为 0-6，但**运行期仍可能被塞进老编号 7/8**（老数据/老调用）：
  // 这里按数值比较主动拦截并给出可执行的修正提示
  if ((stage as number) === 7 || (stage as number) === 8) {
    throw new Error(
      "阶段 7/8 都是老编号：总结沉淀（老 6）已删除，交付物现为阶段 6——请改用 0-6",
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
    ...(STAGE_NOTES[id] ? [STAGE_NOTES[id]!, ""] : []),
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
    ...(opts?.siblings?.length
      ? [
          `- 本步的其它表（**由并行的另一次调用产出，你不要产出它们**，但口径要与它们一致：` +
            `同一批信息里怎么称呼客户、环节、要素、竞品，就用同样的名字）：${siblingSpec(opts.siblings)}`,
        ]
      : []),
    "- `fields` 的键必须来自对应表的列定义（含右栏补充列）。",
    "- 依据不足的列填空字符串或「未提供」——**只对「本场景的具体事实」成立**；行业行情类列（毛利、玩家、采购机制、门槛、趋势、价格量级）必须按行业通例口径写满，不许留空。",
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
  if ((stage as number) === 7 || (stage as number) === 8) {
    throw new Error("阶段 7/8 都是老编号（总结沉淀已删除、交付物现为阶段 6）——请改用 0-6");
  }
  const all = tablesOfStage(stage as InfoStage);
  const tables = allowedTables ? all.filter((t) => allowedTables.includes(t.code)) : all;
  if (tables.length === 0) {
    // 阶段 6（交付物）：不填表，产出两份文档
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
        description: `${c.label}${
          c.enum ? `（枚举 ${c.enum}，只能取：${enumValues(c.enum).join(" / ")}）` : ""
        }${c.required ? "｜必填" : ""}`,
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
