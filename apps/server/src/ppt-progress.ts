/**
 * @scene/server — PPT 导出进度通道（变更表 #141）
 *
 * PPT 导出比 Word 慢得多（一次模型调用 + 逐页渲染 + 转档，约 1–3 分钟），用户不能看着按钮干等。
 * 进度走**现有那条 SSE 通道**（`SseHub` + `{type:"progress", message}` 事件），但导出接口本身
 * 仍要返回 JSON（`{files, unchanged, notice}`），所以进度与结果分成两条线：
 *
 *   1. 前端先拿一个 run token 订阅 `GET …/deliverables/export-pptx/events?run=<token>`；
 *   2. 再 `POST …/deliverables/export-pptx`（body 带同一个 `run`），边导出边往通道里推进度；
 *   3. 导出结束（无论成败）关掉通道，SSE 流随之收尾，前端恢复按钮。
 *
 * **两边谁先到都行**：`ensurePptRun` 是幂等的——订阅先到就先把 run 建起来，
 * 导出先到就先建通道，订阅到时由中枢重放已缓冲的进度（`SseHub` 本就支持按 id 重放）。
 * 没人来取（用户点了就切走）也不会挂着：通道带 TTL，到点自动收尾。
 */

import type { FollowEvent } from "@scene/contract";
import type { SseHub } from "./sse-hub.js";

/** run id 前缀（与报告生成的 run 区分开，避免互相覆盖） */
const RUN_PREFIX = "ppt-export:";

/** 没人取用时的最长存活时间（15 分钟：够跑完一次导出，又不会长期占着内存） */
const CHANNEL_TTL_MS = 15 * 60 * 1000;

export interface PptProgressChannel {
  /** 推进度（只发一句人话，前端直接显示） */
  push(message: string): void;
  /** 收尾：关闭通道（SSE 流随之结束；已缓冲的进度仍可重放） */
  close(): void;
}

interface ChannelHandle {
  channel: PptProgressChannel;
  /** 交给中枢消费的事件流 */
  source: AsyncIterable<FollowEvent>;
}

/** 进程内通道登记表：前端给的 token → 通道 */
const channels = new Map<string, PptProgressChannel>();

/** 各通道的 TTL 定时器（收尾时一并清掉，不留 15 分钟的僵尸定时器） */
const timers = new Map<string, NodeJS.Timeout>();

/**
 * 造一条通道：把 `push` 进来的进度变成一个可被 `SseHub` 消费的事件流
 *
 * 生成器在 `close()` 且队列排空后自然结束 → 中枢把 run 标记为 done → SSE 流收尾。
 */
function createChannel(): ChannelHandle {
  const queue: FollowEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  async function* source(): AsyncIterable<FollowEvent> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  const notify = (): void => {
    const pending = wake;
    wake = null;
    pending?.();
  };

  const channel: PptProgressChannel = {
    push: (message) => {
      if (closed) return;
      queue.push({ type: "progress", message });
      notify();
    },
    close: () => {
      if (closed) return;
      closed = true;
      notify();
    },
  };
  return { channel, source: source() };
}

/** 该 token 对应的 run id */
export function pptRunId(token: string): string {
  return `${RUN_PREFIX}${token}`;
}

/**
 * 保证 token 对应的 run 已经在中枢里起来（幂等）
 *
 * @returns 该 run 的通道（导出侧 push / 收尾用；订阅侧只关心 run 存在）
 */
export function ensurePptRun(hub: SseHub, token: string, ttlMs = CHANNEL_TTL_MS): PptProgressChannel {
  const existing = channels.get(token);
  if (existing) return existing;
  const { channel, source } = createChannel();
  channels.set(token, channel);
  hub.start(pptRunId(token), source);
  const timer = setTimeout(() => closePptRun(token), ttlMs);
  timer.unref?.();
  timers.set(token, timer);
  return channel;
}

/** 关掉并忘掉一条通道（导出结束调用；中枢里已缓冲的进度还能被重放） */
export function closePptRun(token: string): void {
  const channel = channels.get(token);
  const timer = timers.get(token);
  if (timer) clearTimeout(timer);
  timers.delete(token);
  if (!channel) return;
  channel.close();
  channels.delete(token);
}
