import { describe, expect, it, vi } from "vitest";
import type { FollowEvent } from "../api";
import { consumeAnalysisStream } from "./analysis-stream";

/**
 * 进度流消费的单测（对应用户实测：连接断了但界面永远停在「分析中」）
 *
 * 覆盖四种收尾：正常 done / 流结束没终局事件（续连）/ 长时间静默（看门狗续连）/
 * 续连次数用尽（必须回 terminal=false，让调用方去对账，而不是永远转圈）。
 */

const ev = (type: string, id?: string, extra: Record<string, unknown> = {}): FollowEvent =>
  ({ type, ...(id === undefined ? {} : { id }), ...extra }) as FollowEvent;

/** 用数组造一条一次性的假事件流 */
function stream(events: FollowEvent[], onConsumed?: () => void): AsyncIterable<FollowEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      onConsumed?.();
    },
  };
}

/** 永远不产出事件的流（模拟"连接活着但再也不推东西"） */
const silentForever = (): AsyncIterable<FollowEvent> => ({
  [Symbol.asyncIterator]() {
    return { next: () => new Promise<IteratorResult<FollowEvent>>(() => {}) };
  },
});

describe("consumeAnalysisStream", () => {
  it("正常跑完：收到 done 就结束，不续连", async () => {
    const seen: string[] = [];
    const res = await consumeAnalysisStream({
      open: () => ({ events: stream([ev("progress", "1"), ev("done", "2")]), abort: () => {} }),
      onEvent: (e) => seen.push(e.type),
    });
    expect(res).toEqual({ terminal: true, reconnects: 0, lastEventId: "2" });
    expect(seen).toEqual(["progress", "done"]);
  });

  it("error 也算终局事件：不续连（否则会无限重试一个必然失败的运行）", async () => {
    const res = await consumeAnalysisStream({
      open: () => ({ events: stream([ev("error", "1", { message: "模型失败" })]), abort: () => {} }),
      onEvent: () => {},
    });
    expect(res.terminal).toBe(true);
    expect(res.reconnects).toBe(0);
  });

  it("流结束但没等到终局事件 ⇒ 带 Last-Event-ID 续连，补齐后正常收尾", async () => {
    const opened: (string | null)[] = [];
    const seen: string[] = [];
    const res = await consumeAnalysisStream({
      open: (lastId) => {
        opened.push(lastId);
        return lastId === null
          ? { events: stream([ev("progress", "1"), ev("progress", "2")]), abort: () => {} } // 断在半路
          : { events: stream([ev("row", "3"), ev("done", "4")]), abort: () => {} };
      },
      onEvent: (e) => seen.push(String(e.id)),
    });
    expect(opened).toEqual([null, "2"]); // 第二次从最后收到的 id 之后续
    expect(seen).toEqual(["1", "2", "3", "4"]); // 不重复推已经看过的事件
    expect(res).toMatchObject({ terminal: true, reconnects: 1, lastEventId: "4" });
  });

  it("静默超时（看门狗）⇒ 主动中止死连接并续连，且不当失败", async () => {
    vi.useFakeTimers();
    try {
      const aborts: number[] = [];
      const reasons: string[] = [];
      let call = 0;
      const done = consumeAnalysisStream({
        stallMs: 1000,
        maxReconnects: 1,
        open: () => {
          call += 1;
          const n = call;
          const events = n === 1 ? silentForever() : stream([ev("done", "9")]);
          return { events, abort: () => aborts.push(n) };
        },
        onEvent: () => {},
        onReconnect: (r) => reasons.push(r),
      });
      // 第一条流永不产出 → 推进定时器触发看门狗（中止 + 续连）
      await vi.advanceTimersByTimeAsync(1200);
      const res = await done;
      expect(aborts).toEqual([1]); // 只中止了那条"死了的连接"，成功的第二条不中止
      expect(reasons).toEqual(["stall"]);
      expect(res).toMatchObject({ terminal: true, reconnects: 1, lastEventId: "9" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("续连次数用尽仍是断的 ⇒ terminal=false（调用方据此对账，别永远转圈）", async () => {
    let opened = 0;
    const res = await consumeAnalysisStream({
      maxReconnects: 2,
      open: () => {
        opened += 1;
        return { events: stream([ev("progress", "1")]), abort: () => {} };
      },
      onEvent: () => {},
    });
    expect(opened).toBe(3); // 首次 + 2 次续连
    expect(res.terminal).toBe(false);
    expect(res.reconnects).toBe(2);
  });

  it("连接抛错也算断线：续连拿到 done 则整体成功", async () => {
    let call = 0;
    const res = await consumeAnalysisStream({
      maxReconnects: 1,
      open: () => {
        call += 1;
        if (call === 1) {
          return {
            events: {
              // eslint-disable-next-line require-yield
              async *[Symbol.asyncIterator](): AsyncGenerator<FollowEvent> {
                throw new Error("net::ERR_INCOMPLETE_CHUNKED_ENCODING");
              },
            },
            abort: () => {},
          };
        }
        return { events: stream([ev("done", "5")]), abort: () => {} };
      },
      onEvent: () => {},
    });
    expect(res.terminal).toBe(true);
    expect(res.reconnects).toBe(1);
  });
});
