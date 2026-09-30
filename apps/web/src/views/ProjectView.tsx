import React, { useCallback, useState } from "react";
import { RealStagePanel } from "./RealStagePanel";
import { DemoStagePanel } from "./DemoStagePanel";
import { api } from "../api";
import { useAsync } from "../hooks/useAsync";
import { useToast } from "../components/Toast";
import { MaterialUpload } from "../components/MaterialUpload";
import { MaterialSourcesBar } from "./MaterialSourcesBar";
import type { StageSnapshot } from "../components/stage-snapshot";
import {
  STAGES,
  type Project,
  type StageDef,
} from "../mock/project-data";

interface ProjectViewProps {
  project: Project;
  /** true = 联真模式（真实后端数据）；false = 演示模式（mock 面板） */
  live: boolean;
  hasProjects: boolean;
  /** 阶段数据/决策导致项目状态变化后，通知父级刷新列表 */
  onProjectsChanged?: () => void;
  /** 空项目引导新建（联真模式） */
  onNewProject?: () => void;
  /** 右栏阶段快照（联真模式）：补充说明 + 确认清单 + 阶段总结 */
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 主动弹出对话抽屉（v1.14）：定义/澄清生成后让用户直接对话 */
  onOpenConversation?: (convId?: string) => void;
}

/* ═══ 阶段 3-8：占位（仅演示模式） ═══ */

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
 * 页头（48px）+ 9 阶段 Tab（完成态绿点、当前高亮）+ 阶段面板
 * - 联真模式：统一渲染 RealStagePanel（rows/gates/advice 来自后端）
 * - 演示模式：保留 9 个手工 mock 面板（E2E 交互规范断言依赖）
 */
export const ProjectView: React.FC<ProjectViewProps> = ({
  project,
  live,
  onProjectsChanged,
  onStageSnapshot,
  onOpenConversation,
}) => {
  const [activeStage, setActiveStage] = useState(project.stage);
  const { showToast } = useToast();

  /* 资料失效横幅（联真模式）：上游表改动后提示受影响阶段 */
  const stale = useAsync(
    () => (live ? api.staleInfo(project.id) : Promise.resolve(null)),
    [live, project.id],
  );

  const isProjectDone = project.status === "done";
  const badgeText = isProjectDone
    ? "已完成 · 交付物"
    : `阶段 ${project.stage} ${STAGES[project.stage]!.label}`;
  const badgeCls = isProjectDone ? "success" : "primary";

  const handleNext = () => {
    setActiveStage((prev) => Math.min(prev + 1, 8));
  };

  /** 页头「完成阶段」：联真走 decide(继续) 落库，演示仅本地切页 */
  const handleCompleteStage = useCallback(async () => {
    if (!live) {
      handleNext();
      return;
    }
    try {
      const updated = await api.decide(project.id, activeStage, "继续");
      showToast(`已确认继续，项目进入阶段 ${updated.current_stage}`);
      setActiveStage(updated.current_stage);
      onProjectsChanged?.();
    } catch (err: unknown) {
      showToast(`阶段推进失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [live, project.id, activeStage, showToast, onProjectsChanged]);


  /** 场景澄清（v1.12）：系统在对话里提出需要确认的问题——不许不管场景蒙头分析 */
  const [clarifying, setClarifying] = useState(false);
  const runClarify = useCallback(async () => {
    setClarifying(true);
    try {
      const r = await api.clarifyScenario(project.id);
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
  }, [project.id, showToast, onOpenConversation]);

  /** 编辑场景描述（分析锚）：改后即影响后续全部阶段分析 */
  const editDescription = useCallback(async () => {
    const next = window.prompt(
      "场景描述（分析锚）· 客户/行业、要解决的问题、目标与边界",
      project.description ?? "",
    );
    if (next === null) return;
    try {
      await api.patchProject(project.id, { description: next.trim() });
      showToast("场景描述已保存，后续分析将围绕它展开");
      onProjectsChanged?.();
    } catch (err: unknown) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [project.id, project.description, showToast, onProjectsChanged]);

  /** 交付物双口径导出（T5.6）：真实链路落服务端 exports/，toast 回显路径 */
  const [exporting, setExporting] = useState(false);
  const handleExport = useCallback(async () => {
    if (!live) {
      showToast("演示模式：导出仅在实时数据模式可用");
      return;
    }
    if (exporting) return;
    setExporting(true);
    try {
      const r = await api.exportDeliverables(project.id);
      showToast(`双口径导出完成：内部版 ${r.internal_path}；客户版 ${r.external_path}`);
    } catch (err: unknown) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  }, [live, exporting, project.id, showToast]);

  const renderStagePanel = () => {
    if (live) {
      return (
        <RealStagePanel
          projectId={project.id}
          stage={activeStage}
          stageLabel={STAGES[activeStage]!.label}
          onChanged={onProjectsChanged}
          onStageSnapshot={onStageSnapshot}
        />
      );
    }
    // 演示模式：同一套 schema 与领域逻辑（列/固定行/完整度/总结都来自注册表）
    return <DemoStagePanel stage={activeStage} onStageSnapshot={onStageSnapshot} />;
  };

  return (
    <>
      {/* 页头：项目名 + 数据来源徽标 + 阶段徽标（单行 48px） */}
      <div className="pgh pgh-fixed">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <div className="pgt">{project.name}</div>
          {live ? (
            <span className="badge success">实时数据</span>
          ) : (
            <span className="badge warning">演示数据</span>
          )}
          <span className={`badge ${badgeCls}`}>{badgeText}</span>
        </div>
        <div className="pga">
          {live && project.product_line_id ? (
            <MaterialUpload
              lineId={project.product_line_id}
              onDone={() => onProjectsChanged?.()}
            />
          ) : (
            <button
              className="btn"
              type="button"
              onClick={() => showToast("演示模式：上传入口仅为示意")}
            >
              上传材料
            </button>
          )}
          <button className="btn" type="button" onClick={() => void handleExport()} disabled={exporting}>
            {exporting ? "导出中…" : "导出交付物"}
          </button>
          <button className="btn primary" type="button" onClick={() => void handleCompleteStage()}>
            完成阶段
          </button>
        </div>
      </div>

      {/* 场景锚（v1.11）：分析的事实锚点——全部阶段产出围绕它 */}
      {live && (
        <div className="material-sources" role="group" aria-label="场景锚">
          <span className="badge primary">场景锚</span>
          <span className="provider-item-meta">
            {(project.description || "").trim()
              ? project.description
              : "⚠ 场景描述未填——分析将缺少锚点，产出易发散（点右侧填写）"}
          </span>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => void editDescription()}
          >
            编辑描述
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={clarifying}
            onClick={() => void runClarify()}
          >
            {clarifying ? "生成问题中…" : "场景澄清"}
          </button>
        </div>
      )}

      {/* 资料来源（v1.10）：专属库 + 引用通用库，分析时合并 */}
      {live && <MaterialSourcesBar projectId={project.id} ownLineId={project.product_line_id} onChanged={onProjectsChanged} />}

      {/* 资料失效横幅（上游表被改动，本阶段结果需重算） */}
      {live && stale.status === "ok" && stale.data?.banner && (
        <div className="stale-banner" role="status">
          <span className="badge warning">资料更新</span>
          {stale.data.banner}
        </div>
      )}

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
