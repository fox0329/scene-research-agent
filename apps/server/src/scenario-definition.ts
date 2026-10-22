/**
 * @scene/server — 场景定义（对话式）
 *
 * 用户定调（2026-09-26 定稿）：
 *   "用户只负责输入场景名称，智能体只负责从业务角度说清楚场景的范围"
 *   "拍板者、使用者、付费者这些信息都应该是用户提供的吗？用户什么都知道还要我们干什么？"
 *
 * 所以流程第 1 步的**属主划分**是：
 *   - **用户只给「场景名称」**（也可以顺手说范围/客户，说了就采纳）
 *   - **智能体写出其余 5 项业务画像**：场景边界 / 生产对象 / 核心生产系统 /
 *     买方类型 / 采购特征——参照"燃气场站"那份定义的写法
 *   - 「确认无误」是**一次整表确认**，且**不卡推进**
 *
 * 三条硬规则：
 *  1. **只在用户点「整理成定义」时才写表**（不自动增量改用户的表）
 *  2. 整理时**保留用户已确认的行**（用户的决定优先）
 *  3. 模型只能标 `用户补充`（转述用户原话）或 `AI推断`（自己写的画像）——
 *     **`用户确认` 永远只能由用户动作产生**
 *
 * 推断 ≠ 判断：写业务画像是**可核查的事实性推断**（产品价值所在）；
 * "能不能做 / 值不值得"才是判断（产品禁止产出）。
 */

