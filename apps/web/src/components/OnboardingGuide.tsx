import React, { useEffect } from "react";
import { FLOW_STEPS } from "@scene/contract";
import type { ApiDefaultModelRef } from "../api";

/**
 * 首次启动引导（用户定调 2026-10-22）
 *
 * 第一次打开应用时，先把「能跑起来」的三件事摆出来：配模型、导资料、建场景。
 * 用户可跳过，但页面同时把产品怎么用（6 步流程）讲清楚，跳过后仍能从
 * 左栏底部「使用引导」重开——引导不是一次性弹窗，而是一页可回看的使用说明。
 */
export interface OnboardingGuideProps {
  open: boolean;
  /** 模型是否可用；null = 还在检查 */
  modelReady: boolean | null;
  defaultModel: ApiDefaultModelRef | null;
  /** 已导入的产品线数；null = 还没取到 */
  lineCount: number | null;
  projectCount: number;
  /** 关闭/跳过：本次之后不再自动弹出（仍可手动重开） */
  onClose: () => void;
  onGoSettings: () => void;
  onGoLibrary: () => void;
  onNewScenario: () => void;
}

interface StepProps {
  n: number;
  done: boolean;
  title: string;
  desc: string;
  status: string;
  action: string;
  onAction: () => void;
}

const Step: React.FC<StepProps> = ({ n, done, title, desc, status, action, onAction }) => (
  <li className={`onboard-step${done ? " done" : ""}`}>
    <span className="onboard-num" aria-hidden="true">
      {done ? "✓" : n}
    </span>
    <div className="onboard-step-main">
      <h4>{title}</h4>
      <p>{desc}</p>
      <span className={`onboard-status${done ? " ok" : ""}`}>{status}</span>
    </div>
    <button className="btn btn-sm onboard-act" type="button" onClick={onAction}>
      {action}
    </button>
  </li>
);

export const OnboardingGuide: React.FC<OnboardingGuideProps> = ({
  open,
  modelReady,
  defaultModel,
  lineCount,
  projectCount,
  onClose,
  onGoSettings,
  onGoLibrary,
  onNewScenario,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const modelDone = modelReady === true;
  const modelStatus =
    modelReady === null
      ? "正在检查模型配置…"
      : modelDone
        ? `已配置${defaultModel ? ` · ${defaultModel.provider} / ${defaultModel.model}` : ""}`
        : "未配置——分析与联网调研都跑不了";
  const materialDone = (lineCount ?? 0) > 0;
  const materialStatus =
    lineCount === null
      ? "正在读取产品资料库…"
      : materialDone
        ? `已有 ${lineCount} 条产品线`
        : "还没有产品资料——先建产品线，再上传材料";
  const projectDone = projectCount > 0;
  const projectStatus = projectDone
    ? `已有 ${projectCount} 个场景`
    : "还没有场景——从一个具体问题开始";

  return (
    <div
      className="onboard-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="onboard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboard-title"
      >
        <header className="onboard-hd">
          <div>
            <span className="onboard-kicker">开始之前</span>
            <h2 id="onboard-title">欢迎使用场景通</h2>
            <p>先补齐下面三件事，分析和联网调研才跑得起来；只差一两步也可以直接用。</p>
          </div>
          <button className="onboard-x" type="button" aria-label="关闭引导" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="onboard-body">
          <section className="onboard-setup" aria-label="首次设置">
            <h3>先完成这三步</h3>
            <ol className="onboard-steps">
              <Step
                n={1}
                done={modelDone}
                title="设置默认模型"
                desc="分析、调研、写交付物都依赖模型；没配置时只能手工填表。"
                status={modelStatus}
                action={modelDone ? "调整" : "去设置"}
                onAction={onGoSettings}
              />
              <Step
                n={2}
                done={materialDone}
                title="导入产品资料"
                desc="产品线、规格、能力、边界越全，能力匹配和方案越靠谱。"
                status={materialStatus}
                action="去导入"
                onAction={onGoLibrary}
              />
              <Step
                n={3}
                done={projectDone}
                title="新建场景"
                desc="从一个具体场景开始，按 6 步推进到一份可讲的解决方案。"
                status={projectStatus}
                action="新建场景"
                onAction={onNewScenario}
              />
            </ol>
          </section>

          <aside className="onboard-flow" aria-label="产品使用流程">
            <h3>产品怎么用</h3>
            <ol>
              {FLOW_STEPS.map((s) => (
                <li key={s.id}>
                  <span className="onboard-flow-num" aria-hidden="true">
                    {s.id}
                  </span>
                  <div>
                    <b>{s.title}</b>
                    <p>{s.goal}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="onboard-tip">
              每一步都能中途停下、改表、重算；结论都带来源，查不到就写「未知」，不会编。
            </p>
          </aside>
        </div>

        <footer className="onboard-ft">
          <button className="btn" type="button" onClick={onClose}>
            跳过，先自己看看
          </button>
          <span className="onboard-note">之后可在左栏底部「使用引导」重新打开</span>
        </footer>
      </div>
    </div>
  );
};
