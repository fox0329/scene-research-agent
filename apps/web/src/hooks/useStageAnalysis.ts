/**
 * @scene/web — 本步分析的运行态
 *
 * 为什么不放在面板里：用户定调「中栏只放信息，动作都在上面」——
 * 第 2–8 步的触发按钮上移到流程轴的「下一步」位（没产出时它就是「开始本步分析」），
 * 而进度流仍显示在中栏。触发点在流程轴、显示在中栏，这份状态就放在共同父级。
 *
 * 收尾口径（用户实测：连接断了但界面永远停在「分析中」，刷新页面才看到早已生成完）：
 * 进度流的消费交给 `consumeAnalysisStream`——断线按 Last-Event-ID 续连、静默超时由
 * 看门狗续连；**无论怎么结束都回调一次 `onSettled`**，由父级刷新本步数据与流程状态，
 * 所以"服务端写完了、界面还停在分析中"不会再发生。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { tableDisplayName } from "@scene/contract";
import { advanceStageStream, reconnectStageStream, type FollowEvent } from "../api";
import { consumeAnalysisStream } from "./analysis-stream";

export interface StageAnalysisState {
  running: boolean;
  /** 本次分析已用时长（m:ss）：长跑时"还在动"要看得见 */
  elapsedLabel: string;
  /** 进度行（最多保留 8 条） */
  streamLines: readonly string[];
  start: () => void;
}

/** 进度行上限：再多也看不清，反而把中栏撑长 */
const MAX_LINES = 8;
/** 分析进度的心跳/文案合并节流窗口 */
const ELAPSED_TICK_MS = 1000;

