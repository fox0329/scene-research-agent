/**
 * @scene/web — 场景诉求（第一输入）三段式
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
 *
 * v1.5：字段表单与对照表**导出为可复用子组件**——
 *  - 新建项目仍走本对话框（项目还不存在，必须先建）
 *  - 流程第 1 步（场景诉求）在项目工作台里**内嵌**同一套表单与对照表
 * 两处共用同一实现，避免各写一份后漂移。
 */

import React, { useCallback, useEffect, useState } from "react";
import { alignmentWithBrief } from "@scene/domain";
import { asSourceType } from "./stage-snapshot";
import { api, ApiError, type ApiAnchorRow, type ApiScenarioBrief } from "../api";

// ─── 表单模型（对话框与内嵌面板共用） ──────────────────────

export interface BriefForm {
  scene_name: string;
  intent: string;
  customer_hint: string;
  region_hint: string;
  scope_hint: string;
  audience: string;
  deadline: string;
}

export const EMPTY_BRIEF_FORM: BriefForm = {
  scene_name: "",
  intent: "",
  customer_hint: "",
  region_hint: "",
  scope_hint: "",
  audience: "",
  deadline: "",
};

/** 已有诉求 → 表单（缺省空串，避免 undefined 进受控 input） */
export function briefToForm(brief: ApiScenarioBrief): BriefForm {
  return {
    scene_name: brief.scene_name,
    intent: brief.intent,
    customer_hint: brief.customer_hint ?? "",
    region_hint: brief.region_hint ?? "",
    scope_hint: brief.scope_hint ?? "",
    audience: brief.audience ?? "",
    deadline: brief.deadline ?? "",
  };
}

/** 表单 → 接口入参（去掉首尾空白；空串即"没说过"） */
export function formToBriefPayload(form: BriefForm): {
  scene_name: string;
  intent: string;
  customer_hint: string;
  region_hint: string;
  scope_hint: string;
  audience: string;
  deadline: string;
} {
  return {
    scene_name: form.scene_name.trim(),
    intent: form.intent.trim(),
    customer_hint: form.customer_hint.trim(),
    region_hint: form.region_hint.trim(),
    scope_hint: form.scope_hint.trim(),
    audience: form.audience.trim(),
    deadline: form.deadline.trim(),
  };
}

// ─── 可复用子组件 ①：字段表单 ──────────────────────────────

/** 字段分组：对话框分三步问，内嵌面板一次全展示 */
export type BriefFieldSection = "name" | "intent" | "clues";