import {
  TABLES_BY_CODE,
  type AnchorRow,
  type DshClient,
  type Scenario,
  type SessionHandle,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { extractFirstJson } from "./json-extract.js";
import {
  anchorAgentRows,
  anchorFixedRows,
  anchorUserRows,
  mergeAnchorRows,
  type InfoRow,
} from "@scene/domain";
import {
  ensureAnchorRows,
  readAnchorRows,
  readBrief,
  upsertBrief,
  writeAnchorRows,
  syncDerivedDescription,
} from "./scenario-anchor.js";

const ANCHOR = "表1-1";

/**
 * 场景定义对话的系统提示词
 *
 * 关键约束（都来自产品原则）：
 *  - **只谈场景本体**，不谈产品/方案/技术选型（那些是后续阶段的事）
 *  - 每轮：先给我的理解（2-4 句），再提 **最多 3 个**问题——不要一次问一堆
 *  - 用户说不知道就跳过，标为待定，**不追问**
 *  - 不提"能不能做/值不值得"这类判断（产品只产出信息）
 */
export const DEFINITION_SYSTEM = `你是「场景通」的场景定义助手。用户给了一个场景名称，你要**替他写出一份场景业务画像**——
把"这个场景在业务上到底是什么"讲清楚，让他一眼就能看出你懂不懂这个行业。

## 核心心态（用户定调，务必遵守）
用户原话：「用户只负责输入场景名称，智能体只负责从业务角度说清楚场景的范围」
「拍板者、使用者、付费者这些信息都应该是用户提供的吗？用户什么都知道还要我们干什么？」
所以：
- **不要把"客户是谁""覆盖什么""谁是拍板者"当问题去考用户**——这些正是你该查、该写出来的；
- 你的交付是**业务画像**：场景边界 / 生产对象 / 核心生产系统 / 买方类型 / 采购特征；
- **允许抽象、允许说不准**：用户很多时候还说不准，概括着写比追问细节有用；
- **不要给判断**：不写"能不能做 / 值不值得 / 建议……"——产品只产出信息。

## 画像的写法（参照「燃气场站」，这就是验收标准）
场景边界｜城市燃气门站、调压站/箱、LNG 储备站、CNG/LNG 加气站、管道分输站、工业用户专用站等
生产对象｜天然气的接收、过滤、计量、调压、加臭（可选）、储存/气化、输送或充装；以及为保障安全运行所需的检测、切断、消防、视频与运维
核心生产系统｜工艺装置 + 站控（PLC/RTU/SCADA）+ 安全仪表与消防 + 调度/信息化平台 + 运维作业
买方类型｜全国性城市燃气运营商（城燃集团）、地方燃气公司、长输/管网企业、大型工业用户自管站
采购特征｜集团技术规范 + 集采/供应商名录 + 区域项目实施；新建/改造多为项目制招标，运维与安全检查形成持续预算
要点：**一行一项、用顿号和分号串起来、可枚举的具体对象写清楚、每格 ≤ 60 字**。

## 每一轮回复的结构
**先判断这是第几轮：看消息里的【对话历史】块——没有历史 = 第一轮；有历史 = 后续轮。**

### 第一轮（**把画像直接写出来，这是你的主要交付**）
1. 用紧凑格式给出 5 项业务画像草稿，一项一行：\`场景边界｜……\`（照上面的写法，直接可落表）。
   依据不足的项写"（待研究）"，**不要空着不写**——空着等于没干活。
2. 然后提**最多 2 个**问题，且**只问只有用户才知道的取舍**，例如：
   - "你这边的范围要不要把 XX 也算进来？"
   - "重点看新建项目，还是存量改造？"
   **禁止**问"客户是谁""覆盖什么""谁是拍板者"这类你自己就该写出来的。

### 第二轮起（**必须短**）
- **不要重复已经写过的画像内容**——用户已经看过了，重复就是噪音
  （曾因此被用户投诉"整个页面大量的无效信息"，此为硬约束）。
- 只回 **1–2 句**：① 只写**变化的部分**——"那我调整一下：……"；② 最多 **1 个**问题。
- **整轮 ≤ 120 字**。用户答得短（"都包括""工业水厂为主"）是正常的，**直接接受并收口**。
- **说「够了」前先问完最后一个会改变表1-1的取舍**（如单站试点还是整线批量、新建还是改造）：没有问就再问 1 个，不要一边收口、一边等「整理成定义」完成后再冒出新问题。
- 用户说清楚了就说"够了，点『整理成定义』就行"。

## 铁律
- **只谈行业与场景本体**：不要谈具体产品、型号、厂商、技术选型、方案架构——那是后续阶段的事。
- **不要给判断**：不写"能不能做/值不值得/建议……"。
- **不要追问边界**：不要反复问"明确不含什么"；用户没提就按行业通例写出范围即可。
- 用户说"不知道/不清楚/大概吧/还没想好"→ **接受并继续**，不要把同一个问题换个说法再问。
- **不要编造具体客户名、数字、标准号**；依据不足就写"（待研究）"或"一般为……"（标明是通例）。
- **例外：用户亲口给出的数字与范围不是编造**——楼栋数、员工数、访客量、等待时长、预算、上线时间、现有系统等，必须原样保留并复述，不许改写成"行业口径/量级待确认"。
- **不要写自我说明**：正文里不要出现"（用户未明说）""按行业通行情况推断"这类注解——
  谁说的由系统在表格来源字段里表达，不要写进正文。
- 说人话，术语首次出现要解释；**宁可短，不要长**。
- 用户没主动提就**不要**输出任何 JSON 或"定义块"——整理成表由用户点「整理成定义」触发。`;

/** 单个定义格的字符上限（超出即按句界截断；定义要的是"一句话"，不是段落） */
export const DEFINITION_CELL_MAX_CHARS = 80;

/** 定义整理时给模型的任务（要求严格 JSON） */
const CONSOLIDATE_TASK = `请把上面的对话**整理成表1-1 场景业务画像**（固定项清单见上）。

要求：
0. **用户说过的事实优先级最高**：对话里用户给出的具体数字（楼栋数、人数、访客量、等待时长、预算、上线时间）、范围、现有系统/流程，必须原样写进对应项，**不得**改写成"行业口径/量级待确认"；这些是用户提供的事实，不是编造。用户没说的部分才用行业推断；同一项两者都有时，先写用户事实，再补"行业一般为……"。
1. **优先用 \`item_key\`**（清单里每项前面的英文名，如 \`scene_boundary\`）——中文标签容易写错导致对不上。
2. **「场景名称」只收用户说过的**（\`source_type\` = \`"用户补充"\`）；用户没给名字就沿用场景名，不要编。
3. **其余 5 项业务画像是你的活，要写满**（\`source_type\` = \`"AI推断"\`，\`source\` 写 \`"行业通例"\`）：
   - 依据：对话里用户说过的内容 + 你对这个行业的认识；
   - 参照写法（燃气场站）：场景边界=可枚举的场站类型；生产对象=工艺过程 + 安全/运维；核心生产系统=工艺装置 + 站控 + 安全仪表 + 调度平台 + 运维作业；买方类型=谁会买（客户类型）；采购特征=怎么买（规范/集采/项目制/持续预算）；
   - 用户明确说过的部分**用用户的原话**，不要改写。
4. **每格 ≤ 80 字，写成一行短语**——顿号/分号串起来，**不是段落**；用户事实与字数冲突时，**先保数字，删行业补充**：
   - 不要写"①…②…③…"这种枚举，也不要写"（用户未明说）""按行业推断"这类**自我说明**；
   - 拿不准的格子写"（待研究）"，**不要留空**。
5. 宁可概括、不要编造：**用户没给**的具体客户名、数字、标准号不要编；用户给了的必须原样保留。行业通例可以写，用"一般为……"表述。
6. \`item\` 必须严格取自上面的固定项清单（不得自创、不得改字）。
7. 如果对话里能看出"用户想搞清楚什么"，把它放进 \`intent\`（没有就留空字符串）。
8. \`open_questions\` 只放**仍然没问清、且只有用户能回答的场景边界/范围取舍**（如单站试点还是整线批量），最多 2 个；
   **不要问**现有系统/平台/厂商/技术选型/对接/接口/预算/工期（这些由后续调研负责）。
   如果对话最后一轮已经说「够了」或已明确收口，\`open_questions\` **必须为空数组**，不许再冒新问题。`;

const CONSOLIDATE_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "content", "source_type"],
        properties: {
          item_key: {
            type: "string",
            description: "固定项的英文 key（**优先用这个**，必须严格取自清单，如 customer_type）",
          },
          item: { type: "string", description: "固定项中文名（item_key 不确定时才用）" },
          content: { type: "string" },
          source_type: {
            type: "string",
            enum: ["用户补充", "AI推断"],
            description:
              "用户说过的用 用户补充；智能体自己写的业务画像用 AI推断（这是本职工作，不要留空）",
          },
          source: { type: "string", description: "出处（如 对话、行业通例、产品资料）" },
        },
      },
    },
    intent: { type: "string", description: "用户想搞清楚什么（看不出就留空）" },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["items", "open_questions"],
};

