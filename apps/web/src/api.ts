/**
 * @scene/web — 后端 API 客户端（M5-T5.3 联真）
 *
 * 约定（契约 v1.4 联真口径）：
 * - 基址 /api/v1，开发态由 vite proxy 转发到 4081，构建产物由 server 单端口托管
 * - 错误统一 { error: "中文说明" } → ApiError(message, status)
 * - SSE（advance/ingest/converse）走 fetch 流解析，支持 Last-Event-ID 重连
 */

const BASE = "/api/v1";

// ─── 类型（与 @scene/contract 对齐的最小面） ───────────────

export type ProjectStatusApi = "进行中" | "已完成" | "已归档";
export type AdviceLevelApi = "建议通过" | "建议有条件通过" | "建议不通过";
export type GateResultApi = "通过" | "不通过" | "未检";

export interface ApiProject {
  id: string;
  name: string;
  /** 场景描述（分析锚 v1.11）：客户/行业、问题、目标与边界 */
  description?: string | null;
  product_line_id: string;
  status: ProjectStatusApi;
  current_stage: number;
  created_at: string;
  updated_at: string;
  stale_count?: number;
  /**
   * 流程进度摘要（v1.5：左栏场景列表显示「第 n/8 步」）
   *
   * 可选：后端版本较旧时该字段缺失——缺失即不显示进度，不做本地猜测。
   */
  flow?: {
    currentStep: number;
    completedCount: number;
    finished: boolean;
  };
}

// ─── 业务流程（v1.5 逐页推进，8 步） ───────────────────────

/** 步骤类型：决定「完成本步」的就绪判定方式（定义对话不占步，故无「输入」） */
export type ApiFlowStepKind = "确认" | "分析" | "组装";

/** 步骤状态（用户可见四态） */
export type ApiFlowStepState = "已完成" | "当前" | "可推进" | "未解锁";

/** 本步表集的产出情况 */
export interface ApiFlowProgress {
  tablesWithData: number;
  expectedTables: number;
  rows: number;
}

export interface ApiFlowStep {
  /** 步骤号（1 起，用户可见） */
  id: number;
  /** 稳定键（brief|anchor|stage1..stage6|delivery） */
  key: string;
  /** 完整标题（悬停/读屏） */
  title: string;
  /** 简化标题：进度卡上显示的关键词（「场景定义」「能力匹配」…） */
  short: string;
  goal: string;
  kind: ApiFlowStepKind;
  state: ApiFlowStepState;
  /** 「完成本步」是否可点（数据判定，服务端算） */
  ready: boolean;
  /** 未就绪时缺什么（人话，直接显示） */
  readyHint: string;
  progress: ApiFlowProgress;
}

export interface ApiFlowStatus {
  steps: ApiFlowStep[];
  /** 当前应做步骤号（全部完成时为最后一步号） */
  currentStep: number;
  completedCount: number;
  finished: boolean;
}

export interface ApiConversation {
  id: string;
  scenario_id: string;
  title: string;
  status: "活跃" | "已归档";
  dsh_session_id: string;
  created_at: string;
  updated_at: string;
}

export interface ApiStageRow {
  id: string;
  scenario_id: string;
  stage: number;
  table_code: string;
  row: Record<string, unknown>;
  is_stale: boolean;
  source_type?: string | null;
  source?: string | null;
  source_authority?: string | null;
  evidence_level?: string | null;
}

export interface ApiGate {
  id: string;
  scenario_id: string;
  stage: number;
  item_no: string;
  title: string;
  result: GateResultApi;
  detail: string;
}

/** 信息缺口（完整度检查产出；只说明"还缺什么"，不含判定） */
export interface ApiCompletenessGap {
  kind: "缺表" | "缺必填列" | "覆盖度不足" | "缺来源" | "推断未标注" | "待确认未处理";
  tableCode: string;
  column?: string;
  detail: string;
  count?: number;
}

/** 阶段信息完整度报告 */
export interface ApiCompleteness {
  stage: number;
  expectedTables: number;
  tablesWithData: number;
  missingTables: string[];
  gaps: ApiCompletenessGap[];
  percent: number;
}

/**
 * 阶段面板响应
 *
 * v1.4：`gates` / `advice` 已废弃（产品不产出判断），服务端仅返回空值以兼容过渡期；
 * 新前端请使用 `completeness` 与 `summary_ready`。
 */
