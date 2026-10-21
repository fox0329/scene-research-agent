/**
 * @scene/server — 交付物终检编排测试（变更表 #139）
 *
 * mock 模型：终检是"通读 → 逐章改 → 复查"三次调用，这里锁住四件事——
 * 只改被点名的段落（其余逐字不变）、改动越界/超幅一律整章不采纳、模型失败与坏 JSON
 * 只跳过终检（绝不阻断出稿）、`review: "off"` 时一次调用都不发；
 * 坏 JSON 先容错（围栏/前后缀）→ 再用更短的提示重试一次（#139 补丁）。
 */

import { describe, expect, it } from "vitest";
import type { DshClient, FollowEvent } from "@scene/contract";
import {
  FIX_PROMPT_MARKER,
  REVIEW_PROMPT_MARKER,
  REVIEW_RETRY_PROMPT_MARKER,
  VERIFY_PROMPT_MARKER,
  reviewReport,
} from "./report-review.js";

/** 待终检的整篇：第一章第二段是"病句"，其余段落逐字不许动 */
const MD = [
  "## 现状与问题",
  "",
  "智慧会议室分散在总部与各园区，跨地域协同靠云平台。",
  "",
  "这句话前后矛盾，要改掉。",
  "",
  "## 建设目标与思路",
  "",
  "以统一预约与自动就绪为总体目标，覆盖总部与各园区。",
].join("\n");

const CHAPTER_FIXED = [
  "## 现状与问题",
  "",
  "智慧会议室分散在总部与各园区，跨地域协同靠云平台。",
  "",
  "本方案先统一预约入口，再分批接管设备就绪。",
].join("\n");

const ISSUES = JSON.stringify({
  issues: [
    {
      chapter: "现状与问题",
      anchor: "这句话前后矛盾",
      type: "前后矛盾",
      note: "「这句话前后矛盾，要改掉」与「智慧会议室分散在总部与各园区」两处说法对不上",
    },
  ],
});

interface Mock {
  client: DshClient;
  calls: { system: string; user: string }[];
}

function dshMock(respond: (input: { system: string; user: string }) => string | Error): Mock {
  const calls: { system: string; user: string }[] = [];
  const client = {
    createSession: async ({ title }: { title: string }) => ({ sessionId: `s-${title}` }),
    prompt: (_h: unknown, input: { system: string; user: string }) => {
      calls.push(input);
      const out = respond(input);
      return (async function* (): AsyncGenerator<FollowEvent> {
        if (out instanceof Error) throw out;
        yield { type: "text", text: out };
        yield { type: "done" };
      })();
    },
    cancel: async () => {},
  } as unknown as DshClient;
  return { client, calls };
}

function runReview(mock: Mock, markdown = MD, enabled = true) {
  const progress: string[] = [];
  return reviewReport({
    kind: "solution",
    markdown,
    scenarioName: "智慧会议室",
    dshClient: mock.client,
    keepaliveMs: 10_000,
    push: (e) => progress.push(String(e["message"] ?? "")),
    enabled,
  }).then((out) => ({ out, progress }));
}

/** 终检顺序作答：通读给 ISSUES，改章给 chapter，复查给 unresolved */
function responding(chapter: string, unresolved = '{"unresolved":[]}'): Mock {
  return dshMock((input) => {
    if (input.user.includes(REVIEW_PROMPT_MARKER)) return ISSUES;
    if (input.user.includes(FIX_PROMPT_MARKER)) return chapter;
    if (input.user.includes(VERIFY_PROMPT_MARKER)) return unresolved;
    return "";
  });
}

