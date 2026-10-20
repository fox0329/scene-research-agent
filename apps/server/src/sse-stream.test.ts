/**
 * @scene/server — SSE 推流收尾的回归测试
 *
 * 守的是故障清单 #47：客户端断开（用户按 F5 的常态）时，服务端**必须仍然 end()**。
 * 曾经的写法 `if (!closed) reply.raw.end()` 让 socket 停在 CLOSE_WAIT、这条 HTTP 响应
 * 永不结束——Fastify 一辈子不打 `request completed`，连接也不归还。
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createSseHub } from "./sse-hub.js";
import { parseStage, streamEvents } from "./sse-stream.js";
import type { FollowEvent } from "@scene/contract";

/** 假响应：只实现 streamEvents 用到的四个方法与 `close` 事件 */
function fakeRaw(): ServerResponse & { writableEnded: boolean } {
  const raw = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead: () => raw,
    flushHeaders: () => {},
    write: () => true,
    end: () => {
      raw.writableEnded = true;
      return raw;
    },
  });
  return raw as unknown as ServerResponse & { writableEnded: boolean };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** streamEvents 的第一个参数只作占位（断连检测挂在响应上），测试给个同款假对象即可 */
const asRequest = (raw: ServerResponse): { raw: IncomingMessage } => ({
  raw: raw as unknown as IncomingMessage,
});

describe("streamEvents 收尾", () => {
  it("客户端断开之后仍然 end()：否则响应永不结束、连接永远停在 CLOSE_WAIT", async () => {
    const hub = createSseHub();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub.start(
      "run-1",
      (async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "progress", message: "开始分析" };
        // 真实的静默段：生成完到自检之间的等待，此时用户按了 F5
        await gate;
        yield { type: "progress", message: "第二条" };
      })(),
    );

    const raw = fakeRaw();
    const finished = streamEvents(hub, "run-1", asRequest(raw), { raw, hijack: () => {} });
    await tick();
    raw.emit("close"); // 用户按 F5：连接被掐断
    release(); // 断开之后事件才到
    await finished;

    expect(raw.writableEnded).toBe(true);
  });

  it("正常跑完也会 end()（断线续传之外的常规路径不受影响）", async () => {
    const hub = createSseHub();
    hub.start(
      "run-2",
      (async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "done" };
      })(),
    );
    const raw = fakeRaw();
    await streamEvents(hub, "run-2", asRequest(raw), { raw, hijack: () => {} });
    expect(raw.writableEnded).toBe(true);
  });

  it("run 不存在时按 404 收尾（不把响应挂住）", async () => {
    const hub = createSseHub();
    const raw = fakeRaw();
    await streamEvents(hub, "不存在", asRequest(raw), { raw, hijack: () => {} });
    expect(raw.writableEnded).toBe(true);
  });

  it("阶段编号解析：只认契约里的 0-5", () => {
    expect(parseStage("0")).toBe(0);
    expect(parseStage("5")).toBe(5);
    expect(parseStage("6")).toBeUndefined();
    expect(parseStage("8")).toBeUndefined();
    expect(parseStage("-1")).toBeUndefined();
    expect(parseStage("abc")).toBeUndefined();
  });
});
