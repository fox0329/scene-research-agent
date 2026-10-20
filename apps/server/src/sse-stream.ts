/**
 * @scene/server — SSE 推流共享工具
 *
 * advance / converse / ingest 三类流式端点共用：
 * - parseStage：阶段编号解析（0-7）
 * - streamEvents：把 hub 订阅流写成 §四 统一 SSE 报文（event: follow + id 递增）
 */

import type { StageId } from "@scene/contract";
import type { SseHub } from "./sse-hub.js";

/** 最后一个阶段编号（现行 8 阶段 0-7；老的 9 阶段 0-8 已收窄） */
export const LAST_STAGE_ID: StageId = 5;

export function parseStage(raw: string): StageId | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > LAST_STAGE_ID) return undefined;
  return n as StageId;
}

/**
 * 把 hub 订阅流写成 SSE。
 * 事件带递增 id（生产者生成），客户端断开后
 * 可用 Last-Event-ID 通过对应 events 路由增量续传。
 */
export async function streamEvents(
  hub: SseHub,
  runId: string,
  /** 预留：请求上下文（断连检测挂在响应上，见下） */
  _request: { raw: import("node:http").IncomingMessage },
  reply: {
    raw: import("node:http").ServerResponse;
    hijack: () => void;
  },
  lastEventId?: string | null,
): Promise<void> {
  reply.hijack();

  const iterable = hub.subscribe(runId, lastEventId ?? null);
  if (!iterable) {
    reply.raw.writeHead(404, { "Content-Type": "application/json" });
    reply.raw.end(JSON.stringify({ error: `run ${runId} 不存在` }));
    return;
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.flushHeaders();

  /**
   * 断连检测挂在响应对象上：Node 22 下 request.raw 在请求体读完后即触发
   * 'close'（连接仍活着），若监听请求流会把带体 POST（converse 发消息）
   * 的首帧误丢弃且永不收尾。ServerResponse 的 'close' 才对应真实连接销毁。
   */
  let closed = false;
  reply.raw.on("close", () => {
    closed = !reply.raw.writableEnded;
  });

  try {
    for await (const event of iterable) {
      if (closed) break;
      const idLine = event.id ? `id: ${event.id}\n` : "";
      reply.raw.write(`event: follow\n${idLine}data: ${JSON.stringify(event)}\n\n`);
    }
  } finally {
    /**
     * 收尾必须无条件 end()——**不许**因为"客户端已断开"就跳过
     *
     * 曾经的写法是 `if (!closed) reply.raw.end()`，理由是"客户端都走了，不用回了"。
     * 但用户按 F5 正是这条分支的常态：断开后 socket 停在 CLOSE_WAIT，服务端不 end
     * 就永远不会发 FIN，于是这条 HTTP 响应永远不收尾——Fastify 一辈子不打
     * `request completed`，连接挂在那儿不释放。实跑里"方案实现"因此有两条流挂了
     * 十几分钟（场景其实早已跑完、行也早已落库）。
     *
     * 对已断开的 socket 调 end() 是安全的（写失败不会抛到调用方），
     * 却能让响应真正结束、连接归还。
     */
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
