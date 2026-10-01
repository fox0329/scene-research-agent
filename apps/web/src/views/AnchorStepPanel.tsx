/**
 * @scene/web — 第 2 步「场景定义与边界」面板（联真）
 *
 * 这一步是**确认步**：系统按诉求与资料起草了表1-1（场景锚），但"系统理解"不等于
 * "用户说的"——必须由用户逐项确认，确认过的行下游才当作依据。
 *
 * 与旧版（阶段 1 里读只读锚表）的差别：
 *  - 表1-1 **可就地编辑**（改内容即视为用户补充，来源标记随之变化）
 *  - 明确提示「带 ✓ 的 6 项需你确认」，确认入口在右栏确认清单，也可在此直接改
 *  - 本步就绪判定（服务端）：6 项 L1 全部为「用户确认 / 用户补充」
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep } from "@scene/contract";
import { buildChecklist, l1Rows } from "@scene/domain";
import { api, type ApiAnchorRow, type ApiFlowStatus } from "../api";
import { AnchorTable } from "../components/SchemaTable";
import { FlowCompleteness } from "../components/FlowCompleteness";
import { asSourceType, type StageSnapshot } from "../components/stage-snapshot";
import { useToast } from "../components/Toast";

export interface AnchorStepPanelProps {
  projectId: string;
  flow: ApiFlowStatus;
  onChanged?: () => void;
  onFlowChanged?: () => void;
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 场景澄清：模型提出需要用户回答的问题后弹出对话抽屉 */
  onOpenConversation?: (conversationId?: string) => void;
}

export const AnchorStepPanel: React.FC<AnchorStepPanelProps> = ({
  projectId,
  flow,
  onChanged,
  onFlowChanged,
  onStageSnapshot,
  onOpenConversation,
}) => {
  const { showToast } = useToast();
  const step = flowStep(2);
  const [anchor, setAnchor] = useState<ApiAnchorRow[]>([]);
  const [clarifying, setClarifying] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .getBrief(projectId)
      .then((r) => {
        if (alive) setAnchor(r.anchor);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** 写锚行：确认 / 修改 / 就地编辑都走同一条落库路径 */
  const writeAnchor = useCallback(
    async (next: ApiAnchorRow[]) => {
      setAnchor(next);
      try {
        const r = await api.saveAnchor(projectId, next);
        setAnchor(r.rows);
        onChanged?.();
        onFlowChanged?.();
      } catch (err: unknown) {
        showToast(`锚行保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, onChanged, onFlowChanged, showToast],
  );

  const handleAnchorAction = useCallback(
    (item: string, action: "确认" | "修改", content?: string) => {
      const next = anchor.map((a) =>
        a.item === item
          ? {
              ...a,
              content: content ?? a.content,
              source_type: action === "确认" ? "用户确认" : "用户补充",
              confirm_state: action === "确认" ? "用户确认" : "用户修改",
            }
          : a,
      );
      void writeAnchor(next);
    },
    [anchor, writeAnchor],
  );

  /** 就地编辑内容：用户改过的内容即用户补充（来源标记随内容变化） */
  const handleCellChange = useCallback(
    (rowId: string, _cell: string, value: string) => {
      const index = Number(rowId.replace("anchor-", ""));
      const target = anchor[index];
      if (!target || target.content === value) return;
      const next = anchor.map((a, i) =>
        i === index
          ? { ...a, content: value, source_type: "用户补充", confirm_state: "用户修改" }
          : a,
      );
      void writeAnchor(next);
    },
    [anchor, writeAnchor],
  );

  const runClarify = useCallback(async () => {
    setClarifying(true);
    try {
      const r = await api.clarifyScenario(projectId);
      if (r.need_clarification) {
        onOpenConversation?.(r.conversation_id);
        showToast(`已在对话中提出 ${r.questions.length} 个场景澄清问题，请直接在对话里回答`);
      } else {
        showToast(r.note ?? "场景信息已充分，无需澄清");
      }
    } catch (err: unknown) {
      showToast(`澄清失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClarifying(false);
    }
  }, [projectId, showToast, onOpenConversation]);

  const confirmedL1 = useMemo(
    () =>
      l1Rows().filter((r) => {
        const row = anchor.find((a) => a.item === r.label);
        const st = String(row?.source_type ?? "");
        return st === "用户确认" || st === "用户补充";
      }).length,
    [anchor],
  );
  const l1Total = l1Rows().length;

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
      title: `第 2/${FLOW_TOTAL} 步 · ${step.title}`,
      rows: [],
      completeness: null,
      summary: null,
      summaryLoading: false,
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
      onRefreshSummary: () => undefined,
      onSupplementChange: () => undefined,
      onAnchorAction: handleAnchorAction,
    };
  }, [anchor, step.title, handleAnchorAction]);

  useEffect(() => {
    onStageSnapshot?.(snapshot);
    return () => onStageSnapshot?.(null);
  }, [snapshot, onStageSnapshot]);

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>
              第 2/{FLOW_TOTAL} 步 · {step.title}
            </h2>
            <p>
              {step.goal}；带 ✓ 的 {l1Total} 项需你确认（已确认 {confirmedL1}/{l1Total}），右栏可逐项确认
            </p>
          </div>
          <div className="pnl-actions">
            <button
              className="btn"
              type="button"
              disabled={clarifying}
              onClick={() => void runClarify()}
            >
              {clarifying ? "生成问题中…" : "场景澄清"}
            </button>
          </div>
        </div>
        <div className="pnl-b flush">
          <FlowCompleteness flow={flow} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表1-1 场景概述 · 场景锚（可就地编辑）</h2>
            <p>
              改内容即视为「用户补充」并立即落库；确认一项即标「用户确认」——只有这两类来源下游才当依据
            </p>
          </div>
        </div>
        <div className="pnl-b flush">
          <AnchorTable
            rows={anchor.map((a, i) => ({ id: `anchor-${i}`, row: { ...a } }))}
            onCellChange={handleCellChange}
          />
        </div>
      </div>
    </>
  );
};