export interface ApiStagePanel {
  rows: ApiStageRow[];
  completeness: ApiCompleteness;
  summary_ready: boolean;
  /** @deprecated 旧质量关，恒为空数组 */
  gates: ApiGate[];
  /** @deprecated 旧建议档位，恒为 null */
  advice: AdviceLevelApi | null;
}

/** 场景诉求（第一输入；`raw_text` 是确认基准，不可改写） */
export interface ApiScenarioBrief {
  scenario_id: string;
  scene_name: string;
  intent: string;
  customer_hint?: string | null;
  region_hint?: string | null;
  scope_hint?: string | null;
  audience?: string | null;
  deadline?: string | null;
  raw_text: string;
  created_at: string;
  updated_at: string;
}

/** 场景锚（表1-1）的一行：项 / 内容 */
export interface ApiAnchorRow {
  item: string;
  content: string;
  source?: string | null;
  source_type?: string | null;
  confirm_state?: string | null;
}

// ─── 场景定义（v1.17：对话式定义，取代三段式填空） ─────────

/** 定义对话的一条消息（role 与后端落库口径一致：用户 / 系统） */
export interface ApiDefinitionMessage {
  id: string;
  role: "用户" | "系统";
  content: string;
  created_at: string;
}

/** 整理成定义后的单行对照结论（四态与右侧 label 由服务端判定） */
export interface ApiDefinitionAlignment {
  rowKey: string;
  label: string;
  content: string;
  alignment: "一致" | "系统补充" | "推断" | "待补充";
  note?: string;
}

/**
 * 场景定义状态
 *
 * 幂等：首次 `GET /projects/:id/definition` 会创建标题为「场景定义」的会话，
 * 已存在则复用（同一定义对话跨多次打开延续）。
 */
export interface ApiDefinitionState {
  /** 「场景定义」会话；**尚未聊过时为 null**（读操作不创建） */
  conversation_id: string | null;
  messages: ApiDefinitionMessage[];
  anchor: ApiAnchorRow[];
  brief: ApiScenarioBrief | null;
}

/** 「整理成定义」结果：写表统计 + 对照表 + 仍需用户回答的问题 */
export interface ApiDefinitionConsolidation {
  /** 模型给了但匹配不到固定项的项名（排查用，正常为空） */
  dropped?: string[];
  /** 模型顺手推断、按"只收用户说过的"规则丢弃的项数（定义页去噪的可观测指标） */
  inferred_dropped?: number;
  rows: ApiAnchorRow[];
  alignment: ApiDefinitionAlignment[];
  updated: number;
  skipped: number;
  open_questions: string[];
}

/** 阶段总结文档（六段骨架 Markdown） */
export interface ApiStageSummary {
  stage: number;
  markdown: string;
  completeness: ApiCompleteness;
}

export interface ApiStaleInfo {
  stages: number[];
  tables: string[];
  banner: string | null;
}

export interface ApiProductLine {
  id: string;
  name: string;
  /** 归属场景 id：null=通用资料库，非空=该场景专属库（v1.10） */
  scenario_id?: string | null;
  row_counts?: Record<string, number>;
}

/** 场景资料来源（v1.10：专属库 + 引用通用库） */
export interface ApiMaterialSources {
  own: ApiProductLine | null;
  linked: ApiProductLine[];
}

/** 质量六维 + 完成度（领域层计算，契约 v1.4） */
export interface ApiQualitySummary {
  quality: {
    dimensions: { dimension: string; status: "pass" | "warn" | "fail"; description: string }[];
    passCount: number;
    warnCount: number;
    failCount: number;
  };
  completeness: {
    items: { id: number; name: string; status: string; risk: string }[];
    reminders: { table: string; missing: string; impact: string; suggestion?: string }[];
  };
}

/** 知识库条目（契约 Knowledge 对齐） */
export interface ApiKnowledge {
  id: string;
  product_line_id?: string;
  scene?: string;
  category: "竞品" | "需求" | "趋势" | "成本";
  content: string;
  source: string;
  source_authority: string;
  from_scenario_id: string;
  created_at: string;
}

/** 供应商公共摘要（契约 v1.6：应用自持登记表，密钥脱敏不回显） */
export interface ApiProviderPublic {
  name: string;
  base_url: string;
  models: { id: string; name?: string }[];
  has_key: boolean;
  key_masked: string | null;
  updated_at: string;
}

export interface ApiDefaultModelRef {
  provider: string;
  model: string;
}

