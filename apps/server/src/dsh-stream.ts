/**
 * @scene/server — DSH 流式调用的一次封装（变更表 #139 从 deliverable-report 抽出）
 *
 * 交付物生成与**交付物终检**都要"起一个会话、把提示词喂进去、边收正文边推进度"，
 * 两处必须是同一套语义（心跳、错误、长度截断），所以抽成独立模块，避免复制两份。
 */

import type { DshClient, FollowEvent, SessionHandle } from "@scene/contract";

/** 一次流式调用：累加正文 + 上报进度 */
export async function streamPrompt(args: {
  dshClient: DshClient;
  session: SessionHandle;
  system: string;
  user: string;
  label: string;
  keepaliveMs: number;
  push: (event: FollowEvent) => void;
}): Promise<{ text: string; error?: string }> {
  const { dshClient, session, system, user, label, keepaliveMs, push } = args;
  let text = "";
  let lastBeat = Date.now();
  try {
    const iterator = dshClient
      .prompt(session, { system, user, outputContract: {} })
      [Symbol.asyncIterator]();
    let pending = iterator.next();
    for (;;) {
      // 心跳：模型思考期间没有正文，超过一个心跳就报一次"仍在写"，否则界面看着像卡死
      // ⚠️ 这里必须复用同一个 next() 承诺：心跳赢得竞速时**不能**把已发出的 next() 丢掉——
      // 异步生成器不会把已取走的值还回来，重发 next() 会永久丢失那一块正文（实测吞掉的就是开头
      // 那几个字符，报告"第一段从半句开始"与 PPT 大纲"不是合规 JSON"都源于此，变更表 #143）
      const step = await Promise.race([
        pending,
        new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), keepaliveMs)),
      ]);
      if (step === "tick") {
        push({ type: "progress", message: `${label}：模型仍在撰写（已写 ${text.length} 字）…` });
        continue;
      }
      pending = iterator.next();
      if (step.done) break;
      const event = step.value;
      if (event.type === "text") {
        text += String((event as { text?: string }).text ?? "");
        if (Date.now() - lastBeat >= 3000) {
          lastBeat = Date.now();
          push({ type: "progress", message: `${label}：已写 ${text.length} 字…` });
        }
      }
      if (event.type === "error") {
        return { text, error: `${label}：${String(event["message"] ?? "模型调用出错")}` };
      }
      if (event.type === "done" && String(event["finishReason"] ?? "") === "length") {
        return { text, error: `${label} 的输出被长度上限截断` };
      }
    }
  } catch (err: unknown) {
    return { text, error: `${label} 调用失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return { text };
}