/**
 * 构建定义对话的上下文（追加在用户消息前）
 *
 * 让模型知道：场景名、表1-1 现在的填写情况（哪些已定、哪些还空）——
 * 这样它只补空缺、不重复问已经明确的项。
 */
export function buildDefinitionContext(db: DbInstance, scenario: Scenario): string {
  const byItem = new Map(readAnchorRows(db, scenario.id).map((r) => [r.item, r]));
  const lines = anchorFixedRows().map((r) => {
    const row = byItem.get(r.label);
    const content = String(row?.content ?? "").trim();
    const state =
      content === "" || content === "未提供"
        ? "【还空着】"
        : String(row?.source_type ?? "") === "用户确认"
          ? "【用户已确认】"
          : String(row?.source_type ?? "") === "用户补充"
            ? "【用户说的】"
            : "【智能体推断】";
    const owner = r.owner === "用户" ? "（用户输入）" : "（你负责写）";
    return `- ${r.label}${owner}：${content || "（空）"} ${state}`;
  });
  const brief = readBrief(db, scenario.id);
  return [
    "【当前场景】",
    `场景名称：${scenario.name}`,
    brief?.intent ? `用户想搞清楚什么：${brief.intent}` : "用户想搞清楚什么：（尚未说明——请通过提问了解）",
    "",
    "【表1-1 场景定义现状】（只补空着的项，已确认的不要改）",
    ...lines,
    "",
  ].join("\n");
}