export interface ApiProvidersState {
  configured: boolean;
  providers: ApiProviderPublic[];
  default_model: ApiDefaultModelRef | null;
}

export interface ApiSystemStatus {
  db: "ok" | "error";
  model_configured: boolean;
  provider_count: number;
  default_model: ApiDefaultModelRef | null;
}

/** 链接质量检查结果（两段式：models 探活 → chat 最小生成） */
export interface ApiConnectionCheck {
  ok: boolean;
  stage: "models" | "chat";
  models_latency_ms?: number;
  chat_latency_ms?: number;
  models_seen?: string[];
  error?: string;
}

/** 模型列表发现结果（候选端点自动探测，仿 CC Switch） */
export interface ApiModelsFetch {
  ok: boolean;
  models: string[];
  /** 实际命中的 baseURL（与输入不同时表单应回填修正） */
  resolved_base_url?: string;
  latency_ms?: number;
  error?: string;
}

/** SSE follow 事件（与 contract FollowEvent 对齐） */
export interface FollowEvent {
  type: string;
  [key: string]: unknown;
}

// ─── 请求基座 ──────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers:
      init.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError("后端返回了非 JSON 响应", res.status);
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

// ─── REST 面 ───────────────────────────────────────────────

export const api = {
  health: () => req<{ status: string }>("/health"),

  listProjects: () => req<ApiProject[]>("/projects"),
  /**
   * 新建项目
   *
   * v1.4：可一并提交**场景诉求**（第一输入）——服务端会落库并预建表1-1 锚骨架。
   */
  createProject: (
    name: string,
    brief?: {
      scene_name?: string;
      intent?: string;
      customer_hint?: string;
      region_hint?: string;
      scope_hint?: string;
      audience?: string;
      deadline?: string;
    },
  ) => req<ApiProject>("/projects", { method: "POST", body: { name, ...(brief ?? {}) } }),
  patchProject: (id: string, patch: { name?: string; status?: ProjectStatusApi; description?: string }) =>
    req<ApiProject>(`/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    }),
  deleteProject: (id: string) =>
    req<{ deleted: boolean }>(`/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  staleInfo: (id: string) =>
    req<ApiStaleInfo>(`/projects/${encodeURIComponent(id)}/stale`),
  /** 阶段面板数据；`step` 传了就按**本步表集**算完整度（右栏"只针对当前步骤"） */
  stagePanel: (id: string, stage: number, step?: number) =>
    req<ApiStagePanel>(
      `/projects/${encodeURIComponent(id)}/stages/${stage}${step ? `?step=${step}` : ""}`,
    ),

  // ─── 场景诉求（第一输入）与场景锚（表1-1） ───────────────
  getBrief: (id: string) =>
    req<{ brief: ApiScenarioBrief | null; anchor: ApiAnchorRow[] }>(
      `/projects/${encodeURIComponent(id)}/brief`,
    ),
  saveBrief: (
    id: string,
    brief: {
      scene_name?: string;
      intent: string;
      customer_hint?: string;
      region_hint?: string;
      scope_hint?: string;
      audience?: string;
      deadline?: string;
    },
  ) =>
    req<{ brief: ApiScenarioBrief; anchor: ApiAnchorRow[] }>(
      `/projects/${encodeURIComponent(id)}/brief`,
      { method: "PUT", body: brief },
    ),
  /* 定义只能来自「场景定义对话 + 整理成定义」：老的 POST /brief/draft
     自动起草旁路已随服务端一并移除（它会自动写表，与新规则冲突），
     客户端不再保留任何调用口子。 */
  // ─── 场景定义对话（v1.17/1.18：定义不占流程步，写表只在显式「整理成定义」时发生） ──
  /** 定义对话状态（幂等：首次调用创建「场景定义」会话，已存在则复用） */
  getDefinition: (id: string) =>
    req<ApiDefinitionState>(`/projects/${encodeURIComponent(id)}/definition`),
  /** 把定义对话整理成表1-1（用户显式点击才写表，不做自动增量改写） */
  consolidateDefinition: (id: string) =>
    req<ApiDefinitionConsolidation>(
      `/projects/${encodeURIComponent(id)}/definition/consolidate`,
      { method: "POST" },
    ),
  /** 批量写锚行（逐格确认/编辑；也可只传部分行） */
  saveAnchor: (id: string, rows: ApiAnchorRow[]) =>
    req<{ rows: ApiAnchorRow[]; description: string }>(
      `/projects/${encodeURIComponent(id)}/anchor`,
      { method: "PUT", body: { rows } },
    ),

  // ─── 业务流程推进（v1.5 逐页推进；8 步） ──────────────────
  /** 流程状态：每步四态 + 就绪判定（数据判定由服务端算，前端只显示） */
  getFlow: (id: string) =>
    req<ApiFlowStatus>(`/projects/${encodeURIComponent(id)}/flow`),
  /** 完成本步（用户显式动作；是否可点由本步 ready 决定） */
  completeFlowStep: (id: string, step: number) =>
    req<ApiFlowStatus>(
      `/projects/${encodeURIComponent(id)}/flow/steps/${step}/complete`,
      { method: "POST" },
    ),
  /** 回到某一步重跑（清该步及其后的完成标记，数据保留） */
  reopenFlowStep: (id: string, step: number) =>
    req<ApiFlowStatus>(
      `/projects/${encodeURIComponent(id)}/flow/steps/${step}/reopen`,
      { method: "POST" },
    ),
  // ─── 阶段完整度与总结 ────────────────────────────────────
  stageCompleteness: (id: string, stage: number, step?: number) =>
    req<ApiCompleteness>(
      `/projects/${encodeURIComponent(id)}/stages/${stage}/completeness${step ? `?step=${step}` : ""}`,
    ),
  /** 阶段总结；`step` 传了就是"只讲这一步"（无诉求全文、无上下游衔接） */
  stageSummary: (id: string, stage: number, refresh = false, step?: number) => {
    const q = new URLSearchParams();
    if (refresh) q.set("refresh", "1");
    if (step) q.set("step", String(step));
    const qs = q.toString();
    return req<ApiStageSummary>(
      `/projects/${encodeURIComponent(id)}/stages/${stage}/summary${qs ? `?${qs}` : ""}`,
    );
  },
  /** 阶段总结 Markdown 下载地址（直接给 <a download> 用） */
  stageSummaryDownloadUrl: (id: string, stage: number) =>
    `${BASE}/projects/${encodeURIComponent(id)}/stages/${stage}/summary?format=md`,
  patchStageCell: (id: string, rowId: string, cell: string, value: unknown) =>
    req<ApiStageRow>(
      `/projects/${encodeURIComponent(id)}/stage-data/${encodeURIComponent(rowId)}`,
      { method: "PATCH", body: { cell, value } },
    ),
  decide: (id: string, stage: number, action: "继续" | "补充" | "停止" | "重算") =>
    req<ApiProject>(
      `/projects/${encodeURIComponent(id)}/stages/${stage}/decide`,
      { method: "POST", body: { action } },
    ),
  /** 交付物双口径导出（契约 §三：返回服务端 md 文件路径） */
  exportDeliverables: (id: string) =>
    req<{ internal_path: string; external_path: string }>(
      `/projects/${encodeURIComponent(id)}/deliverables/export`,
      { method: "POST" },
    ),

  listConversations: (projectId: string) =>
    req<ApiConversation[]>(`/projects/${encodeURIComponent(projectId)}/conversations`),
  createConversation: (projectId: string, title: string) =>
    req<ApiConversation>(`/projects/${encodeURIComponent(projectId)}/conversations`, {
      method: "POST",
      body: { title },
    }),
  renameConversation: (id: string, title: string) =>
    req<ApiConversation>(`/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { title },
    }),
  archiveConversation: (id: string) =>
    req<ApiConversation>(`/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { archive: true },
    }),
  deleteConversation: (id: string, force = false) =>
    req<{ deleted: boolean }>(
      `/conversations/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
      { method: "DELETE" },
    ),
  listMessages: (conversationId: string) =>
    req<{ id: string; role: string; content: string; created_at: string }[]>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
    ),

  productLines: () => req<ApiProductLine[]>("/library/product-lines"),
  createProductLine: (name: string) =>
    req<ApiProductLine>("/library/product-lines", { method: "POST", body: { name } }),

  /** 资料库表行（M1-M6/O1-O6），字段按表 schema 异构 */
  libraryTable: (code: string, productLineId?: string) =>
    req<Record<string, unknown>[]>(
      `/library/tables/${encodeURIComponent(code)}${
        productLineId ? `?product_line_id=${encodeURIComponent(productLineId)}` : ""
      }`,
    ),
  patchLibraryRow: (code: string, rowId: string, cell: string, value: unknown) =>
    req<Record<string, unknown>>(
      `/library/rows/${encodeURIComponent(code)}/${encodeURIComponent(rowId)}`,
      { method: "PATCH", body: { cell, value } },
    ),
  addLibraryRow: (code: string, productLineId: string, values: Record<string, unknown>) =>
    req<Record<string, unknown>>(`/library/rows/${encodeURIComponent(code)}`, {
      method: "POST",
      body: { product_line_id: productLineId, values },
    }),
  /** 产品去重（M1）：同型号合并、规格参数归并、删重复产品行 */
  dedupeProducts: (productLineId: string) =>
    req<{ groups: number; products_removed: number; specs_moved: number; merged: { model: string; removed: number }[] }>(
      `/library/product-lines/${encodeURIComponent(productLineId)}/dedupe-products`,
      { method: "POST" },
    ),
  /** 产品线重命名（多资料库管理） */
  renameProductLine: (productLineId: string, name: string) =>
    req<ApiProductLine>(`/library/product-lines/${encodeURIComponent(productLineId)}`, {
      method: "PATCH",
      body: { name },
    }),
  /** 场景澄清（v1.12）：生成值得确认的问题发进对话 */
  clarifyScenario: (projectId: string) =>
    req<{
      need_clarification: boolean;
      questions: string[];
      conversation_id?: string;
      note?: string;
    }>(`/projects/${encodeURIComponent(projectId)}/clarify-scenario`, { method: "POST" }),
  /** 场景资料来源：专属库 + 引用的通用库（v1.10） */
  materialSources: (projectId: string) =>
    req<ApiMaterialSources>(`/projects/${encodeURIComponent(projectId)}/material-sources`),
  /** 设置场景引用的通用库（只能引通用库；专属库不可被引用） */
  linkMaterialSources: (projectId: string, linkedLineIds: string[]) =>
    req<{ scenario_id: string; linked_line_ids: string[] }>(
      `/projects/${encodeURIComponent(projectId)}/material-sources`,
      { method: "PUT", body: { linked_line_ids: linkedLineIds } },
    ),
  deleteLibraryRow: (code: string, rowId: string) =>
    req<{ deleted: boolean }>(
      `/library/rows/${encodeURIComponent(code)}/${encodeURIComponent(rowId)}`,
      { method: "DELETE" },
    ),
  qualitySummary: (productLineId: string) =>
    req<ApiQualitySummary>(
      `/library/quality-summary?product_line_id=${encodeURIComponent(productLineId)}`,
    ),

  knowledge: (category?: string) =>
    req<ApiKnowledge[]>(
      `/knowledge${category ? `?category=${encodeURIComponent(category)}` : ""}`,
    ),

  /** 系统状态（DB 健康 + 模型配置概览） */
  systemStatus: () => req<ApiSystemStatus>("/system/status"),
  /** 供应商登记表（脱敏） */
  providers: () => req<ApiProvidersState>("/system/providers"),
  /** 新增/更新供应商（api_key 省略 = 保留原密钥） */
  upsertProvider: (input: {
    name: string;
    base_url: string;
    api_key?: string;
    models: { id: string; name?: string }[];
  }) => req<ApiProviderPublic>("/system/providers", { method: "POST", body: input }),
  deleteProvider: (name: string) =>
    req<{ deleted: boolean }>(`/system/providers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  /** 设置默认供应商+模型（model 传空取该供应商第一个） */
  setDefaultModel: (provider: string, model: string) =>
    req<ApiDefaultModelRef>("/system/providers/default", {
      method: "PUT",
      body: { provider, model },
    }),
  /** 链接质量检查：name=测已存供应商；或草稿 base_url(+api_key/model) */
  testProvider: (input: {
    name?: string;
    base_url?: string;
    api_key?: string;
    model?: string;
  }) => req<ApiConnectionCheck>("/system/providers/test", { method: "POST", body: input }),
  /** 拉取模型列表：填好链接+Key 一键发现服务端模型；name=用已存供应商密钥 */
  fetchProviderModels: (input: {
    name?: string;
    base_url?: string;
    api_key?: string;
  }) => req<ApiModelsFetch>("/system/providers/models", { method: "POST", body: input }),
};

// ─── SSE 面（advance / 会话消息：POST 建流 + GET 续传） ─────

/**
 * 解析 text/event-stream 响应体，逐条产出 follow 事件。
 * 记录最后事件 id，断线后可带 Last-Event-ID 通过 reconnectUrl 续传。
 */
async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  sink: { lastId: string | null },
): AsyncGenerator<FollowEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let id: string | null = null;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const event = JSON.parse(data) as FollowEvent;
        if (id) sink.lastId = id;
        yield event;
      } catch {
        /* 非 JSON 帧忽略 */
      }
    }
  }
}