export const BriefFieldGroup: React.FC<{
  section: BriefFieldSection;
  form: BriefForm;
  onChange: (key: keyof BriefForm, value: string) => void;
  /** 进入该段时自动聚焦（对话框逐步问时用） */
  autoFocus?: boolean;
}> = ({ section, form, onChange, autoFocus }) => {
  if (section === "name") {
    return (
      <label className="brief-field">
        <span className="brief-label">
          ① 场景名称 <em>必填</em>
        </span>
        <input
          className="brief-input"
          value={form.scene_name}
          onChange={(e) => onChange("scene_name", e.target.value)}
          placeholder="例如：智慧水务"
          autoFocus={autoFocus}
        />
      </label>
    );
  }

  if (section === "intent") {
    return (
      <label className="brief-field">
        <span className="brief-label">
          ② 你想搞清楚什么 <em>必填</em>
        </span>
        <textarea
          className="brief-input brief-textarea"
          value={form.intent}
          onChange={(e) => onChange("intent", e.target.value)}
          placeholder="一句话即可，例如：这个场景值不值得进 / 怎么进 / 值多少"
          autoFocus={autoFocus}
        />
        <span className="brief-hint">
          这句话是后续所有阶段的基准，也是确认系统理解是否正确的依据。
        </span>
      </label>
    );
  }

  return (
    <div className="brief-grid">
      <label className="brief-field">
        <span className="brief-label">③ 客户 / 行业（选填）</span>
        <input
          className="brief-input"
          value={form.customer_hint}
          onChange={(e) => onChange("customer_hint", e.target.value)}
          placeholder="例如：市政水务集团"
        />
      </label>
      <label className="brief-field">
        <span className="brief-label">地域 / 客户名（选填）</span>
        <input
          className="brief-input"
          value={form.region_hint}
          onChange={(e) => onChange("region_hint", e.target.value)}
          placeholder="例如：华东某市"
        />
      </label>
      <label className="brief-field">
        <span className="brief-label">想覆盖的范围（选填）</span>
        <input
          className="brief-input"
          value={form.scope_hint}
          onChange={(e) => onChange("scope_hint", e.target.value)}
          placeholder="例如：只看出厂到管网"
        />
      </label>
      <label className="brief-field">
        <span className="brief-label">用途（选填）</span>
        <input
          className="brief-input"
          value={form.audience}
          onChange={(e) => onChange("audience", e.target.value)}
          placeholder="自研判断 / 给领导看 / 给客户看"
        />
      </label>
      <label className="brief-field">
        <span className="brief-label">时间要求（选填）</span>
        <input
          className="brief-input"
          value={form.deadline}
          onChange={(e) => onChange("deadline", e.target.value)}
          placeholder="例如：两周"
        />
      </label>
      <span className="brief-hint">
        线索越具体，系统起草的场景锚越贴合；不确定的留空即可，后续阶段会结合产品能力有目的地调研。
      </span>
    </div>
  );
};

// ─── 可复用子组件 ②：对照式确认表 ──────────────────────────

export const ALIGN_LABEL: Record<string, { text: string; hint: string }> = {
  一致: { text: "与你说的不一致？", hint: "已由你确认/补充" },
  系统补充: { text: "系统从资料补充", hint: "来自材料，你没说过" },
  推断: { text: "系统推断", hint: "没有依据，必须由你确认" },
  待补充: { text: "待补充", hint: "还不能确定" },
};

/**
 * 对照式确认表：以用户原话为基准，逐项标出系统理解属于哪种对齐结论
 *
 * 四态分类来自领域层 `alignmentWithBrief`（可单测），前端只渲染。
 */
export const BriefAlignmentTable: React.FC<{
  rows: ApiAnchorRow[];
  /** 需要用户确认的场景本体问题（起草接口产出） */
  questions?: string[];
}> = ({ rows, questions = [] }) => {
  const alignItems = alignmentWithBrief(
    rows.map((a) => ({
      item: a.item,
      content: a.content,
      source_type: asSourceType(a.source_type),
    })),
  );

  return (
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
  );
};

// ─── 新建项目对话框（项目尚不存在时唯一入口） ──────────────

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

export const ScenarioBriefDialog: React.FC<ScenarioBriefDialogProps> = ({
  open,
  projectId,
  defaultName,
  onClose,
  onDone,
}) => {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<BriefForm>({ ...EMPTY_BRIEF_FORM, scene_name: defaultName ?? "" });
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
          if (r.brief) setForm(briefToForm(r.brief));
        })
        .catch(() => undefined);
    } else {
      setCreatedId(null);
      setForm({ ...EMPTY_BRIEF_FORM, scene_name: defaultName ?? "" });
    }
  }, [open, projectId, defaultName]);

  const set = (k: keyof BriefForm, v: string): void => setForm((prev) => ({ ...prev, [k]: v }));

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
      await api.saveBrief(id, formToBriefPayload(form));
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
            <BriefFieldGroup section="name" form={form} onChange={set} autoFocus />
          ) : null}
          {step === 2 ? (
            <BriefFieldGroup section="intent" form={form} onChange={set} autoFocus />
          ) : null}
          {step === 3 ? <BriefFieldGroup section="clues" form={form} onChange={set} /> : null}
          {step === 4 && anchor ? (
            <BriefAlignmentTable rows={anchor} questions={questions} />
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
