/**
 * prompt-text — window.prompt 的应用内替代
 *
 * Electron 不支持 window.prompt（一调用就抛 "prompt() is and will not be supported"，
 * 按钮在桌面壳里表现为"毫无反应"——真机反馈「点击新建产品线无效」，故障清单 #70）。
 * 这里用 React 模态输入框替代，样式复用 NewScenarioDialog 的 modal 系列类；
 * 返回 Promise<string | null>：确认给输入值（是否 trim 由调用方决定，与 window.prompt 同语义），取消给 null。
 */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

export interface PromptTextOptions {
  /** 标题（模态头） */
  title: string;
  /** 说明文字（模态头副句） */
  message?: string;
  placeholder?: string;
  /** 预填值（重命名场景） */
  defaultValue?: string;
  /** 确认按钮文字，默认「确定」 */
  okText?: string;
  /** 多行输入（粘贴 JSON 用 textarea） */
  multiline?: boolean;
}

interface ModalProps extends PromptTextOptions {
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

const PromptTextModal: React.FC<ModalProps> = ({
  title,
  message,
  placeholder,
  defaultValue = "",
  okText = "确定",
  multiline = false,
  onSubmit,
  onCancel,
}) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /* 打开即聚焦（复用 NewScenarioDialog 的做法） */
  useEffect(() => {
    const timer = window.setTimeout(() => (inputRef.current ?? areaRef.current)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const submit = (): void => {
    if (value.trim()) onSubmit(value);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          <h3>{title}</h3>
          {message ? <p>{message}</p> : null}
        </div>
        <div className="modal-b">
          {multiline ? (
            <textarea
              ref={areaRef}
              className="brief-input"
              rows={4}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                /* 多行输入里 Enter 要换行，Cmd/Ctrl+Enter 提交 */
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          ) : (
            <input
              ref={inputRef}
              className="brief-input"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          )}
        </div>
        <div className="modal-f">
          <span className="modal-spacer" />
          <button className="btn" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={!value.trim()}>
            {okText}
          </button>
        </div>
      </div>
    </div>
  );
};

export function promptText(opts: PromptTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const close = (value: string | null): void => {
      root.unmount();
      host.remove();
      resolve(value);
    };
    root.render(
      <PromptTextModal {...opts} onCancel={() => close(null)} onSubmit={(v) => close(v)} />,
    );
  });
}