/** 解析整理结果（容错：模型可能带代码块或前后缀） */
function parseConsolidation(text: string): {
  items: { item?: unknown; content?: unknown; source_type?: unknown; source?: unknown }[];
  intent?: unknown;
  open_questions?: unknown;
} | null {
  const candidates = [text.trim()];
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block?.[1]) candidates.push(block[1].trim());
  /* 模型可能先给一段说明、或在合法 JSON 后面又跟一份（Extra data）：
     按括号配对取第一个完整对象，别让整表因为"后缀"作废（故障清单 #65） */
  const first = extractFirstJson(text);
  if (first !== null) candidates.push(JSON.stringify(first));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as {
        items?: unknown;
        intent?: unknown;
        open_questions?: unknown;
      };
      if (Array.isArray(parsed.items)) return { ...parsed, items: parsed.items as never[] };
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 规范化项名：去空白、统一分隔符（用于容错匹配模型输出的中文标签） */
function normalizeLabel(text: string): string {
  return text
    .replace(/[\s/、·・,，;；:：()（）\[\]]/g, "")
    .replace(/行业|类型|环节/g, (m) => m) // 保留语义词，仅做去噪
    .trim();
}

/**
 * 项名 → 固定行 key 的查找表
 *
 * 为什么需要：模型输出的中文标签常与注册表**不完全一致**
 * （如「客户类型」vs「客户类型/行业」、「不含什么」vs「明确不含什么」）。
 * 早期实现用精确标签匹配，导致产出行被**静默丢弃**——真机联调时表现为
 * "整理成定义后 L1 全空"，而 used_llm=true（只有「场景名称」侥幸匹配）。
 * 因此改为：**优先 item_key**，其次规范化标签匹配。
 */
/**
 * 中文别名表（模型常用近义改写）
 *
 * 为什么用**显式别名**而不是模糊打分：这一步会写进用户的场景定义，
 * 宁可漏匹配（记为 dropped 暴露出来）也不要猜错。别名表确定性、可审计、可测试。
 */
const ITEM_ALIASES: Readonly<Record<string, string>> = {
  场景名称: "scene_name",
  场景: "scene_name",
  场景边界: "scene_boundary",
  边界: "scene_boundary",
  覆盖什么: "scene_boundary",
  覆盖范围: "scene_boundary",
  场景范围: "scene_boundary",
  范围: "scene_boundary",
  生产对象: "production_object",
  对象: "production_object",
  生产资料: "production_object",
  核心生产系统: "core_systems",
  生产系统: "core_systems",
  核心系统: "core_systems",
  买方类型: "buyer_type",
  买方: "buyer_type",
  客户类型: "buyer_type",
  客户: "buyer_type",
  采购特征: "procurement",
  采购: "procurement",
  采购方式: "procurement",
  采购特点: "procurement",
};

function buildItemResolver(): (raw: { item_key?: unknown; item?: unknown }) => string | null {
  const byKey = new Map<string, string>();
  const byLabel = new Map<string, string>();
  for (const r of anchorFixedRows()) {
    byKey.set(r.key.toLowerCase(), r.key);
    byLabel.set(normalizeLabel(r.label), r.key);
  }
  const byAlias = new Map(Object.entries(ITEM_ALIASES).map(([k, v]) => [normalizeLabel(k), v]));

  return (raw) => {
    /* 提示词里一个项同时给了 item_key（`scene_name`）和中文名（「场景名称」），
       模型把哪个写进哪个字段都不一定。旧实现只认「item_key 字段=键、item 字段=中文名」，
       模型一旦把键填进 item（实测 deepseek-flash 就这么干），6 项全被判"匹配不到"丢弃 →
       表1-1 一片空白（故障清单 #63）。所以两个字段都按"键 → 中文名 → 别名"各认一遍。 */
    for (const value of [raw.item_key, raw.item]) {
      const v = String(value ?? "").trim();
      if (!v) continue;
      const lower = v.toLowerCase();
      if (byKey.has(lower)) return byKey.get(lower)!;
      const norm = normalizeLabel(v);
      if (byLabel.has(norm)) return byLabel.get(norm)!;
      if (byAlias.has(norm)) return byAlias.get(norm)!;
    }
    // 最后兜一层：子串/超串（如「覆盖率」≈「覆盖什么」）
    const norm = normalizeLabel(String(raw.item ?? raw.item_key ?? ""));
    if (!norm) return null;
    for (const [n, k] of byLabel) {
      if (n && (n.includes(norm) || norm.includes(n))) return k;
    }
    return null;
  };
}