export function useStageAnalysis(opts: {
  projectId: string;
  stage: number;
  stepId?: number | undefined;
  /** 分析落库（收到 done）回调：父级可做轻量联动（如刷新项目列表） */
  /**
   * 本次分析收尾（成功）回调
   *
   * `info.tablesFailed` = 按表并发生成时没成功的那几张表（服务端会保留它们的原有内容）——
   * 界面必须说出来，不能让用户以为"全好了"。
   * `info.tablesNeedMaterial` = 现状类表（表1-2 / 表2-7）因为**没有客户材料**而没生成的数量——
   * 这不是失败，是要用户先补材料（用户定调 2026-10-14：干脆不生成，直接提示需要先补材料）。
   */
  onDone?: (info?: { tablesFailed?: string[]; tablesNeedMaterial?: string[] }) => void;
  /**
   * 本次运行**结束**（正常完成 / 出错 / 连接续连失败）后回调一次
   *
   * 前端不该假设"一定收得到 done"：连接可能中途断掉，而服务端其实已经写完并落库。
   * 收尾一律对账（重取流程状态 + 本步数据），界面才不会停在「分析中」。
   */
  onSettled?: () => void;
  /** 失败回调（父级负责弹出提示；中栏不再有进度区，提示是唯一可见出口） */
  onError?: (message: string) => void;
  /**
   * 非致命提示（如"进度连接没能恢复，已按服务端结果对账"）
   *
   * 进度行从 v1.20 起不进中栏了，这类情况只能靠提示让用户知道，
   * 否则界面上只是一个不再变化的按钮。
   */
  onWarn?: (message: string) => void;
  /**
   * 打开进度流的方式（缺省 = 本步分析）
   *
   * 交付物这一步（第 7 步）不跑阶段分析，而是**生成报告**：它同样长跑、同样要进度、
   * 同样要按 Last-Event-ID 续连，所以复用这套运行态，只换开流方式。
   */
  openStream?: (lastEventId: string | null, signal: AbortSignal) => AsyncIterable<FollowEvent>;
}): StageAnalysisState {
  const { projectId, stage, stepId, onDone, onSettled, onError, onWarn, openStream } = opts;
  const [running, setRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    setElapsedSec(0);
    const timer = setInterval(() => setElapsedSec((n) => n + 1), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const push = useCallback((line: string) => {
    setStreamLines((prev) => [...prev, line].slice(-MAX_LINES));
  }, []);

  const start = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setStreamLines(["已发起本步分析…"]);
    void (async () => {
      let terminal = false;
      /**
       * 本地运行态的硬兜底
       *
       * 连接层最坏情况是 130 秒看门狗 ×3（首次 + 2 次续连）≈ 6.5 分钟；超过 15 分钟
       * 还在「分析中」必然是别处出了问题。用户实测（故障 #64）：分析早已跑完、库里
       * 33 行都在，按钮却一直显示「分析中」，等到的人只能反复刷新——有了这条兜底，
       * 界面自己会收口并提示，不必等用户想办法。
       */
      const hardStop = setTimeout(() => {
        push("【提示】本步运行时间异常偏长，已自动对账本步数据（结果可能早已生成）");
        onWarn?.("本步运行时间异常偏长，已自动对账；若数据已生成可直接查看");
        runningRef.current = false;
        setRunning(false);
        onSettled?.();
      }, 15 * 60_000);
      try {
        const result = await consumeAnalysisStream({
          open: (lastEventId) => {
            /* 第一条连接是 POST /advance（真正跑分析）；续连走 GET /events（按 id 重放） */
            const sink = { lastId: lastEventId };
            const controller = new AbortController();
            const events =
              openStream !== undefined
                ? openStream(lastEventId, controller.signal)
                : lastEventId === null
                  ? advanceStageStream(projectId, stage, stepId, sink, controller.signal)
                  : reconnectStageStream(projectId, stage, lastEventId, sink, controller.signal);
            return { events, abort: () => controller.abort() };
          },
          onEvent: (ev) => {
            if (ev.type === "progress") {
              // 服务端 progress 事件用 `message`（`text` 只有上传链路用）：
              // 只读 text 会让每条进度都变成同一句「分析中…」，看着像卡死。
              push(String(ev.message ?? ev.text ?? "分析中…"));
            } else if (ev.type === "error") {
              const message = String(ev.message ?? "");
              push(`【错误】${message}`);
              onError?.(message);
            } else if (ev.type === "postcheck") {
              // 生成后三问自检（规则 G-R8）：这是每次生成都会走的固定环节，
              // 用户要能看见"查了多少、改了多少、有没有降级"——不能只在后台悄悄跑。
              const rep = (ev.report ?? {}) as {
                checked?: number;
                fixed?: number;
                downgraded?: number;
                remaining?: number;
              };
              push(
                `【自检】三问（真实·客观·价值）检 ${rep.checked ?? 0} 行，自动改正 ${rep.fixed ?? 0} 行` +
                  (rep.downgraded ? `，${rep.downgraded} 行按实降级` : "") +
                  (rep.remaining ? `，仍有 ${rep.remaining} 处存疑` : "，无遗留存疑"),
              );
            } else if (ev.type === "done") {
              const tablesFailed = Array.isArray(ev.tablesFailed)
                ? (ev.tablesFailed as string[])
                : [];
              const tablesNeedMaterial = Array.isArray(ev.tablesNeedMaterial)
                ? (ev.tablesNeedMaterial as string[])
                : [];
              /* 交付物门限（变更表 #244）：硬伤未消除就不算通过，必须让用户看见 */
              const hardViolations = Array.isArray(ev.violations)
                ? (ev.violations as { kind?: string; detail?: string; hard?: boolean }[]).filter(
                    (v) => v.hard === true,
                  )
                : [];
              const notes = [
                ev.passed === false
                  ? `【未通过】还有 ${hardViolations.length} 处硬伤没消除：` +
                    hardViolations
                      .slice(0, 3)
                      .map((v) => String(v.detail ?? v.kind ?? ""))
                      .join("；") +
                    (hardViolations.length > 3 ? "；…" : "") +
                    "（报告已出，但不算通过，请先改上面的问题）"
                  : "",
                tablesFailed.length > 0
                  ? `${tablesFailed.map(tableDisplayName).join("、")} 未生成成功（沿用原有内容）`
                  : "",
                tablesNeedMaterial.length > 0
                  ? `${tablesNeedMaterial.map(tableDisplayName).join("、")} 需要先补客户材料（现状类表，本次未生成）`
                  : "",
              ].filter((x) => x !== "");
              push(
                notes.length > 0
                  ? `【完成】分析结果已落库；${notes.join("；")}`
                  : "【完成】分析结果已落库",
              );
              onDone?.({ tablesFailed, tablesNeedMaterial });
            }
          },
          onReconnect: (reason) => {
            push(
              reason === "stall"
                ? "连接长时间没有新进度，正在恢复进度…"
                : "进度连接中断，正在恢复…",
            );
          },
        });
        terminal = result.terminal;
        if (!terminal) {
          push("【提示】进度连接没能恢复，已按服务端结果对账本步数据");
          onWarn?.("进度连接没能恢复，已按服务端结果刷新本步数据（结果可能已经落库）");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        push(`【错误】${message}`);
        onError?.(message);
      } finally {
        clearTimeout(hardStop);
        /* 顺序要紧：先把运行态摘掉，再对账。对账里任何一步抛错都不能把按钮
           永远钉在「分析中」（一旦钉住，start() 开头的守卫会让后续点击全部失效）。 */
        runningRef.current = false;
        setRunning(false);
        try {
          // 不管拿到没拿到终局事件都对账一次：服务端可能早已写完（连接断在收尾那段）
          onSettled?.();
        } catch {
          /* 对账失败不影响运行态收尾 */
        }
      }
    })();
  }, [projectId, stage, stepId, push, onDone, onSettled, onError, onWarn, openStream]);

  const elapsedLabel = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;
  return { running, elapsedLabel, streamLines, start };
}
