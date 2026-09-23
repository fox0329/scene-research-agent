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
  product_line_id: string;
  status: ProjectStatusApi;
  current_stage: number;
  created_at: string;
  updated_at: string;
  stale_count?: number;
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

export interface ApiStagePanel {
  rows: ApiStageRow[];
  gates: ApiGate[];
  advice: AdviceLevelApi | null;
}

export interface ApiStaleInfo {
  stages: number[];
  tables: string[];
  banner: string | null;
}

export interface ApiProductLine {
  id: string;
  name: string;
  row_counts?: Record<string, number>;
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
  createProject: (name: string) =>
    req<ApiProject>("/projects", { method: "POST", body: { name } }),
  patchProject: (id: string, patch: { name?: string; status?: ProjectStatusApi }) =>
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
  stagePanel: (id: string, stage: number) =>
    req<ApiStagePanel>(`/projects/${encodeURIComponent(id)}/stages/${stage}`),
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
    req<{ id: string; category: string; title: string }[]>(
      `/knowledge${category ? `?category=${encodeURIComponent(category)}` : ""}`,
    ),
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
export const advanceStageStream = (projectId: string, stage: number) =>
  sseRequest(
    `/projects/${encodeURIComponent(projectId)}/stages/${stage}/advance`,
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
 * 上传材料并接收入库进度流：
 * 1) POST multipart（file + product_line_id）→ { ingest_job_id }
 * 2) GET /library/ingest/:jobId/events（SSE，支持 Last-Event-ID 续传）
 */
export async function* ingestStream(
  file: File,
  productLineId: string,
): AsyncGenerator<FollowEvent> {
  const form = new FormData();
  form.append("file", file);
  form.append("product_line_id", productLineId);
  const res = await fetch(`${BASE}/library/ingest`, { method: "POST", body: form });
  const data = (await res.json().catch(() => null)) as
    | { ingest_job_id?: string; error?: string }
    | null;
  if (!res.ok || !data?.ingest_job_id) {
    throw new ApiError(data?.error ?? `上传失败（HTTP ${res.status}）`, res.status);
  }
  yield* sseRequest(`/library/ingest/${encodeURIComponent(data.ingest_job_id)}/events`);
}
