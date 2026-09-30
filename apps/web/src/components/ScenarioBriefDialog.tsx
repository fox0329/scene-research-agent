/**
 * @scene/web — 场景诉求（第一输入）三段式对话框
 *
 * 依据 04 §3.0：本产品最重要的输入不是产品资料，而是**用户想梳理什么场景**。
 * 用户不可能一上来写一大段描述，因此拆成三段逐步问：
 *   ① 场景名称（必填）
 *   ② 一句话：你想搞清楚什么（必填，用户诉求的最小完整表达）
 *   ③ 线索（选填）：客户/行业、地域/客户名、想覆盖范围、用途、时间要求
 *
 * 提交后系统**起草场景锚（表1-1）**，并做**对照式确认**——以用户原始诉求为基准，
 * 把系统理解分成四态：一致 / 系统补充 / 推断（需确认）/ 待补充；冲突需语义判断，
 * 交由对话与右栏确认清单处理（不在这里假装能自动判定）。
 */

import React, { useCallback, useEffect, useState } from "react";
import { alignmentWithBrief } from "@scene/domain";
import { asSourceType } from "./stage-snapshot";
import { api, ApiError, type ApiAnchorRow } from "../api";

export interface ScenarioBriefDialogProps {
  open: boolean;
  /** 已有项目 id（修改诉求）；为空表示新建项目流程 */
  projectId?: string | null;
  /** 新建时的默认名称 */
  defaultName?: string;
  onClose: () => void;
  /** 项目就绪（新建完成或诉求已保存） */
  onDone: (projectId: string) => void;
}

interface Form {
  scene_name: string;
  intent: string;
  customer_hint: string;
  region_hint: string;
  scope_hint: string;
  audience: string;
  deadline: string;
}

const EMPTY: Form = {
  scene_name: "",
  intent: "",
  customer_hint: "",
  region_hint: "",
  scope_hint: "",
  audience: "",
  deadline: "",
};

const ALIGN_LABEL: Record<string, { text: string; hint: string }> = {
  一致: { text: "与你说的不一致？", hint: "已由你确认/补充" },
  系统补充: { text: "系统从资料补充", hint: "来自材料，你没说过" },
  推断: { text: "系统推断", hint: "没有依据，必须由你确认" },
  待补充: { text: "待补充", hint: "还不能确定" },
};

