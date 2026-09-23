/**
 * @scene/server — SSE 事件中枢（M4-T4.1，F2 约束 3"流式续传"的落地）
 *
 * 职责：把 advance-stage 的 AsyncGenerator 事件流按 runId 缓冲，
 * 支持多订阅者扇出 + 断线后按 Last-Event-ID 重放增量事件。
 *
 * 进程内状态（不落库）：应用层组件，不依赖领域层。
 */

import type { FollowEvent } from "@scene/contract";

// ─── 公共接口 ──────────────────────────────────────────────

export interface SseHub {
  /** 是否有该 run 的记录（含已结束的，可重放） */
  has(runId: string): boolean;
  /** 该 run 是否已终止（source 耗尽或出错） */
  isDone(runId: string): boolean;
  /** 启动一个 run：消费 source 并缓冲事件；同 runId 重复调用被忽略 */
  start(runId: string, source: AsyncIterable<FollowEvent>): void;
  /**
   * 订阅某个 run 的事件流。
   * lastEventId 之前的已缓冲事件被跳过，其后的增量重放；
   * run 未结束时挂起等待新事件（断线续传语义）。
   * run 不存在时返回 undefined。
   */
  subscribe(
    runId: string,
    lastEventId?: string | null,
  ): AsyncIterable<FollowEvent> | undefined;
  /** 清理已结束的 run 缓冲（保留最近 keepDone 个） */
  prune(keepDone?: number): void;
}

// ─── 内部状态 ──────────────────────────────────────────────

interface RunState {
  events: FollowEvent[];
  done: boolean;
  started: boolean;
  /** 等待新事件的 waiter 回调集合 */
  waiters: Set<() => void>;
}

const DEFAULT_KEEP_DONE = 20;

// ─── 工厂函数 ──────────────────────────────────────────────

export function createSseHub(): SseHub {
  const runs = new Map<string, RunState>();

  const getOrCreate = (runId: string): RunState => {
    const existing = runs.get(runId);
    if (existing) return existing;
    const state: RunState = { events: [], done: false, started: false, waiters: new Set() };
    runs.set(runId, state);
    return state;
  };

  const notify = (state: RunState): void => {
    for (const wake of state.waiters) wake();
  };

  const drain = async (state: RunState, source: AsyncIterable<FollowEvent>): Promise<void> => {
    try {
      for await (const event of source) {
        state.events.push(event);
        notify(state);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      state.events.push({ type: "error", message: `事件流异常: ${message}` });
    } finally {
      state.done = true;
      notify(state);
    }
  };

  const waitForUpdate = (state: RunState, owned: Set<() => void>): Promise<void> =>
    new Promise<void>((resolve) => {
      const wake = (): void => {
        owned.delete(wake);
        resolve();
      };
      state.waiters.add(wake);
      owned.add(wake);
    });

  /** 按 Last-Event-ID 定位重放起点：事件 id 为递增数字字符串 */
  const replayFrom = (events: FollowEvent[], lastEventId?: string | null): number => {
    if (!lastEventId) return 0;
    const lastId = Number(lastEventId);
    if (!Number.isFinite(lastId)) return 0;
    let idx = 0;
    while (idx < events.length && Number(events[idx]!.id ?? 0) <= lastId) idx++;
    return idx;
  };

  const subscribe = (
    runId: string,
    lastEventId?: string | null,
  ): AsyncIterable<FollowEvent> | undefined => {
    const state = runs.get(runId);
    if (!state) return undefined;

    async function* iterate(): AsyncIterable<FollowEvent> {
      const owned = new Set<() => void>();
      try {
        let cursor = replayFrom(state.events, lastEventId);
        for (;;) {
          while (cursor < state.events.length) {
            yield state.events[cursor++]!;
          }
          if (state.done) return;
          await waitForUpdate(state, owned);
        }
      } finally {
        for (const w of owned) state.waiters.delete(w); // 订阅方提前退出时清账
      }
    }

    return iterate();
  };

  return {
    has: (runId) => runs.has(runId),
    isDone: (runId) => runs.get(runId)?.done ?? false,
    start: (runId, source) => {
      const state = getOrCreate(runId);
      if (state.started) return; // 重复启动忽略
      state.started = true;
      void drain(state, source);
    },
    subscribe,
    prune: (keepDone = DEFAULT_KEEP_DONE) => {
      const doneIds = [...runs.entries()]
        .filter(([, s]) => s.done)
        .map(([id]) => id);
      for (const id of doneIds.slice(0, Math.max(0, doneIds.length - keepDone))) {
        runs.delete(id);
      }
    },
  };
}