export interface NormalizeResult {
  rows: AnchorRow[];
  /** 未能匹配到固定项的原始项名（用于暴露问题，而不是静默丢弃） */
  dropped: string[];
}

/**
 * 把模型输出收敛成合法锚行
 *
 * - `用户确认` 一律不接受（只能由用户动作产生）
 * - `source_type` 只认 `用户补充` / `AI推断`（其余一律按 `AI推断` 处理）
 * - 空内容不落行
 */
export function normalizeConsolidatedItems(payload: {
  items: {
    item_key?: unknown;
    item?: unknown;
    content?: unknown;
    /** 模型偶尔把正文放在 value 里（尤其没拿到 JSON Schema 时），按 content 的同义词收 */
    value?: unknown;
    source_type?: unknown;
    source?: unknown;
  }[];
}): NormalizeResult {
  const resolve = buildItemResolver();
  const byKey = new Map(anchorFixedRows().map((r) => [r.key, r]));
  const rows: AnchorRow[] = [];
  const dropped: string[] = [];

  for (const raw of payload.items ?? []) {
    const key = resolve(raw);
    const name = String(raw.item ?? raw.item_key ?? "").trim();
    if (!key) {
      if (name) dropped.push(name);
      continue;
    }
    const content = String(raw.content ?? raw.value ?? "").trim();
    if (content === "" || content === "未提供") continue; // 空内容不落行（不算丢弃）
    if (rows.some((r) => r.item === byKey.get(key)!.label)) continue; // 同项去重，先到先得
    const sourceType = raw.source_type === "用户补充" ? "用户补充" : "AI推断";
    rows.push({
      item: byKey.get(key)!.label,
      content,
      source:
        String(raw.source ?? "").trim() ||
        (sourceType === "用户补充" ? "对话" : "行业通例"),
      source_type: sourceType,
    });
  }
  return { rows, dropped };
}

/**
 * 剥掉正文里的"元说明"注解
 *
 * 模型爱在定义正文里写"（用户未明说，按行业通行情况推断）""（对话中由助手推断…）"这类
 * 来源说明——用户投诉过"整个页面大量的无效信息"，这些注解就是典型噪音：
 * 谁说的应该由 `source_type`/`source` 字段表达，不该混进正文。
 */
