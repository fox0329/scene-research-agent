/**
 * requirement-profile repo 单测（MR1-T1）
 *
 * 覆盖：事件唯一写入口、条目 CRUD、升级/降级、场景视图合并、dismissed 黑名单。
 * 领域规则（合并/冲突/置信判定）属 MR1-T3，不在本文件。
 */

import { describe, expect, it } from "vitest";
import { createDb } from "@scene/infra";
import {
  demoteToScene,
  insertRequirement,
  listDismissedTexts,
  listInteractionEvents,
  listRequirements,
  listUpgradeCandidates,
  recordInteractionEvent,
  updateRequirement,
} from "./requirement-profile.js";

function db() {
  return createDb(":memory:");
}

const SOURCE = [{ type: "message" as const, ref: "m1", snippet: "给运营口的人看" }];

describe("recordInteractionEvent（唯一写入口）", () => {
  it("五处埋点动作各写一行，字段完整", () => {
    const d = db();
    const actions = [
      "edit_cell",
      "confirm",
      "undo",
      "rewrite",
      "suggest_accept",
    ] as const;
    for (const action of actions) {
      const rec = recordInteractionEvent(d, {
        scenario_id: "s1",
        conversation_id: "c1",
        surface: "ui",
        action,
        target: "表1-1",
        detail: { row: 1 },
      });
      expect(rec.id).toBeTruthy();
      expect(rec.action).toBe(action);
    }
    const events = listInteractionEvents(d, "s1");
    expect(events).toHaveLength(5);
    // 按时间倒序：最后写入的排最前
    expect(events[0]!.action).toBe("suggest_accept");
  });

  it("detail 与 target 缺省时落空值不报错", () => {
    const d = db();
    const rec = recordInteractionEvent(d, { surface: "conversation", action: "undo" });
    expect(rec.target).toBe("");
    expect(rec.detail_json).toBe("{}");
  });
});

describe("requirement_profile CRUD 与升级流", () => {
  it("插入默认 active，带锚点与来源", () => {
    const d = db();
    const entry = insertRequirement(d, {
      scenario_id: "s1",
      scope: "scene",
      kind: "constraint",
      text: "不提国产替代",
      check_anchor: { type: "keyword", terms: ["国产", "替代"], mode: "命中即违反" },
      confidence: "用户原话",
      sources: SOURCE,
    });
    expect(entry.status).toBe("active");
    expect(entry.check_anchor?.type).toBe("keyword");
    const list = listRequirements(d, "s1");
    expect(list).toHaveLength(1);
    expect(list[0]!.sources[0]!.snippet).toBe("给运营口的人看");
  });

  it("场景视图 = 本场景条目 + 全局用户级条目", () => {
    const d = db();
    insertRequirement(d, {
      scenario_id: "s1",
      scope: "scene",
      kind: "explicit",
      text: "篇幅两页纸",
      confidence: "用户原话",
      sources: SOURCE,
    });
    insertRequirement(d, {
      scenario_id: null,
      origin_scenario_id: "s0",
      scope: "user",
      kind: "preference",
      text: "总是关心成本",
      confidence: "用户原话",
      sources: SOURCE,
    });
    insertRequirement(d, {
      scenario_id: "s2",
      scope: "scene",
      kind: "explicit",
      text: "别的场景的条目",
      confidence: "用户原话",
      sources: SOURCE,
    });
    const view = listRequirements(d, "s1");
    // 同毫秒写入时 updated_at 相同、排序不稳定，断言与顺序无关
    expect(new Set(view.map((e) => e.text))).toEqual(new Set(["篇幅两页纸", "总是关心成本"]));
  });

  it("升级：scope 置 user 时 scenario_id 置 NULL、origin 留溯源（评审修订 #353）", () => {
    const d = db();
    const entry = insertRequirement(d, {
      scenario_id: "s1",
      scope: "scene",
      kind: "preference",
      text: "两页纸",
      confidence: "用户原话",
      sources: SOURCE,
    });
    const promoted = updateRequirement(d, entry.id, { scope: "user" });
    expect(promoted!.scope).toBe("user");
    expect(promoted!.scenario_id).toBeNull();
    expect(promoted!.origin_scenario_id).toBe("s1");
  });

  it("降级：回 scene 并挂到指定场景", () => {
    const d = db();
    const entry = insertRequirement(d, {
      scenario_id: null,
      origin_scenario_id: "s1",
      scope: "user",
      kind: "preference",
      text: "两页纸",
      confidence: "用户原话",
      sources: SOURCE,
    });
    const demoted = demoteToScene(d, entry.id, "s9");
    expect(demoted!.scope).toBe("scene");
    expect(demoted!.scenario_id).toBe("s9");
    expect(demoted!.origin_scenario_id).toBe("s1");
  });

  it("升级候选：同文本在 ≥2 场景 active 才入选", () => {
    const d = db();
    for (const sid of ["s1", "s2"]) {
      insertRequirement(d, {
        scenario_id: sid,
        scope: "scene",
        kind: "preference",
        text: "重点讲防汛",
        confidence: "用户原话",
        sources: SOURCE,
      });
    }
    insertRequirement(d, {
      scenario_id: "s1",
      scope: "scene",
      kind: "explicit",
      text: "只出现一次的条目",
      confidence: "用户原话",
      sources: SOURCE,
    });
    const candidates = listUpgradeCandidates(d);
    expect(candidates.map((e) => e.text)).toEqual(["重点讲防汛"]);
  });

  it("dismissed 进黑名单且不进场景视图", () => {
    const d = db();
    const entry = insertRequirement(d, {
      scenario_id: "s1",
      scope: "scene",
      kind: "preference",
      text: "用户不要的条目",
      confidence: "AI推断",
      sources: SOURCE,
    });
    updateRequirement(d, entry.id, { status: "dismissed" });
    expect(listRequirements(d, "s1")).toHaveLength(0);
    expect(listDismissedTexts(d)).toEqual(["用户不要的条目"]);
  });

  it("手编文本直接覆盖（用户编辑赢）", () => {
    const d = db();
    const entry = insertRequirement(d, {
      scenario_id: "s1",
      scope: "scene",
      kind: "explicit",
      text: "旧口径",
      confidence: "AI推断",
      sources: SOURCE,
    });
    const patched = updateRequirement(d, entry.id, { text: "用户改的口径" });
    expect(patched!.text).toBe("用户改的口径");
    expect(patched!.confidence).toBe("AI推断"); // 手编不改置信，置信判定在领域层
  });

  it("锚点可由用户清除（NULL = 仅提示级）", () => {
    const d = db();
    const entry = insertRequirement(d, {
      scenario_id: "s1",
      scope: "scene",
      kind: "constraint",
      text: "不提国产替代",
      check_anchor: { type: "regex", pattern: "国产|替代", mode: "命中即违反" },
      confidence: "用户原话",
      sources: SOURCE,
    });
    const patched = updateRequirement(d, entry.id, { check_anchor: null });
    expect(patched!.check_anchor).toBeNull();
  });
});
