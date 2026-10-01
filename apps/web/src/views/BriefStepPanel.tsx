/**
 * @scene/web — 第 1 步「场景诉求」内嵌面板（联真）
 *
 * v1.5 把新建项目时的三段式诉求**搬进项目工作台**：
 * 项目已经存在时再弹窗问一遍是多余的，用户只需要在"现在这一步"回答问题。
 * 字段表单与对照表复用 `ScenarioBriefDialog` 导出的子组件（同一实现，两处共用）。
 *
 * 本步就绪判定（服务端）：`scenario_brief.intent` 非空。
 * 「起草场景锚」之后出现**对照式确认表**——以用户原话为基准看系统理解对不对，
 * 之后第 2 步才逐项确认。
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { buildChecklist } from "@scene/domain";
import { api, ApiError, type ApiAnchorRow, type ApiFlowStatus } from "../api";
import { AnchorTable } from "../components/SchemaTable";
import { FlowCompleteness } from "../components/FlowCompleteness";
import {
  BriefAlignmentTable,
  BriefFieldGroup,
  EMPTY_BRIEF_FORM,
  briefToForm,
  formToBriefPayload,
  type BriefForm,
} from "../components/ScenarioBriefDialog";
import { asSourceType, type StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";

export interface BriefStepPanelProps {
  projectId: string;
  flow: ApiFlowStatus;
  /** 数据变化（刷新左栏项目列表） */
  onChanged?: () => void;
  /** 就绪状态可能变化：请父级重取 /flow */
  onFlowChanged?: () => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
}

export const BriefStepPanel: React.FC<BriefStepPanelProps> = ({
  projectId,
  flow,
  onChanged,
  onFlowChanged,
  onStageSnapshot,
}) => {
  const { showToast } = useToast();
  const step = flowStep(1);
  const [form, setForm] = useState<BriefForm>(EMPTY_BRIEF_FORM);
  const [anchor, setAnchor] = useState<ApiAnchorRow[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [drafted, setDrafted] = useState(false);
  const [busy, setBusy] = useState<"save" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getBrief(projectId)
      .then((r) => {
        if (!alive) return;
        if (r.brief) setForm(briefToForm(r.brief));
        setAnchor(r.anchor);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  const setField = (k: keyof BriefForm, v: string): void =>
    setForm((prev) => ({ ...prev, [k]: v }));

  /** 保存诉求（不阻断：字段本身必填判定交给就绪提示） */
  const saveBrief = useCallback(async (): Promise<boolean> => {
    if (!form.intent.trim()) {
      setError("请用一句话说明你想搞清楚什么（这是本产品的第一输入）");
      return false;
    }
    setError(null);
    setBusy("save");
    try {
      const r = await api.saveBrief(projectId, formToBriefPayload(form));
      setAnchor(r.anchor);
      showToast("场景诉求已保存");
      onChanged?.();
      onFlowChanged?.();
      return true;
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }, [form, projectId, showToast, onChanged, onFlowChanged]);

  /** 起草场景锚：诉求 + 资料库 → 表1-1，随后展示对照式确认表 */
  const draftAnchor = useCallback(async () => {
    if (!(await saveBrief())) return;
    setBusy("draft");
    try {
      const draft = await api.draftBrief(projectId);
      setAnchor(draft.rows);
      setQuestions(draft.open_questions);
      setDrafted(true);
      showToast(
        draft.used_llm
          ? "已按你的诉求与资料起草场景锚，请在下方对照检查"
          : "已按线索预填场景锚（模型未参与），请在下方对照检查",
      );
      onChanged?.();
      onFlowChanged?.();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [saveBrief, projectId, showToast, onChanged, onFlowChanged]);

  /* 右栏数据面：确认清单（L1 来自表1-1 必确认行）+ 场景锚内容 */
  /* 右栏 Tab ② 的阶段总结：**每一步都要有**（用户定调"每阶段一份总结文档供参考，这才是价值"），
     因此第 1、2 步也加载（阶段 1 的总结由服务端确定性生成，内容以缺口清单为主） */
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const loadSummary = useCallback(
    async (refresh = false) => {
      setSummaryLoading(true);
      try {
        const r = await api.stageSummary(projectId, 1, refresh);
        setSummary(r.markdown);
      } catch {
        setSummary(null);
      } finally {
        setSummaryLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    void loadSummary(false);
  }, [loadSummary]);

  const snapshot = useMemo<StageSnapshot | null>(() => {
    const checklist = buildChecklist({
      anchorRows: anchor.map((a) => ({
        item: a.item,
        content: a.content,
        source_type: asSourceType(a.source_type),
      })),
    });
    return {
      stage: 1,
      stageLabel: step.title,
      title: `第 1/${FLOW_TOTAL} 步 · ${step.title}`,
      rows: [],
      completeness: null,
      summary,
      summaryLoading,
      activeTable: "表1-1",
      supplements: [],
      checklist: checklist.items.map((i) => ({
        layer: i.layer,
        tableCode: i.tableCode,
        rowKey: i.rowKey,
        label: i.label,
        state: i.state,
      })),
      anchor,
      onRefreshSummary: () => void loadSummary(true),
      onSupplementChange: () => undefined,
      onAnchorAction: () => undefined,
    };
  }, [anchor, step.title, summary, summaryLoading, loadSummary]);

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  const ready = flow.steps.find((s) => s.id === 1)?.ready ?? false;

  return (
    <>
      <div className="pnl brief-step">
        <div className="pnl-h">
          <div>
            <h2>
              第 1/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>{step.goal}</p>
          </div>
          <div className="pnl-actions">
            <button
              className="btn"
              type="button"
              disabled={busy !== null}
              onClick={() => void saveBrief()}
            >
              {busy === "save" ? "保存中…" : "保存诉求"}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy !== null}
              onClick={() => void draftAnchor()}
            >
              {busy === "draft" ? "起草中…" : "起草场景锚"}
            </button>
          </div>
        </div>
        <div className="pnl-b">
          <BriefFieldGroup section="name" form={form} onChange={setField} autoFocus />
          <BriefFieldGroup section="intent" form={form} onChange={setField} />
          <BriefFieldGroup section="clues" form={form} onChange={setField} />
          <p className="brief-hint">
            第 1 步的就绪条件是「想搞清楚什么」非空（当前：{ready ? "已就绪" : "未就绪"}），
            就绪后点上方流程轴的「完成本步，进入下一步」。
          </p>
          {error ? <p className="modal-error">{error}</p> : null}
        </div>
        <div className="pnl-b flush">
          <FlowCompleteness flow={flow} />
        </div>
      </div>

      {drafted ? (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>对照式确认：系统理解 vs 你的原话</h2>
              <p>标「推断」的行是系统猜的，必须由你在第 2 步确认后下游才当作依据</p>
            </div>
          </div>
          <div className="pnl-b">
            <BriefAlignmentTable rows={anchor} questions={questions} />
          </div>
        </div>
      ) : null}

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表1-1 场景概述 · 场景锚（常驻）</h2>
            <p>全链唯一的场景定义；带 ✓ 的 6 项需你确认，第 2 步在右栏逐项确认</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <AnchorTable
            rows={anchor.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
            readOnly
          />
        </div>
      </div>
    </>
  );
};
