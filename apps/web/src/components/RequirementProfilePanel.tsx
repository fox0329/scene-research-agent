import React, { useCallback, useEffect, useState } from "react";
import { requirements, type ApiGapHints, type ApiRequirementEntry } from "../api";
import { useToast } from "./Toast";

/**
 * 需求画像面板（反思优化模块 MR1-T5，右栏）
 *
 * 不藏深：每条目的来源（用户原话片段）与状态全部展开可见，折叠区只做视觉收纳、
 * 不藏信息；编辑/关闭/升级降级一律二次确认或失焦保存，没有静默改动。
 */

interface RequirementProfilePanelProps {
  projectId: string;
}

const KIND_LABEL: Record<ApiRequirementEntry["kind"], string> = {
  explicit: "明确要求",
  preference: "偏好",
  constraint: "禁忌",
  dimension_gap: "缺维度",
};

const CONF_LABEL: Record<ApiRequirementEntry["confidence"], string> = {
  用户原话: "原话",
  用户操作: "操作",
  AI推断: "推断",
};

interface EntryHandlers {
  onExpand?: (id: string) => void;
  onPromote?: (id: string) => void;
  onDemote?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onDismissConfirm?: (id: string) => void;
  onSaveText?: (id: string, text: string) => void;
}

/** 条目渲染（纯函数导出供测试）：徽标/来源/操作按钮全部可见，不藏深 */
export function renderProfileEntry(
  e: ApiRequirementEntry,
  opts: { expanded: boolean; confirmingId?: string | null } & EntryHandlers,
): React.ReactElement {
  const expanded = opts.expanded;
  return (
    <div className="rp-entry" data-status={e.status}>
      <div className="rp-line">
        <span
          className="rp-text ed"
          contentEditable
          suppressContentEditableWarning
          title="点击编辑，失焦保存"
          onBlur={(ev) => {
            const v = ev.currentTarget.textContent ?? "";
            if (v && v !== e.text) opts.onSaveText?.(e.id, v);
          }}
        >
          {e.text}
        </span>
        <span className={`rp-badge rp-${e.scope}`}>{e.scope === "user" ? "全局" : "场景"}</span>
        <span className="rp-badge">{KIND_LABEL[e.kind]}</span>
        <span className={`rp-badge rp-conf-${e.confidence}`}>{CONF_LABEL[e.confidence]}</span>
        {e.status !== "active" && <span className="rp-badge rp-st">{e.status}</span>}
      </div>
      <div className="rp-actions">
        <button className="btn btn-sm" type="button" onClick={() => opts.onExpand?.(e.id)}>
          {expanded ? "收起来源" : `来源(${e.sources.length})`}
        </button>
        {e.scope === "scene" ? (
          <button className="btn btn-sm" type="button" onClick={() => opts.onPromote?.(e.id)} title="升级为用户级：对所有场景生效">
            升级
          </button>
        ) : (
          <button className="btn btn-sm" type="button" onClick={() => opts.onDemote?.(e.id)} title="降级回本场景">
            降级
          </button>
        )}
        {opts.confirmingId === e.id ? (
          <button className="btn btn-sm rp-danger" type="button" onClick={() => opts.onDismissConfirm?.(e.id)}>
            确认关闭？
          </button>
        ) : (
          <button className="btn btn-sm" type="button" onClick={() => opts.onDismiss?.(e.id)}>
            关闭
          </button>
        )}
      </div>
      {expanded && (
        <div className="rp-sources">
          {e.sources.length === 0 && <span className="rp-src-empty">无来源记录</span>}
          {e.sources.map((s, i) => (
            <div className="rp-src" key={`${s.ref}-${i}`}>
              <span className="rp-src-type">{s.type}</span>
              <span className="rp-src-snippet">{s.snippet}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RequirementProfilePanel({ projectId }: RequirementProfilePanelProps) {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<ApiRequirementEntry[]>([]);
  const [candidates, setCandidates] = useState<ApiRequirementEntry[]>([]);
  const [clarifyHints, setClarifyHints] = useState<ApiGapHints["clarify_hints"]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await requirements.list(projectId);
      setEntries(data.entries);
      setCandidates(data.upgrade_candidates);
      setClarifyHints(data.clarify_hints ?? []);
    } catch (err: unknown) {
      showToast(`画像加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [projectId, showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveText = useCallback(
    async (id: string, text: string) => {
      try {
        await requirements.patch(id, { text });
        showToast("已保存");
        void reload();
      } catch (err: unknown) {
        showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [reload, showToast],
  );

  const dismiss = useCallback(
    async (id: string) => {
      try {
        await requirements.dismiss(id);
        showToast("已关闭并进黑名单（同文不再抽回）");
        setConfirmId(null);
        void reload();
      } catch (err: unknown) {
        showToast(`关闭失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [reload, showToast],
  );

  const promote = useCallback(
    async (id: string) => {
      try {
        await requirements.patch(id, { scope: "user" });
        showToast("已升级为用户级（全局生效）");
        void reload();
      } catch (err: unknown) {
        showToast(`升级失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [reload, showToast],
  );

  const demote = useCallback(
    async (id: string) => {
      try {
        await requirements.demote(id, projectId);
        showToast("已降级回本场景");
        void reload();
      } catch (err: unknown) {
        showToast(`降级失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, reload, showToast],
  );

  const clearScene = useCallback(async () => {
    const sceneEntries = entries.filter((e) => e.scope === "scene");
    for (const e of sceneEntries) {
      await requirements.dismiss(e.id).catch(() => null);
    }
    showToast(`已关闭 ${sceneEntries.length} 条本场景条目`);
    setConfirmClear(false);
    void reload();
  }, [entries, reload, showToast]);

  const renderEntry = (e: ApiRequirementEntry) =>
    renderProfileEntry(e, {
      expanded: expandedId === e.id,
      confirmingId: confirmId,
      onExpand: (id) => setExpandedId(expandedId === id ? null : id),
      onPromote: (id) => void promote(id),
      onDemote: (id) => void demote(id),
      onDismiss: (id) => setConfirmId(id),
      onDismissConfirm: (id) => void dismiss(id),
      onSaveText: (id, text) => void saveText(id, text),
    });

  return (
    <div className="rp-panel">
      <div className="det-h">
        <h3>需求画像</h3>
        {confirmClear ? (
          <button className="btn btn-sm rp-danger" type="button" onClick={() => void clearScene()}>
            确认清空 {entries.filter((e) => e.scope === "scene").length} 条？
          </button>
        ) : (
          <button className="btn btn-sm" type="button" onClick={() => setConfirmClear(true)}>
            清空场景条目
          </button>
        )}
      </div>
      <div className="det-body rp-body">
        {clarifyHints.length > 0 && (
          <div className="rp-group">
            <h4>该你拍板（缺口澄清提醒）</h4>
            {clarifyHints.map((h, i) => (
              <div className="rp-finding" key={`${h.location}-${i}`}>
                <span className="rp-badge rp-conf-用户原话">{h.location}</span>
                <span className="rp-text">{h.detail}</span>
              </div>
            ))}
          </div>
        )}
        {entries.length === 0 && <p className="rp-empty">暂无条目——对话中提出的要求会自动记入。</p>}
        {entries.map(renderEntry)}
        {candidates.length > 0 && (
          <div className="rp-group">
            <h4>升级候选（同要求出现在 ≥2 个场景，确认后全局生效）</h4>
            {candidates.map(renderEntry)}
          </div>
        )}
      </div>
    </div>
  );
}