describe("reviewReport — 通读 → 逐章修 → 复查", () => {
  it("有 1 处问题 → 只改那一段，同章其它段落与其它章逐字不变", async () => {
    const mock = responding(CHAPTER_FIXED);
    const { out, progress } = await runReview(mock);

    expect(out.issues).toBe(1);
    expect(out.fixed).toBe(1);
    expect(out.remaining).toBe(0);
    expect(out.markdown).toContain("本方案先统一预约入口，再分批接管设备就绪。");
    expect(out.markdown).not.toContain("这句话前后矛盾，要改掉。");
    // 没被点名的段落与章节逐字不变
    expect(out.markdown).toContain("智慧会议室分散在总部与各园区，跨地域协同靠云平台。");
    expect(out.markdown).toContain(
      "## 建设目标与思路\n\n以统一预约与自动就绪为总体目标，覆盖总部与各园区。",
    );
    // 三次调用：通读 / 改章 / 复查
    expect(mock.calls).toHaveLength(3);
    expect(progress.some((m) => m.includes("终检：发现 1 处，改了 1 处，留 0 处提示"))).toBe(true);
  });

  it("改动越界（顺手改了没被点名的段落）→ 整章不采纳、保留原稿", async () => {
    const overreach = CHAPTER_FIXED.replace(
      "智慧会议室分散在总部与各园区，跨地域协同靠云平台。",
      "智慧会议室分布在总部与各个园区，跨地域协同主要依靠云平台。",
    );
    const mock = responding(overreach);
    const { out, progress } = await runReview(mock);

    expect(out.fixed).toBe(0);
    expect(out.remaining).toBe(1);
    expect(out.markdown).toBe(MD);
    expect(progress.some((m) => m.includes("未过确定性检查") && m.includes("保留原稿"))).toBe(true);
    expect(out.violations.some((v) => v.kind === "终检问题" && v.from === "终检")).toBe(true);
  });

  it("长度变化超过 ±25% → 不采纳", async () => {
    const bloated = CHAPTER_FIXED.replace(
      "本方案先统一预约入口，再分批接管设备就绪。",
      "本方案先统一预约入口，再分批接管设备就绪，同时把各园区的会议室、设备、账号、权限与统计口径一并梳理清楚，" +
        "并把跨地域协同的会议平台、纪要归档与检索入口全部对齐，避免各处做法不一致造成新的管理负担。",
    );
    const { out } = await runReview(responding(bloated));
    expect(out.fixed).toBe(0);
    expect(out.markdown).toBe(MD);
  });

  it("模型返回的不是 JSON → 用更短的提示重试一次，仍失败才跳过（跳过原因要具体）", async () => {
    const mock = dshMock(() => "我读了一遍，感觉还行。");
    const { out, progress } = await runReview(mock);

    expect(out.skipped).toBeTruthy();
    expect(out.issues).toBe(0);
    expect(out.markdown).toBe(MD);
    // 通读 1 次 + 重试 1 次；不解析就没有后续改动与复查
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.user).toContain(REVIEW_RETRY_PROMPT_MARKER);
    // 第二次的提示刻意更短（只重复格式要求）
    expect(mock.calls[1]!.user.length).toBeLessThan(mock.calls[0]!.user.length);
    expect(
      progress.some(
        (m) => m.includes("终检跳过（首次输出") && m.includes("非合规 JSON，重试后仍失败"),
      ),
    ).toBe(true);
  });

  it("首次吐垃圾、重试返回合法 JSON → 终检照常跑完", async () => {
    const mock = dshMock((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return "我读了一遍，感觉还行。";
      if (input.user.includes(REVIEW_RETRY_PROMPT_MARKER)) return ISSUES;
      if (input.user.includes(FIX_PROMPT_MARKER)) return CHAPTER_FIXED;
      return '{"unresolved":[]}';
    });
    const { out, progress } = await runReview(mock);

    expect(out.issues).toBe(1);
    expect(out.fixed).toBe(1);
    expect(out.markdown).toContain("本方案先统一预约入口");
    expect(progress.some((m) => m.includes("首次输出") && m.includes("重试一次"))).toBe(true);
    expect(progress.some((m) => m.includes("终检：发现 1 处，改了 1 处，留 0 处提示"))).toBe(true);
  });

  it("代码围栏 + 前后寒暄也能解析（不因为多写一句就白跑一遍终检）", async () => {
    const mock = dshMock((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) {
        return `我通读了一遍，发现一处问题：\n\n\`\`\`json\n${ISSUES}\n\`\`\`\n\n以上。`;
      }
      if (input.user.includes(FIX_PROMPT_MARKER)) return CHAPTER_FIXED;
      return '{"unresolved":[]}';
    });
    const { out } = await runReview(mock);
    expect(out.fixed).toBe(1);
    // 解析成功 → 不重试
    expect(mock.calls.some((c) => c.user.includes(REVIEW_RETRY_PROMPT_MARKER))).toBe(false);
  });

  it("返回合法 JSON 但 issues 为空 → 通读只调一次，不再重试也不改章", async () => {
    const mock = dshMock((input) =>
      input.user.includes(REVIEW_PROMPT_MARKER) ? '{"issues":[]}' : "不该走到这里",
    );
    const { out, progress } = await runReview(mock);
    expect(mock.calls).toHaveLength(1);
    expect(out.issues).toBe(0);
    expect(out.markdown).toBe(MD);
    expect(progress.some((m) => m.includes("未发现"))).toBe(true);
  });

  it("模型调用抛错 → 跳过终检，出稿照常", async () => {
    const mock = dshMock(() => new Error("DSH 断连"));
    const { out } = await runReview(mock);
    expect(out.skipped).toContain("DSH 断连");
    expect(out.markdown).toBe(MD);
  });

  it("矛盾类两轮都没修好 → 记硬伤（hard: true），这份不算通过", async () => {
    const mock = responding(
      CHAPTER_FIXED,
      '{"unresolved":[{"anchor":"这句话前后矛盾","note":"还读不通"}]}',
    );
    const { out, progress } = await runReview(mock);
    expect(out.fixed).toBe(0);
    expect(out.remaining).toBe(1);
    // 改动本身已经落进正文（复查只影响提示，不回滚）
    expect(out.markdown).toContain("本方案先统一预约入口");
    // 通读 + 改章 + 复查 + 第二轮回炉 + 第二轮复查
    expect(mock.calls).toHaveLength(5);
    const v = out.violations.find((x) => x.kind === "终检问题");
    expect(v?.hard).toBe(true);
    expect(v?.detail).toContain("两轮未消除");
    expect(progress.some((m) => m.includes("第二轮回炉"))).toBe(true);
    expect(progress.some((m) => m.includes("不算通过"))).toBe(true);
  });

  it("第二轮才修好的：不记硬伤，按已解决计", async () => {
    let verifies = 0;
    const mock = dshMock((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return ISSUES;
      if (input.user.includes(VERIFY_PROMPT_MARKER)) {
        verifies += 1;
        return verifies === 1
          ? '{"unresolved":[{"anchor":"这句话前后矛盾","note":"还读不通"}]}'
          : '{"unresolved":[]}';
      }
      if (input.user.includes(FIX_PROMPT_MARKER)) return CHAPTER_FIXED;
      return "";
    });
    const { out, progress } = await runReview(mock);
    expect(out.fixed).toBe(1);
    expect(out.remaining).toBe(0);
    expect(out.violations.some((v) => v.kind === "终检问题")).toBe(false);
    expect(progress.some((m) => m.includes("矛盾类硬伤"))).toBe(true);
  });

  it("空话套话这类软问题仍是提示，不进第二轮回炉（hard: false）", async () => {
    const softIssues = JSON.stringify({
      issues: [
        { chapter: "现状与问题", anchor: "这句话前后矛盾", type: "空话套话", note: "没有信息" },
      ],
    });
    const mock = dshMock((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) return softIssues;
      if (input.user.includes(VERIFY_PROMPT_MARKER)) {
        return '{"unresolved":[{"anchor":"这句话前后矛盾","note":"还空"}]}';
      }
      if (input.user.includes(FIX_PROMPT_MARKER)) return CHAPTER_FIXED;
      return "";
    });
    const { out } = await runReview(mock);
    expect(out.remaining).toBe(1);
    const v = out.violations.find((x) => x.kind === "终检问题");
    expect(v?.hard).toBe(false);
    expect(v?.detail).toContain("终检存疑");
  });

  it("终检时在整篇上再跑一遍确定性判据（断头段是硬伤，带 from: 终检）", async () => {
    const broken = `${MD}\n\n、Teams 等云平台；多园区由 IT 支持。`;
    const mock = dshMock(() => "not json");
    const { out } = await runReview(mock, broken);
    const v = out.violations.find((x) => x.kind === "悬空残句");
    expect(v?.hard).toBe(true);
    expect(v?.from).toBe("终检");
  });

  it('review: "off" → 一次终检调用都不发，正文原样', async () => {
    const mock = responding(CHAPTER_FIXED);
    const { out } = await runReview(mock, MD, false);
    expect(mock.calls).toHaveLength(0);
    expect(out.markdown).toBe(MD);
    expect(out.issues).toBe(0);
  });

  it("不合规的问题条目被丢弃（锚点定位不到）", async () => {
    const mock = dshMock((input) => {
      if (input.user.includes(REVIEW_PROMPT_MARKER)) {
        return JSON.stringify({
          issues: [
            { chapter: "现状与问题", anchor: "正文里没有这句", type: "重复", note: "编的" },
            {
              chapter: "现状与问题",
              anchor: "这句话前后矛盾",
              type: "前后矛盾",
              note: "真的",
            },
          ],
        });
      }
      if (input.user.includes(FIX_PROMPT_MARKER)) return CHAPTER_FIXED;
      return '{"unresolved":[]}';
    });
    const { out } = await runReview(mock);
    expect(out.dropped).toBe(1);
    expect(out.issues).toBe(1);
    expect(out.fixed).toBe(1);
  });
});
