/**
 * @scene/web — 新建场景（只问名称）
 *
 * 用户定调：场景定义不该让用户一项一项填空。所以新建入口只问一个名字，
 * 建完直接打开独立的「场景定义」对话页——场景本体在对话里聊清楚，
 * 再由「整理成定义」写进表1-1，而不是在这里填三段式表单。
 */

import React, { useEffect, useRef, useState } from "react";

export interface NewScenarioDialogProps {
  open: boolean;
  /** 提交中（创建项目 —— 网络往返） */
  busy?: boolean;
  /** 创建失败的原因（服务端返回的中文说明） */
  error?: string | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export const NewScenarioDialog: React.FC<NewScenarioDialogProps> = ({
  open,
  busy = false,
  error = null,
  onSubmit,
  onClose,
}) => {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  /* 每次打开清空并聚焦（复用同一个实例，避免上次的残留） */
  useEffect(() => {
    if (!open) return;
    setName("");
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="新建场景">
        <div className="modal-h">
          <h3>新建场景</h3>
          <p>先给这个场景起个名字，接着我们直接开聊——场景定义在对话里说清楚</p>
        </div>

        <div className="modal-b">
          <label className="brief-field">
            <span className="brief-label">
              场景名称 <em>必填</em>
            </span>
            <input
              ref={inputRef}
              className="brief-input"
              value={name}
              placeholder="例如：智慧水务"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          {error ? <p className="modal-error">{error}</p> : null}
        </div>

        <div className="modal-f">
          <span className="modal-spacer" />
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={submit}
            disabled={busy || name.trim().length === 0}
          >
            {busy ? "创建中…" : "创建并开始定义"}
          </button>
        </div>
      </div>
    </div>
  );
};