/**
 * 发起一次 SSE POST 调用，返回事件流；lastEventIdSink 由调用方持有，
 * 断线重连时可拼接 GET reconnectUrl?lastEventId=…
 */
export async function* sseRequest(
  path: string,
  body?: unknown,
  lastEventIdSink: { lastId: string | null } = { lastId: null },
  method?: string,
): AsyncGenerator<FollowEvent> {
  const httpMethod =
    method ?? (body === undefined ? "GET" : "POST");
  const res = await fetch(`${BASE}${path}`, {
    method: httpMethod,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let message = `流式请求失败（HTTP ${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* 保留默认文案 */
    }
    throw new ApiError(message, res.status);
  }
  yield* parseEventStream(res.body, lastEventIdSink);
}

/** 启动阶段分析流（T4.1 路由，进度事件实时反馈） */
/**
 * 发起本步分析（SSE）
 *
 * `step` 会作为 `?step=N` 传给服务端，按**该流程步的表集**限定模型输出契约——
 * 例如阶段 1 的第 2 步（认识场景）不该重复产出场景锚（表1-1 归第 1 步）。
 */
export const advanceStageStream = (projectId: string, stage: number, step?: number) =>
  sseRequest(
    `/projects/${encodeURIComponent(projectId)}/stages/${stage}/advance${
      step === undefined ? "" : `?step=${step}`
    }`,
    undefined,
    undefined,
    "POST",
  );

/** 断线续传：GET events + Last-Event-ID */
export const reconnectStageStream = (
  projectId: string,
  stage: number,
  lastEventId: string,
) =>
  sseRequest(
    `/projects/${encodeURIComponent(projectId)}/stages/${stage}/events?lastEventId=${encodeURIComponent(lastEventId)}`,
  );

/** 会话消息流（T5.5 抽屉使用；发消息即建流） */
export const conversationMessageStream = (conversationId: string, content: string) =>
  sseRequest(`/conversations/${encodeURIComponent(conversationId)}/messages`, { content });

/**
 * 场景定义对话流（v1.17 定义模式）
 *
 * 与 `conversationMessageStream` 同构（POST + SSE，text 增量 / done / error），
 * 差别只在服务端用**定义模式的 system prompt**：模型先给出它的理解，再提
 * ≤3 个场景本体问题，不问表格字段。
 */
export const definitionChatStream = (projectId: string, content: string) =>
  sseRequest(`/projects/${encodeURIComponent(projectId)}/definition/messages`, {
    content,
  });

/** 会话回复流断线续传：GET messages/events + Last-Event-ID（契约 v1.5） */
export const reconnectConversationStream = (conversationId: string, lastEventId: string) =>
  sseRequest(
    `/conversations/${encodeURIComponent(conversationId)}/messages/events?lastEventId=${encodeURIComponent(lastEventId)}`,
  );

/**
 * 上传材料并接收入库进度流：
 * 1) POST multipart（file + product_line_id）→ { ingest_job_id }
 * 2) GET /library/ingest/:jobId/events（SSE，支持 Last-Event-ID 续传）
 *
 * 注意：product_line_id 必须 append 在 file 之前（@fastify/multipart 的
 * request.file() 在第一个 file 部件处返回，之后的字段收不到），同时通过
 * URL query 兜底，任何客户端字段顺序都能过。
 */
export async function* ingestStream(
  file: File,
  productLineId: string,
): AsyncGenerator<FollowEvent> {
  const form = new FormData();
  form.append("product_line_id", productLineId);
  form.append("file", file);
  const res = await fetch(
    `${BASE}/library/ingest?product_line_id=${encodeURIComponent(productLineId)}`,
    { method: "POST", body: form },
  );
  const data = (await res.json().catch(() => null)) as
    | { ingest_job_id?: string; error?: string }
    | null;
  if (!res.ok || !data?.ingest_job_id) {
    throw new ApiError(data?.error ?? `上传失败（HTTP ${res.status}）`, res.status);
  }
  yield* sseRequest(`/library/ingest/${encodeURIComponent(data.ingest_job_id)}/events`);
}
