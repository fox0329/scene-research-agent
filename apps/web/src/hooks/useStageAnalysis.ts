/**
 * @scene/web — 本步分析的运行态（v1.20）
 *
 * 为什么不放在面板里：用户定调「中栏只放信息，动作都在上面」——
 * 第 2–8 步的触发按钮上移到流程轴的「下一步」位（没产出时它就是「开始本步分析」），
 * 而进度流仍显示在中栏。触发点在流程轴、显示在中栏，这份状态就放在共同父级。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { advanceStageStream } from "../api";

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
  /** 分析落库后的收尾刷新（父级重取流程状态与本步数据） */
  onDone?: () => void;
  /** 失败回调（父级负责提示；中栏仍保留错误行） */
  onError?: (message: string) => void;
}): StageAnalysisState {
  const { projectId, stage, stepId, onDone, onError } = opts;
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
      try {
        for await (const ev of advanceStageStream(projectId, stage, stepId)) {
          if (ev.type === "progress") {
            // 服务端 progress 事件用 `message`（`text` 只有上传链路用）：
            // 只读 text 会让每条进度都变成同一句「分析中…」，看着像卡死。
            push(String(ev.message ?? ev.text ?? "分析中…"));
          } else if (ev.type === "error") {
            const message = String(ev.message ?? "");
            push(`【错误】${message}`);
            onError?.(message);
          } else if (ev.type === "done") {
            push("【完成】分析结果已落库");
            onDone?.();
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        push(`【错误】${message}`);
        onError?.(message);
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    })();
  }, [projectId, stage, stepId, push, onDone, onError]);

  const elapsedLabel = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;
  return { running, elapsedLabel, streamLines, start };
}
