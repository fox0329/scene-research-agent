/**
 * 需求理解与反思优化模块契约（v1.5，变更表 #351/#352/#353）
 *
 * 领域规则见 docs/技术方案-需求理解与反思生成.md v1.2：
 * - requirement_profile：场景/用户两级画像条目，带检测锚点与来源
 * - interaction_event：五处 UI 埋点事件（唯一写入口 event-recorder，方案 6.5 评审修订）
 *
 * 判定铁律（G-0.3）：锚点比对、升级判定、澄清阈值全部落确定性层；
 * LLM 只做抽取、澄清提问、重写，不进判定路径。
 */

// ─── 需求画像条目 ─────────────────────────────────────────────

export type RequirementKind = "explicit" | "preference" | "constraint" | "dimension_gap";

export type RequirementScope = "scene" | "user";

export type RequirementStatus = "active" | "superseded" | "dismissed";

/** 置信三级，沿用 confirmation.ts 的语义：用户原话 > 用户操作 > AI推断 */
export type RequirementConfidence = "用户原话" | "用户操作" | "AI推断";

/**
 * 检测锚点：抽取时由 LLM 产出、反思比对时纯确定性匹配（给文档造测试）。
 * mode 三态决定比对方向；抽不出可靠锚点的条目 check_anchor 为空 → 仅提示级，
 * 宁可漏改、不可误改（方案 6.3）。
 */
export type CheckAnchorMode = "命中即违反" | "未出现即违反" | "仅提示";

export type CheckAnchor =
  | { type: "keyword"; terms: string[]; mode: CheckAnchorMode }
  | { type: "regex"; pattern: string; flags?: string; mode: CheckAnchorMode }
  | {
      type: "numeric";
      /** 产物内目标量，如 "正文总字数"（按导出口径折算，折算规则集中管理） */
      field: string;
      op: ">" | "<" | ">=" | "<=" | "==";
      value: number;
      unit?: string;
      mode: CheckAnchorMode;
    };

/** 来源引用（G-R0 溯源铁律）：每条画像必须可指回一次对话或一次操作 */
export interface RequirementSource {
  type: "message" | "operation" | "clarify";
  /** 消息 id / 操作记录 id / 澄清消息 id */
  ref: string;
  /** 原话片段或操作摘要 */
  snippet: string;
}

export interface RequirementEntry {
  id: string;
  /** 场景级条目必填；用户级条目为 NULL（评审修订 #353） */
  scenario_id: string | null;
  /** 用户级条目：升级发生时所在场景（溯源） */
  origin_scenario_id: string | null;
  scope: RequirementScope;
  kind: RequirementKind;
  /** 一句话（G-R9 中栏口径） */
  text: string;
  check_anchor: CheckAnchor | null;
  status: RequirementStatus;
  confidence: RequirementConfidence;
  sources: RequirementSource[];
  /** 关联产物，格式 (scenario_id, step, type, id) 序列化 */
  artifact_refs: string[];
  created_at: string;
  updated_at: string;
}

// ─── 交互事件（五处埋点） ─────────────────────────────────────

export type InteractionSurface = "ui" | "conversation";

export type InteractionAction =
  | "edit_cell"
  | "confirm"
  | "undo"
  | "rewrite"
  | "suggest_accept"
  | "suggest_reject"
  /** 澄清问题已注入会话（MR3-T2） */
  | "clarify"
  /** 用户选「别再问」：本场景自动澄清静音（MR3-T2） */
  | "clarify_mute";

export interface InteractionEventRecord {
  id: string;
  scenario_id: string | null;
  conversation_id: string | null;
  surface: InteractionSurface;
  action: InteractionAction;
  /** 目标定位：表格码/行/列或消息 id */
  target: string;
  detail_json: string;
  created_at: string;
}

// ─── API 契约（contract v1.5 新增 3 端点） ────────────────────

/** GET /api/v1/scenarios/:id/requirements */
export interface ScenarioRequirementsResponse {
  entries: RequirementEntry[];
  /** 升级候选：同维度在 ≥2 场景 active，等用户确认（不自动升级） */
  upgrade_candidates: RequirementEntry[];
}

/** PATCH /api/v1/requirements/:id —— 用户手编永远赢（并发规则） */
export interface RequirementPatchRequest {
  text?: string;
  status?: RequirementStatus;
  scope?: RequirementScope;
  check_anchor?: CheckAnchor | null;
  /** 相似合并落库用：追加来源（内容去重由 repo 完成） */
  sources?: RequirementSource[];
}
