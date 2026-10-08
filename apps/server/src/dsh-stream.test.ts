import { describe, expect, it, vi } from "vitest";
import type { DshClient, FollowEvent, SessionHandle } from "@scene/contract";
import { streamPrompt } from "./dsh-stream.js";

/**
 * 收流不许丢块（变更表 #143）
 *
 * 实测事故：心跳赢得 Promise.race 后，已发出的 `iterator.next()` 被丢弃，异步生成器不会把
 * 已取走的值还回来 → 那一块正文永久丢失。症状是报告"第一段从半句开始"、PPT 大纲"不是合规
 * JSON"（开头 `{"pages":[{"layout` 恰好是丢的那一块）。
 */
function fakeClient(chunks: Array<string | (() => Promise<string>)>): DshClient {
  const session = { id: "s", title: "t" } as unknown as SessionHandle;
  return {
    createSession: async () => session,
    prompt: () => {
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (i >= chunks.length) return { done: true as const, value: undefined };
              const c = chunks[i++]!;
              const text = typeof c === "string" ? c : await c();
              return { done: false as const, value: { type: "text", text } };
            },
          };
        },
      };
    },
  } as unknown as DshClient;
}

/** 让心跳先赢一次：正文在第 1 个 next() 上挂起超过 keepaliveMs */
const slowFirst = (): Promise<string> =>
  new Promise((resolve) => setTimeout(() => resolve('{"pages":[{"layout":'), 40));

describe("streamPrompt 收流", () => {
  it("心跳先触发也不能吞掉正在等待的那一块（丢块回归）", async () => {
    const events: FollowEvent[] = [];
    const r = await streamPrompt({
      dshClient: fakeClient([slowFirst, '"网格要点"}]}', "尾巴"]),
      session: { id: "s" } as unknown as SessionHandle,
      system: "sys",
      user: "user",
      label: "测试",
      keepaliveMs: 10,
      push: (e) => events.push(e),
    });
    expect(r.error).toBeUndefined();
    // 三块必须一块不少，顺序不变
    expect(r.text).toBe('{"pages":[{"layout":"网格要点"}]}尾巴');
    // 心跳确实上报过（说明这条路径被走到，不是"没触发所以没丢"）
    expect(events.some((e) => String(e["message"] ?? "").includes("仍在撰写"))).toBe(true);
  });

  it("正常收流（无心跳）原样拼接", async () => {
    const r = await streamPrompt({
      dshClient: fakeClient(["a", "b", "c"]),
      session: { id: "s" } as unknown as SessionHandle,
      system: "s",
      user: "u",
      label: "测试",
      keepaliveMs: 1000,
      push: () => {},
    });
    expect(r.text).toBe("abc");
  });

  it("出错事件返回已收正文与错误", async () => {
    const session = { id: "s" } as unknown as SessionHandle;
    const client = {
      createSession: async () => session,
      prompt: () => ({
        [Symbol.asyncIterator]: () => ({
          next: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: { type: "text", text: "半截" } })
            .mockResolvedValueOnce({ done: false, value: { type: "error", message: "炸了" } }),
        }),
      }),
    } as unknown as DshClient;
    const r = await streamPrompt({
      dshClient: client,
      session,
      system: "s",
      user: "u",
      label: "测试",
      keepaliveMs: 1000,
      push: () => {},
    });
    expect(r.text).toBe("半截");
    expect(r.error).toContain("炸了");
  });
});