export const ScenarioBriefDialog: React.FC<ScenarioBriefDialogProps> = ({
  open,
  projectId,
  defaultName,
  onClose,
  onDone,
}) => {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<Form>({ ...EMPTY, scene_name: defaultName ?? "" });
  const [createdId, setCreatedId] = useState<string | null>(projectId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<ApiAnchorRow[] | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);

  /* 打开时：修改已有项目 → 载入诉求；新建 → 重置 */
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setError(null);
    setAnchor(null);
    setQuestions([]);
    if (projectId) {
      setCreatedId(projectId);
      void api
        .getBrief(projectId)
        .then((r) => {
          if (r.brief) {
            setForm({
              scene_name: r.brief.scene_name,
              intent: r.brief.intent,
              customer_hint: r.brief.customer_hint ?? "",
              region_hint: r.brief.region_hint ?? "",
              scope_hint: r.brief.scope_hint ?? "",
              audience: r.brief.audience ?? "",
              deadline: r.brief.deadline ?? "",
            });
          }
        })
        .catch(() => undefined);
    } else {
      setCreatedId(null);
      setForm({ ...EMPTY, scene_name: defaultName ?? "" });
    }
  }, [open, projectId, defaultName]);

  const set = (k: keyof Form, v: string): void => setForm((prev) => ({ ...prev, [k]: v }));

  /** 第 1 段完成后落库（新建项目在这一步才真正创建） */
  const commitStep1 = useCallback(async (): Promise<void> => {
    if (createdId) return;
    const id = await api.createProject(form.scene_name.trim(), {
      scene_name: form.scene_name.trim(),
    });
    setCreatedId(id.id);
  }, [createdId, form.scene_name]);

  const goNext = useCallback(async () => {
    setError(null);
    if (step === 1) {
      if (!form.scene_name.trim()) {
        setError("请填写场景名称");
        return;
      }
      setBusy(true);
      try {
        await commitStep1();
      } catch (err: unknown) {
        setError(err instanceof ApiError ? err.message : String(err));
        return;
      } finally {
        setBusy(false);
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!form.intent.trim()) {
        setError("请用一句话说明你想搞清楚什么（这是本产品的第一输入）");
        return;
      }
      setStep(3);
      return;
    }
    // 第 3 段：保存诉求 → 起草场景锚 → 展示对照
    const id = createdId;
    if (!id) return;
    setBusy(true);
    try {
      await api.saveBrief(id, {
        scene_name: form.scene_name.trim(),
        intent: form.intent.trim(),
        customer_hint: form.customer_hint.trim(),
        region_hint: form.region_hint.trim(),
        scope_hint: form.scope_hint.trim(),
        audience: form.audience.trim(),
        deadline: form.deadline.trim(),
      });
      const draft = await api.draftBrief(id);
      setAnchor(draft.rows);
      setQuestions(draft.open_questions);
      setStep(4);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [step, form, createdId]);

  if (!open) return null;

  const alignItems = anchor
    ? alignmentWithBrief(
        anchor.map((a) => ({ item: a.item, content: a.content, source_type: asSourceType(a.source_type) })),
      )
    : [];

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="场景诉求">
        <div className="modal-h">
          <h3>场景诉求</h3>
          <p>这是本产品的第一输入：先说要梳理什么场景，再谈能不能做</p>
        </div>

        <div className="modal-steps" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={`step-dot${step >= i ? " active" : ""}`} />
          ))}
        </div>

        <div className="modal-b">
          {step === 1 ? (
            <label className="brief-field">
              <span className="brief-label">
                ① 场景名称 <em>必填</em>
              </span>
              <input
                className="brief-input"
                value={form.scene_name}
                onChange={(e) => set("scene_name", e.target.value)}
                placeholder="例如：智慧水务"
                autoFocus
              />
            </label>
          ) : null}

          {step === 2 ? (
            <label className="brief-field">
              <span className="brief-label">
                ② 你想搞清楚什么 <em>必填</em>
              </span>
              <textarea
                className="brief-input brief-textarea"
                value={form.intent}
                onChange={(e) => set("intent", e.target.value)}
                placeholder="一句话即可，例如：这个场景值不值得进 / 怎么进 / 值多少"
                autoFocus
              />
              <span className="brief-hint">
                这句话是后续所有阶段的基准，也是确认系统理解是否正确的依据。
              </span>
            </label>
          ) : null}

          {step === 3 ? (
            <div className="brief-grid">
              <label className="brief-field">
                <span className="brief-label">③ 客户 / 行业（选填）</span>
                <input
                  className="brief-input"
                  value={form.customer_hint}
                  onChange={(e) => set("customer_hint", e.target.value)}
                  placeholder="例如：市政水务集团"
                />
              </label>
              <label className="brief-field">
                <span className="brief-label">地域 / 客户名（选填）</span>
                <input
                  className="brief-input"
                  value={form.region_hint}
                  onChange={(e) => set("region_hint", e.target.value)}
                  placeholder="例如：华东某市"
                />
              </label>
              <label className="brief-field">
                <span className="brief-label">想覆盖的范围（选填）</span>
                <input
                  className="brief-input"
                  value={form.scope_hint}
                  onChange={(e) => set("scope_hint", e.target.value)}
                  placeholder="例如：只看出厂到管网"
                />
              </label>
              <label className="brief-field">
                <span className="brief-label">用途（选填）</span>
                <input
                  className="brief-input"
                  value={form.audience}
                  onChange={(e) => set("audience", e.target.value)}
                  placeholder="自研判断 / 给领导看 / 给客户看"
                />
              </label>
              <label className="brief-field">
                <span className="brief-label">时间要求（选填）</span>
                <input
                  className="brief-input"
                  value={form.deadline}
                  onChange={(e) => set("deadline", e.target.value)}
                  placeholder="例如：两周"
                />
              </label>
              <span className="brief-hint">
                线索越具体，系统起草的场景锚越贴合；不确定的留空即可，后续阶段会结合产品能力有目的地调研。
              </span>
            </div>
          ) : null}

          {step === 4 && anchor ? (
            <div className="align-wrap">
              <p className="brief-hint">
                系统已按你的诉求与资料起草场景锚（表1-1）。**请对照你原话检查**——下面标「推断」的行是系统猜的，
                必须由你确认后下游才会当作依据。
              </p>
              <table className="schema-table align-table">
                <thead>
                  <tr>
                    <th style={{ width: "28%" }}>项</th>
                    <th>系统理解</th>
                    <th style={{ width: "23%" }}>对照结论</th>
                  </tr>
                </thead>
                <tbody>
                  {alignItems.map((a) => (
                    <tr key={a.rowKey}>
                      <td>{a.label}</td>
                      <td title={a.content}>{a.content || "（未提供）"}</td>
                      <td>
                        <span className={`align-badge align-${a.alignment}`}>
                          {ALIGN_LABEL[a.alignment]?.text ?? a.alignment}
                        </span>
                        <span className="align-hint">{ALIGN_LABEL[a.alignment]?.hint}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {questions.length > 0 ? (
                <div className="align-questions">
                  <h4>需要你确认的场景本体问题</h4>
                  <ul>
                    {questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="modal-error">{error}</p> : null}
        </div>

        <div className="modal-f">
          {step > 1 && step < 4 ? (
            <button className="btn" type="button" onClick={() => setStep(step - 1)} disabled={busy}>
              上一步
            </button>
          ) : null}
          <span className="modal-spacer" />
          {step < 4 ? (
            <>
              <button className="btn" type="button" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button className="btn primary" type="button" onClick={() => void goNext()} disabled={busy}>
                {busy ? "处理中…" : step === 3 ? "起草场景锚" : "下一步"}
              </button>
            </>
          ) : (
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                if (createdId) onDone(createdId);
              }}
            >
              去确认（右栏确认清单）
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
