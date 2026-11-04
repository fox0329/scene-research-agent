import React, { useCallback, useState } from "react";
import { refine, type ApiCellDiff, type ApiPipelineFinding, type ApiRefineOutcome } from "../api";
import { useToast } from "./Toast";

/**
 * 差分预览面板（MR2-T4）：手动「按需求重写」→ 必改清单 + 行级差分左右对照 → 应用/忽略。
 * 差分在用户确认前不落库（两道关卡第二道）；应用走 refine/apply（记 edit_cell 埋点）。
 */

interface RefineDiffPanelProps {
  projectId: string;
  stage: number;
  /** 应用成功后通知父级刷新（画像/表格） */
  onApplied?: () => void;
}

const SOURCE_LABEL: Record<ApiPipelineFinding["source"], string> = {
  postcheck: "三问自检",
  reflection: "需求锚点",
  completeness: "完整度",
};

const LEVEL_LABEL: Record<ApiPipelineFinding["level"], string> = {
  mandatory: "必改",
  review: "存疑",
  advisory: "缺数据",
};

export function RefineDiffPanel({ projectId, stage, onApplied }: RefineDiffPanelProps) {
  const { showToast } = useToast();
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<ApiRefineOutcome | null>(null);
  const [ignoredIds, setIgnoredIds] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(true);

  const run = useCallback(async () => {
    setRunning(true);
    setOutcome(null);
    setIgnoredIds(new Set());
    try {
      const result = await refine.run(projectId, stage);
      setOutcome(result);
      if (result.skipped && result.reason === "clean") showToast("没有必改项，直接通过");
      if (result.skipped && result.reason === "over-limit") showToast("今日重写次数已达上限");
      if (result.skipped && result.reason === "no-rows") showToast("当前阶段没有表格数据");
    } catch (err: unknown) {
      showToast(`重写失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [projectId, stage, showToast]);

  const diffKey = (d: ApiCellDiff): string => `${d.tableCode}:${d.rowId}:${d.cell}`;

  const applyOne = useCallback(
    async (d: ApiCellDiff) => {
      try {
        const res = await refine.apply(projectId, [d]);
        if (res.applied > 0) {
          showToast("已应用");
          setIgnoredIds((prev) => new Set(prev).add(diffKey(d)));
          onApplied?.();
        } else {
          showToast("行不存在，未应用");
        }
      } catch (err: unknown) {
        showToast(`应用失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, onApplied, showToast],
  );

  const applyAll = useCallback(async () => {
    if (!outcome) return;
    const pending = outcome.diffs.filter((d) => !ignoredIds.has(diffKey(d)));
    if (pending.length === 0) return;
    try {
      const res = await refine.apply(projectId, pending);
      showToast(`已应用 ${res.applied} 条`);
      setIgnoredIds(new Set(pending.map(diffKey)));
      onApplied?.();
    } catch (err: unknown) {
      showToast(`应用失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [outcome, ignoredIds, projectId, onApplied, showToast]);

  const ignore = useCallback((d: ApiCellDiff) => {
    setIgnoredIds((prev) => new Set(prev).add(diffKey(d)));
  }, []);

  const mandatory = outcome?.findings.filter((f) => f.level === "mandatory") ?? [];
  const pendingDiffs = outcome?.diffs.filter((d) => !ignoredIds.has(diffKey(d))) ?? [];
  // 默认折叠成一行（后台能力不占右栏空间）；有必改或差分时强制展开（差分要人确认）
  const hasContent = (outcome?.findings.length ?? 0) > 0 || (outcome?.diffs.length ?? 0) > 0 || (outcome?.remaining.length ?? 0) > 0;
  const expanded = hasContent || !collapsed;

  return (
    <div className="rdp-panel">
      <div className="det-h">
        <h3 style={{ cursor: "pointer" }} onClick={() => setCollapsed((c) => !c)}>按需求重写</h3>
        <button className="btn btn-sm" type="button" disabled={running} onClick={() => void run()}>
          {running ? "重写中…" : "检查并重写"}
        </button>
      </div>
      {expanded && (
        <div className="det-body rdp-body">
          {outcome && mandatory.length === 0 && pendingDiffs.length === 0 && outcome.remaining.length === 0 && (
            <div className="rdp-finding"><span className="rdp-detail">没有必改项，直接通过</span></div>
          )}
          {outcome && mandatory.length > 0 && (
          <div className="rdp-findings">
            <h4>必改清单（{mandatory.length}）</h4>
            {mandatory.map((f) => (
              <div className="rdp-finding" key={`${f.source}:${f.location}:${f.detail}`}>
                <span className={`rp-badge rdp-${f.level}`}>{LEVEL_LABEL[f.level]}</span>
                <span className="rp-badge">{SOURCE_LABEL[f.source]}</span>
                <span className="rdp-detail">{f.detail}</span>
              </div>
            ))}
          </div>
        )}
        {outcome && pendingDiffs.length > 0 && (
          <div className="rdp-diffs">
            <div className="rdp-diffs-h">
              <h4>建议修改（{pendingDiffs.length}）——确认前不落库</h4>
              <button className="btn btn-sm" type="button" onClick={() => void applyAll()}>
                全部应用
              </button>
            </div>
            {pendingDiffs.map((d) => (
              <div className="rdp-diff" key={diffKey(d)}>
                <div className="rdp-diff-loc">{d.tableCode} · {d.cell}</div>
                <div className="rdp-compare">
                  <span className="rdp-old">{d.oldValue || "（空）"}</span>
                  <span className="rdp-arrow">→</span>
                  <span className="rdp-new">{d.newValue}</span>
                </div>
                <div className="rp-actions">
                  <button className="btn btn-sm" type="button" onClick={() => void applyOne(d)}>
                    应用
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => ignore(d)}>
                    忽略
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {outcome && outcome.remaining.length > 0 && (
          <div className="rdp-remaining">
            <h4>重写后仍未满足（如实报告）</h4>
            {outcome.remaining.map((r) => (
              <div className="rdp-finding" key={r.entryId}>
                <span className="rp-badge rp-danger">未满足</span>
                <span className="rdp-detail">{r.entryText}——{r.detail}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}
    </div>
  );
}
