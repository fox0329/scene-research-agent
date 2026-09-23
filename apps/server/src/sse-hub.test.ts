/**
 * @scene/server — sse-hub 测试
 *
 * 覆盖：缓冲重放、Last-Event-ID 增量续传、实时扇出、
 * 异常终止、重复启动、prune 清理。
 */

import { describe, it, expect } from "vitest";
import type { FollowEvent } from "@scene/contract";
import { createSseHub } from "./sse-hub.js";

// ─── 可控事件源 ────────────────────────────────────────────

function createManualSource() {
  const queue: FollowEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;

  const push = (event: FollowEvent): void => {
    queue.push(event);
    resolveNext?.();
  };
  const close = (): void => {
    closed = true;
    resolveNext?.();
  };

  const source: AsyncIterable<FollowEvent> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    },
  };

  return { source, push, close };
}

/** 收集事件直到条件满足或超时 */
async function collectUntil(
  iterable: AsyncIterable<FollowEvent>,
  predicate: (events: FollowEvent[]) => boolean,
): Promise<FollowEvent[]> {
  const collected: FollowEvent[] = [];
  for await (const event of iterable) {
    collected.push(event);
    if (predicate(collected)) break;
  }
  return collected;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ─── 缓冲与重放 ────────────────────────────────────────────

describe("sse-hub 缓冲与重放", () => {
  it("已终止的 run 可全量重放", async () => {
    const hub = createSseHub();
    const { source, push, close } = createManualSource();
    hub.start("r1", source);
    push({ type: "progress", id: "1", message: "a" });
    push({ type: "done", id: "2" });
    close();
    await tick();
    await tick();

    const events = [];
    for await (const e of hub.subscribe("r1")!) events.push(e);
    expect(events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(hub.isDone("r1")).toBe(true);
  });

  it("Last-Event-ID 只重放其后的增量事件", async () => {
    const hub = createSseHub();
    const { source, push, close } = createManualSource();
    hub.start("r1", source);
    for (let i = 1; i <= 5; i++) push({ type: "progress", id: String(i) });
    close();
    await tick();
    await tick();

    const events = [];
    for await (const e of hub.subscribe("r1", "3")!) events.push(e);
    expect(events.map((e) => e.id)).toEqual(["4", "5"]);
  });

  it("非法 lastEventId 视为从头重放", async () => {
    const hub = createSseHub();
    hub.start(
      "r2",
      (async function* () {
        yield { type: "done", id: "1" };
      })(),
    );
    await tick();
    await tick();
    const events = [];
    for await (const e of hub.subscribe("r2", "abc")!) events.push(e);
    expect(events).toHaveLength(1);
  });

  it("未结束的 run：订阅方挂起等待新事件（断线续传实时流）", async () => {
    const hub = createSseHub();
    const { source, push, close } = createManualSource();
    hub.start("r1", source);
    push({ type: "progress", id: "1" });
    await tick();

    const collected = collectUntil(hub.subscribe("r1", "1")!, (es) => es.length >= 2);
    await tick();
    push({ type: "progress", id: "2" });
    push({ type: "done", id: "3" });
    close();
    const events = await collected;
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
  });
});

// ─── 生命周期 ──────────────────────────────────────────────

describe("sse-hub 生命周期", () => {
  it("未知 run 订阅返回 undefined", () => {
    const hub = createSseHub();
    expect(hub.subscribe("nope")).toBeUndefined();
    expect(hub.has("nope")).toBe(false);
  });

  it("source 抛错：补 error 事件并标记终止", async () => {
    const hub = createSseHub();
    hub.start(
      "boom",
      (async function* () {
        yield { type: "progress", id: "1" };
        throw new Error("连接断开");
      })(),
    );
    await tick();
    await tick();
    expect(hub.isDone("boom")).toBe(true);
    const events = [];
    for await (const e of hub.subscribe("boom")!) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["progress", "error"]);
  });

  it("同 runId 重复 start 被忽略，不重复消费", async () => {
    const hub = createSseHub();
    let consumed = 0;
    const counting = (async function* () {
      yield { type: "progress", id: "1" };
      consumed++;
    })();
    hub.start("r", counting);
    hub.start("r", counting);
    await tick();
    await tick();
    expect(consumed).toBe(1);
  });

  it("prune 只清理已结束 run，保留最近 keepDone 个", async () => {
    const hub = createSseHub();
    for (const id of ["a", "b", "c"]) {
      hub.start(
        id,
        (async function* () {
          yield { type: "done", id: "1" };
        })(),
      );
    }
    hub.start("live", createManualSource().source);
    await tick();
    await tick();

    hub.prune(1);
    expect(hub.has("live")).toBe(true); // 未结束不清理
    expect(hub.has("a")).toBe(false);
    expect(hub.has("b")).toBe(false);
    expect(hub.has("c")).toBe(true); // 保留最近 1 个
  });
});