export function stripMetaNotes(content: string): string {
  return String(content ?? "")
    .replace(/[（(][^（）()]*(?:用户未(?:明说|明确|提及)|按行业[^（）()]*推断|由助手[^（）()]*推断|系统推断|推断而来)[^（）()]*[）)]/g, "")
    .replace(/[，,、；;]\s*[。.]/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 把一个定义格压到可读长度
 *
 * 定义表要的是"一眼看懂的一句话"，不是段落——用户投诉过表格里 88–115 字的枚举段落。
 * 优先在句界（。；！？, ；）截断；找不到句界就硬截并加省略号。
 */
export function compressCell(content: string): string {
  const text = stripMetaNotes(content).replace(/\s+/g, " ");
  if (text.length <= DEFINITION_CELL_MAX_CHARS) return text;
  const head = text.slice(0, DEFINITION_CELL_MAX_CHARS);
  const cut = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("；"),
    head.lastIndexOf("，"),
    head.lastIndexOf(";"),
    head.lastIndexOf(","),
  );
  const kept = cut > 20 ? head.slice(0, cut) : head;
  return `${kept.replace(/[，,；;]$/, "")}…`;
}

/** 「整理成定义」等待模型的上限（毫秒）；超时即降级为不写任何内容，避免请求无限挂起 */
export const CONSOLIDATE_TIMEOUT_MS = 120_000;

export interface ConsolidateOutcome {
  rows: AnchorRow[];
  updated: number;
  skipped: number;
  openQuestions: string[];
  usedLlm: boolean;
  /** 模型给了但匹配不到固定项的项名（暴露问题，避免静默丢失） */
  dropped: string[];
  /** 模型顺手推断、按"只收用户说过的"规则丢弃的项数（不落表，但可观测） */
  inferredDropped: number;
  /**
   * 失败原因（模型没调通 / 输出无法解析）。
   *
   * 必须往上报：`prompt` 出错时是 **yield 一个 error 事件**而不是抛异常，
   * 旧代码只收 text、把错误事件丢掉 → 表现成"点整理成定义，表1-1 一片空白、日志也没有一行"，
   * 用户只能猜。真实故障：装了桌面版、聊完点整理，场景概述 6 项里 5 项全空（故障清单 #63）。
   */
  error?: string;
}

/**
 * 定义阶段只问会改变场景本体的取舍
 *
 * 「现有系统/平台/厂商/接口/对接」属于后续调研能查的事实，不该在定义收口后再考用户；
 * 旧提示词只写了"只有用户能回答"，模型仍会把这些当成问题。
 */
const NON_DEFINITION_QUESTION_RE =
  /(现有|在用|已有|既有|已建|平台|对接|接口|厂商|品牌|产品|型号|技术|协议|预算|工期|上线|报价|投资)/u;

/** 对话最后一轮是否已经收口（助手说够了 / 用户说可以整理） */
function isClosedConversation(
  messages: readonly { role: string; content: string }[],
): boolean {
  const lastAssistant = [...messages].reverse().find((m) => m.role !== "用户");
  if (
    lastAssistant &&
    /(够了|可以整理|点[「“]?整理成定义|整理成定义就行)/u.test(lastAssistant.content)
  ) {
    return true;
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "用户");
  return Boolean(
    lastUser &&
      /^(?:够了|可以了|没有了|就这样|开始整理)[。！!，,]*$/u.test(lastUser.content.trim()),
  );
}

/** 过滤整理结果里的问题：收口后不再追问，且只留场景本体取舍 */
function sanitizeOpenQuestions(raw: unknown, closed: boolean): string[] {
  if (closed || !Array.isArray(raw)) return [];
  return raw
    .map((q) => String(q).trim())
    .filter((q) => q !== "" && !NON_DEFINITION_QUESTION_RE.test(q))
    .slice(0, 2);
}

/**
 * 「整理成定义」：把「场景定义」对话整理成表1-1
 *
 * - 读该会话全部消息作为输入
 * - 保留用户已确认/已补充的行（用户的决定优先，见 `mergeAnchorRows`）
 * - 若识别到"想搞清楚什么"，写入诉求
 */
export async function consolidateDefinition(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
  conversationId: string,
  opts?: { timeoutMs?: number },
): Promise<ConsolidateOutcome> {
  const timeoutMs = opts?.timeoutMs ?? CONSOLIDATE_TIMEOUT_MS;
  const messages = db.messageRepo.listByConversation(conversationId);
  const transcript = messages
    .map((m) => `${m.role === "用户" ? "用户" : "助手"}：${m.content}`)
    .join("\n");

  const itemList = anchorFixedRows()
    .map(
      (r) =>
        `- item_key=\`${r.key}\`  中文名「${r.label}」${r.owner === "用户" ? "（用户输入）" : ""}`,
    )
    .join("\n");

  let incoming: AnchorRow[] = [];
  let intent = "";
  let openQuestions: string[] = [];
  let dropped: string[] = [];
  /** 模型顺手推断、按规则丢弃的项数（不落表，但要能看见） */
  let inferredDropped = 0;
  /** prompt 的 error 事件（不是异常）：必须显式收，否则错误就被吞了 */
  let error = "";
  /** 模型流式正文（排障时要留片段，所以声明在外层） */
  let full = "";

  try {
    const session: SessionHandle = await dshClient.createSession({
      title: `场景定义整理 · ${scenario.name}`,
    });
    const deadline = Date.now() + timeoutMs;
    for await (const ev of dshClient.prompt(session, {
      system: DEFINITION_SYSTEM,
      user: [
        "【固定项清单】（item 必须严格取自这里）",
        itemList,
        "",
        "【对话记录】",
        transcript || "（还没有对话）",
        "",
        CONSOLIDATE_TASK,
      ].join("\n"),
      outputContract: CONSOLIDATE_CONTRACT,
    })) {
      if (ev.type === "text") full += (ev as { type: string; text: string }).text;
      else if (ev.type === "error") {
        error = String((ev as { message?: string }).message ?? "模型调用失败");
      }
      // 有界等待：模型长时间无输出就断开（break 会关闭该异步生成器），
      // 降级为"不写任何内容"——用户可再点一次，而不是让请求悬着
      if (Date.now() > deadline) break;
    }
    const parsed = parseConsolidation(full);
    if (parsed) {
      const normalized = normalizeConsolidatedItems(parsed);
      // 属主决定收不收：
      //  - 智能体侧的 5 项业务画像 → **收 AI推断**（用户定调"用户什么都知道还要我们干什么"）
      //  - 用户侧的项 → 只收用户说过的；模型替用户编的话一律丢（那才是"替用户表态"）
      const userLabels = new Set(anchorUserRows().map((r) => r.label));
      const kept = normalized.rows.filter((r) => {
        if (!userLabels.has(r.item)) return true;
        return r.source_type === "用户补充" || r.source_type === "用户确认";
      });
      inferredDropped = normalized.rows.length - kept.length;
      incoming = kept.map((r) => ({ ...r, content: compressCell(r.content) }));
      dropped = normalized.dropped;
      intent = String(parsed.intent ?? "").trim();
      openQuestions = sanitizeOpenQuestions(parsed.open_questions, isClosedConversation(messages));
      error = "";
    } else if (full.trim()) {
      error = "模型返回的内容没有解析出表1-1（多半是输出格式不符），再点一次或换个模型试试";
    } else if (!error) {
      error = "模型没有返回任何内容（多半是调用没通），再点一次；仍失败请看日志或换模型";
    }
  } catch (err: unknown) {
    /* 不写任何内容，但**必须**留下原因 */
    error = err instanceof Error ? err.message : String(err);
  }
  if (error) {
    // 这条日志是排障入口：桌面版用户可以把 logs/server.log 直接发过来
    console.warn(`[定义整理] 场景 ${scenario.id} 失败：${error}`);
  }

  const usedLlm = incoming.length > 0;
  if (!usedLlm) {
    /* 没产出内容时把模型原文留一段：这类"点了没反应"的问题只有原文能定位
       （真实故障：思考型模型 400 → 静默空白，故障清单 #63）。截断保存，够定位即可。 */
    console.warn(
      `[定义整理] 场景 ${scenario.id} 未产出内容（解析=${error ? "失败" : "成功但无行"}）。模型原文片段：${
        full.trim().slice(0, 400) || "（空）"
      }`,
    );
  }
  // 幂等补齐骨架：整理可能发生在「锚骨架还没建」的场景上（例如直接调 consolidate），
  // 没有这一步的话「场景名称」会落成空——那是用户唯一亲手输入的项。
  ensureAnchorRows(db, scenario.id, scenario.name);
  const before = readAnchorRows(db, scenario.id);
  // 保留用户已确认行：mergeAnchorRows 内部对本场景/用户持有的行不覆盖
  const merged = mergeAnchorRows(before, incoming);
  // 清理规则（v1.19 改口径）：
  //  ① **已不在表定义里的历史残行**（旧的 12 项制：拍板者/使用者/付费者/价值主张…）→ 清空。
  //     这类行是"表1-1 曾经要用户填空"的遗留，新版不再渲染它们。
  //  ② 所有行的正文一律剥掉元说明注解（模型爱写"（用户未明说，按行业通行情况推断）"）。
  //
  // 注意：**不再**因为"模型这次没再产出"就清掉旧 AI推断 行——
  // 业务画像（边界/对象/系统/买方/采购）本身就是推断产物，"这次没提就抹掉"会把交付物洗没。
  //
  // 注意 `mergeAnchorRows` 只返回注册表里有的项，历史残项会被它丢掉——所以残项要**另取一路**：
  // 从 `before` 里挑出"不在表定义里且不是用户持有"的行，显式写空，别让它们躺在库里。
  const knownItems = new Set(anchorFixedRows().map((r) => r.label));
  const isUserOwned = (r: AnchorRow | undefined): boolean =>
    Boolean(r && (r.source_type === "用户确认" || r.source_type === "用户补充"));
  const staleRows = before
    .filter((r) => !knownItems.has(r.item) && !isUserOwned(r))
    .map((r) => ({ item: r.item, content: "" }));
  const cleaned = [...merged, ...staleRows].map((row) => ({
    ...row,
    content: stripMetaNotes(String(row.content ?? "")),
  }));
  const rows = writeAnchorRows(db, scenario.id, cleaned);
  syncDerivedDescription(db, scenario.id);

  if (intent) {
    // 只补空缺，不覆盖用户已填的「想搞清楚什么」
    const brief = readBrief(db, scenario.id);
    if (!brief || brief.intent.trim() === "") {
      upsertBrief(db, scenario.id, {
        scene_name: scenario.name,
        intent,
      });
    }
  }

  const beforeFilled = new Set(
    before.filter((r) => String(r.content).trim() !== "").map((r) => r.item),
  );
  const updated = rows.filter(
    (r) => String(r.content).trim() !== "" && !beforeFilled.has(r.item),
  ).length;

  return {
    rows,
    updated,
    skipped: Math.max(0, anchorFixedRows().length - updated),
    openQuestions,
    usedLlm,
    error: error || undefined,
    dropped,
    inferredDropped,
  };
}

/** 只查不建：「场景定义」会话已存在则返回其 id（读路径用，避免读操作产生副作用） */
export function findDefinitionConversation(db: DbInstance, scenarioId: string): string | null {
  const existing = db.conversationRepo
    .list({ where: "scenario_id = ? AND status = ?", params: [scenarioId, "活跃"] })
    .find((c) => c.title === "场景定义");
  return existing?.id ?? null;
}

/** 找或建「场景定义」会话（幂等） */
export async function ensureDefinitionConversation(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
): Promise<string> {
  const existing = findDefinitionConversation(db, scenario.id);
  if (existing) return existing;
  const handle = await dshClient.createSession({ title: "场景定义" });
  const conv = db.conversationRepo.insert({
    scenario_id: scenario.id,
    title: "场景定义",
    status: "活跃",
    dsh_session_id: handle.sessionId,
  });
  return conv.id;
}

/** 定义对话已产生的消息（给前端渲染对话页） */
export function definitionMessages(
  db: DbInstance,
  conversationId: string,
): { id: string; role: string; content: string; created_at: string }[] {
  return db.messageRepo
    .listByConversation(conversationId)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    }));
}

