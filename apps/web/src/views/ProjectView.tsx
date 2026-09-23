import React, { useState } from "react";
import { Stage0Panel } from "./stages/Stage0Panel";
import { Stage1Panel } from "./stages/Stage1Panel";
import { Stage2Panel } from "./stages/Stage2Panel";
import { Stage3Panel } from "./stages/Stage3Panel";
import { Stage4Panel } from "./stages/Stage4Panel";
import { Stage5Panel } from "./stages/Stage5Panel";
import { Stage6Panel } from "./stages/Stage6Panel";
import { Stage7Panel } from "./stages/Stage7Panel";
import { Stage8Panel } from "./stages/Stage8Panel";
import {
  STAGES,
  type Project,
  type StageDef,
} from "../mock/project-data";

interface ProjectViewProps {
  project: Project;
}

/* ═══ 阶段 3-8：占位 ═══ */

const StagePlaceholder: React.FC<{ stage: StageDef }> = ({ stage }) => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>
          阶段 {stage.index} · {stage.label}
        </h2>
        <p>本阶段面板将在后续任务实现</p>
      </div>
    </div>
    <div className="pnl-b">
      <div className="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <div className="empty-state-title">待实现</div>
        <div className="empty-state-desc">
          阶段 {stage.index}「{stage.label}」的内容面板属于后续任务范围
        </div>
      </div>
    </div>
  </div>
);

/* ═══ 视图主体 ═══ */

/**
 * 项目工作台视图
 * 页头（48px）+ 9 阶段 Tab（完成态绿点、当前高亮）+ 阶段面板（0-2 实现，3-8 占位）
 */
export const ProjectView: React.FC<ProjectViewProps> = ({ project }) => {
  const [activeStage, setActiveStage] = useState(project.stage);

  const isProjectDone = project.status === "done";
  const badgeText = isProjectDone
    ? "已完成 · 交付物"
    : `阶段 ${project.stage} ${STAGES[project.stage]!.label}`;
  const badgeCls = isProjectDone ? "success" : "primary";

  const handleNext = () => {
    setActiveStage((prev) => Math.min(prev + 1, 8));
  };

  const renderStagePanel = () => {
    switch (activeStage) {
      case 0:
        return <Stage0Panel project={project} onNext={handleNext} />;
      case 1:
        return (
          <Stage1Panel
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      case 2:
        return (
          <Stage2Panel
            project={project}
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      case 3:
        return (
          <Stage3Panel
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      case 4:
        return (
          <Stage4Panel
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      case 5:
        return (
          <Stage5Panel
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      case 6:
        return (
          <Stage6Panel
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      case 7:
        return (
          <Stage7Panel
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      case 8:
        return (
          <Stage8Panel
            onNext={handleNext}
            onSupplement={() => {}}
            onStop={() => {}}
          />
        );
      default:
        return <StagePlaceholder stage={STAGES[activeStage]!} />;
    }
  };

  return (
    <>
      {/* 页头：项目名 + 阶段徽标（单行 48px） */}
      <div className="pgh pgh-fixed">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <div className="pgt">{project.name}</div>
          <span className={`badge ${badgeCls}`}>{badgeText}</span>
        </div>
        <div className="pga">
          <button className="btn" type="button">上传材料</button>
          <button className="btn primary" type="button">完成阶段</button>
        </div>
      </div>

      {/* 阶段 Tab：完成态显示绿点，当前激活高亮 */}
      <div className="stabs" role="tablist" aria-label="分析阶段">
        {STAGES.map((stage) => {
          const isDone = stage.index < project.stage;
          const isActive = activeStage === stage.index;
          return (
            <button
              key={stage.index}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`stab${isActive ? " active" : ""}${isDone ? " done" : ""}`}
              onClick={() => setActiveStage(stage.index)}
            >
              <span className="sd" />
              {stage.label}
            </button>
          );
        })}
      </div>

      {/* 阶段面板 */}
      <div className="ws">{renderStagePanel()}</div>
    </>
  );
};