/**
 * 表1-1 中**智能体侧已写出的项数**（5 项业务画像里有内容的）
 *
 * 为什么就绪看"智能体写了没有"而不是"用户确认完了没有"：
 * 用户定调「用户只负责输入场景名称，智能体负责从业务角度说清楚场景的范围」
 * +「用户确认就默认可以了」——写不写得出来是智能体的活，不该让用户逐项签字。
 *
 * 为什么不能按"任一行有内容"判定：锚骨架在**新建场景时**就用项目名填了
 * 「场景名称」，那样项目一建好第 1 步就 ready，架空了"先聊清楚再落定义"的意图。
 */
export function definitionFilledCount(db: DbInstance, scenarioId: string): number {
  const byItem = new Map(readAnchorRows(db, scenarioId).map((r) => [r.item, r]));
  return anchorAgentRows().filter((r) => {
    const row = byItem.get(r.label);
    const content = String(row?.content ?? "").trim();
    return content !== "" && content !== "未提供";
  }).length;
}

/** 定义是否已整理（流程第 1 步就绪判定：智能体侧至少一项有内容） */
export function hasDefinition(db: DbInstance, scenarioId: string): boolean {
  return definitionFilledCount(db, scenarioId) > 0;
}

/** 供测试与调试：表1-1 定义项定义 */
export function anchorRowCount(): number {
  return TABLES_BY_CODE[ANCHOR]?.fixedRows?.length ?? 0;
}

/** 类型再导出（前端契约用 InfoRow 判空） */
export type { InfoRow };
