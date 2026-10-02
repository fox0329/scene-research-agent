import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, STAGE_DEFS, flowStep, type InfoStageId } from "@scene/contract";
import { RealStagePanel } from "./RealStagePanel";
import { DemoStagePanel } from "./DemoStagePanel";
import { AnchorStepPanel } from "./AnchorStepPanel";
import { DeliveryPanel } from "./DeliveryPanel";
import { DemoFirstStep } from "./DemoFlowPanels";
import { FlowRail } from "../components/FlowRail";
import { api, type ApiAnchorRow, type ApiFlowStatus } from "../api";
import { useAsync } from "../hooks/useAsync";
import { useStageAnalysis } from "../hooks/useStageAnalysis";
import { useToast } from "../components/Toast";
import { MaterialUpload } from "../components/MaterialUpload";
import { MaterialSourcesBar } from "./MaterialSourcesBar";
import type { StageSnapshot } from "../components/stage-snapshot";
import type { Project } from "../mock/project-data";
import { DEMO_ANCHOR, buildDemoFlowStatus } from "../mock/demo-flow";

interface ProjectViewProps {
  project: Project;
  /** true = 联真模式（真实后端数据）；false = 演示模式（mock 面板） */
  live: boolean;
  hasProjects: boolean;
  /** 阶段数据/决策导致项目状态变化后，通知父级刷新列表 */
  onProjectsChanged?: () => void;
  /** 空项目引导新建（联真模式） */
  onNewProject?: () => void;
  /** 右栏阶段快照：补充说明 + 确认清单 + 阶段总结 */
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 主动弹出对话抽屉（v1.14）：定义/澄清生成后让用户直接对话 */
  /**
   * 定义对话在 App 层发生变化（新建场景后直接开聊）的信号（自增计数）
   *
   * 第 1 步面板据此重取定义状态——否则面板停在"还没聊过"的旧快照上。
   */
  definitionRefresh?: number;
}

/** 组装步（最后一步）对应的落库阶段 */
const DELIVERY_STAGE = 7;

/**
 * 项目工作台（v1.5 逐页推进）
 *
 * 与 v1.4 的差别：**去掉 8 个阶段并列 tab**，改为「流程轴 + 当前步面板」。
 * 阶段仍是数据落库口径，但用户只面对"现在这一步"（8 步，与底层 8 个阶段一一对应）：
 *   1 场景定义与边界（定义对话 + 需要表态的项）→ 2-7 逐步分析 → 8 组装交付物
 *
 * 流程状态是唯一权威：
 *  - 联真：`GET /flow`（就绪判定由服务端按数据算）
 *  - 演示：本地内存 + `mock/demo-flow.ts`（同一套 `buildFlowStatus` 状态机）
 */
export const ProjectView: React.FC<ProjectViewProps> = ({
  project,
  live,
  onProjectsChanged,
  onStageSnapshot,
  definitionRefresh = 0,
}) => {
  const { showToast } = useToast();

  /** 联真流程状态（服务端算好的就绪判定） */
  const [liveFlow, setLiveFlow] = useState<ApiFlowStatus | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  /** 演示流程状态（本地内存：已完成的步骤号） */
  const [demoCompleted, setDemoCompleted] = useState<readonly number[]>([]);
  const [demoAnchor, setDemoAnchor] = useState<ApiAnchorRow[]>(DEMO_ANCHOR);
  /** null = 跟随当前步；数字 = 用户正在回看的某一步 */
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** 本场景资料面板（默认收起，避免把上传入口摊在页头） */
  const [materialsOpen, setMaterialsOpen] = useState(false);

  const demoFlow = useMemo(
    () =>
      buildDemoFlowStatus({
        completed: demoCompleted,
        anchor: demoAnchor,
      }),
    [demoCompleted, demoAnchor],
  );
  const flow = live ? liveFlow : demoFlow;
  const step = activeStep ?? flow?.currentStep ?? 1;
  const stepDef = flow?.steps.find((s) => s.id === step);
  const current = flow?.steps.find((s) => s.id === flow.currentStep);
  const stepStage = (flowStep(step).stage ?? DELIVERY_STAGE) as InfoStageId;

  /** 资料失效横幅（联真）：上游表改动后提示受影响阶段 */
  const stale = useAsync(
    () => (live ? api.staleInfo(project.id) : Promise.resolve(null)),
    [live, project.id],
  );

  const reloadFlow = useCallback(
    async (follow = false): Promise<ApiFlowStatus | null> => {
      if (!live) return null;
      try {
        const f = await api.getFlow(project.id);
        setLiveFlow(f);
        setFlowError(null);
        if (follow) setActiveStep(null);
        return f;
      } catch (err: unknown) {
        setFlowError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [live, project.id],
  );

  useEffect(() => {
    void reloadFlow();
  }, [reloadFlow]);

  /** 本步数据刷新令牌：分析落库后 +1，面板据此重取本步数据与阶段总结 */
  const [analysisRefresh, setAnalysisRefresh] = useState(0);

  /**
   * 本步分析的运行态（v1.20）
   *
   * 用户定调「中栏只放信息，动作都在上面」：触发布钮上移到流程轴，
   * 进度流仍在中栏——两边都要这份状态，所以放在共同父级这里。
   */
  const analysis = useStageAnalysis({
    projectId: project.id,
    stage: stepStage,
    stepId: step,
    // done 只是"更快知道成功了"：真正决定界面收敛的是下面的 onSettled
    onDone: () => onProjectsChanged?.(),
    /**
     * 运行结束（成功 / 失败 / 连接续连失败）都对账一次
     *
     * 用户实测：「一直显示分析中，刷新页面才发现早就生成完了」——服务端写完了、
     * 连接却断在收尾那段，前端拿不到 done。收尾无条件重取流程状态与本步数据，
     * 界面就不会停在「分析中」，也不会显示过期数据。
     */
    onSettled: () => {
      setAnalysisRefresh((n) => n + 1);
      onProjectsChanged?.();
      void reloadFlow(true);
    },
    onError: (message) => showToast(`本步分析失败：${message}`),
  });

  /**
   * 场景定义对话整理/关闭后，**流程状态必须重取**
   *
   * 曾经漏了这一步：App 层的「场景定义」弹窗（新建场景时自动打开的那条主路径）
   * 整理成功后只刷新了项目列表与定义数据，流程轴仍拿着旧状态——
   * 表现是用户聊完、整理完、关掉弹窗后，「完成本步」还是灰的（服务端其实已就绪）。
   * 两条路径（App 弹窗 / 第 1 步面板弹窗）都会 bump definitionRefresh，这里统一接住。
   */
  useEffect(() => {
    if (definitionRefresh > 0) void reloadFlow();
  }, [definitionRefresh, reloadFlow]);

  /** 完成本步（导航动作，不判断信息齐备与否） */
  const handleComplete = useCallback(async () => {
    if (!flow || busy) return;
    const n = flow.currentStep;
    setBusy(true);
    try {
      if (live) {
        const f = await api.completeFlowStep(project.id, n);
        setLiveFlow(f);
        setFlowError(null);
        setActiveStep(null);
        onProjectsChanged?.();
        showToast(`已完成第 ${n} 步，进入第 ${f.currentStep} 步`);
      } else {
        setDemoCompleted((prev) => (prev.includes(n) ? prev : [...prev, n]));
        setActiveStep(null);
      }
    } catch (err: unknown) {
      showToast(`推进失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [flow, busy, live, project.id, onProjectsChanged, showToast]);

  /** 回到某一步重跑：清该步及其后的完成标记（数据保留） */
  const handleReopen = useCallback(
    async (n: number) => {
      if (busy) return;
      setBusy(true);
      try {
        if (live) {
          const f = await api.reopenFlowStep(project.id, n);
          setLiveFlow(f);
          setActiveStep(n);
          onProjectsChanged?.();
        } else {
          setDemoCompleted((prev) => prev.filter((id) => id < n));
          setActiveStep(n);
        }
        showToast(`已回到第 ${n} 步重跑（该步及其后的完成标记已清，数据保留）`);
      } catch (err: unknown) {
        showToast(`回退失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, live, project.id, onProjectsChanged, showToast],
  );

  /** 演示态：确认 / 修改锚行（只改本地内存） */
  /**
   * 演示态：「确认无误」= 一次整表确认（与联真同义）
   *
   * 只写 `confirm_state`，不动 `source_type`——来源是溯源信息，用户认可不等于来源变了。
   */
  /** 演示态：就地编辑锚行内容（视为用户补充） */
  const handleDemoAnchorEdit = useCallback((index: number, content: string) => {
    setDemoAnchor((prev) =>
      prev.map((a, i) =>
        i === index
          ? { ...a, content, source_type: "用户补充", confirm_state: "用户修改" }
          : a,
      ),
    );
  }, []);

  /** 演示态：对话「整理成定义」结果落到本地表1-1 */
  const handleDemoAnchorConsolidated = useCallback((rows: ApiAnchorRow[]) => {
    setDemoAnchor(rows.map((r) => ({ ...r })));
  }, []);

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

  /**
   * 顶部按钮位（用户定调「中栏不放按钮，上面有下一步」）
   *
   *  - 本步还没产出（服务端 ready=false）→ 这个位置是「开始本步分析」
   *  - 已产出但有资料因上游改动失效    → 这个位置是「重算本步」
   *  - 其余                            → 「下一步」（完成本步并前进）
   * 只在「当前步 + 模型分析步」上接管，回看历史步与交付步不受影响。
   */
  const stepStale = (stale.data?.stages ?? []).includes(stepStage);
  const isModelStep = live && stepDef?.state === "当前" && stepDef.kind === "分析";
  // 主按钮位被分析接管：没产出（必须能发起）或资料已失效（必须能刷新）
  const analysisAction =
    isModelStep && (!stepDef.ready || stepStale)
      ? {
          running: analysis.running,
          elapsedLabel: analysis.elapsedLabel,
          onStart: analysis.start,
          hint: stepDef.readyHint,
          recompute: stepDef.ready,
        }
      : undefined;
  // 已产出且没失效：主按钮位还给「下一步」，另给一个次级「重算本步」入口
  const recomputeAction =
    isModelStep && stepDef.ready && !stepStale
      ? {
          running: analysis.running,
          elapsedLabel: analysis.elapsedLabel,
          onStart: analysis.start,
        }
      : undefined;

  const renderStepBody = (): React.ReactNode => {
    if (!flow) return null;
    if (live) {
      if (step === 1) {
        return (
          <AnchorStepPanel
            projectId={project.id}
            scenarioName={project.name}
            onChanged={onProjectsChanged}
            onFlowChanged={() => void reloadFlow()}
            onStageSnapshot={onStageSnapshot}
            refreshToken={definitionRefresh}
          />
        );
      }
      if (step === FLOW_TOTAL) {
        return (
          <DeliveryPanel
            flow={flow}
            live
            projectId={project.id}
            onStageSnapshot={onStageSnapshot}
            onExported={onProjectsChanged}
          />
        );
      }
      const def = flowStep(step);
      const isCurrent = flow.currentStep === step;
      return (
        <RealStagePanel
          projectId={project.id}
          stage={stepStage}
          stageLabel={STAGE_DEFS.find((s) => s.id === stepStage)?.name ?? def.title}
          tables={def.tables}
          stepId={step}
          running={isCurrent ? analysis.running : false}
          streamLines={isCurrent ? analysis.streamLines : []}
          refreshToken={isCurrent ? analysisRefresh : 0}
          onChanged={onProjectsChanged}
          onStageSnapshot={onStageSnapshot}
        />
      );
    }

    // ── 演示模式：同一套结构与领域逻辑，数据来自本地内存 ──
    if (step === 1) {
      return (
        <DemoFirstStep
          flow={flow}
          anchor={demoAnchor}
          scenarioName={project.name}
          onConsolidated={handleDemoAnchorConsolidated}
          onAnchorEdit={handleDemoAnchorEdit}
          onStageSnapshot={onStageSnapshot}
        />
      );
    }
    if (step === FLOW_TOTAL) {
      return <DeliveryPanel flow={flow} live={false} onStageSnapshot={onStageSnapshot} />;
    }
    const def = flowStep(step);
    return (
      <DemoStagePanel
        stage={stepStage}
        tables={def.tables}
        stepId={step}
        anchor={demoAnchor}
        onStageSnapshot={onStageSnapshot}
      />
    );
  };

  const flowBadge = flow
    ? flow.finished
      ? `已完成全部 ${FLOW_TOTAL} 步`
      : `第 ${flow.currentStep}/${FLOW_TOTAL} 步 · ${current?.title ?? ""}`
    : "";

  return (
    <>
      {/* 场景头：场景名 + 数据来源徽标 + 流程进度 + 场景资料/导出入口 */}
      <div className="pgh pgh-fixed">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <div className="pgt">{project.name}</div>
          {live ? (
            <span className="badge success">实时数据</span>
          ) : (
            <span className="badge warning">演示数据</span>
          )}
          {flowBadge ? <span className="badge primary">{flowBadge}</span> : null}
        </div>
        <div className="pga">
          <button
            className="btn"
            type="button"
            aria-expanded={materialsOpen}
            onClick={() => setMaterialsOpen((v) => !v)}
          >
            {materialsOpen ? "收起本场景资料" : "本场景资料"}
          </button>
          <button className="btn" type="button" onClick={() => void handleExport()} disabled={exporting}>
            {exporting ? "导出中…" : "导出交付物"}
          </button>
        </div>
      </div>

      {/* 本场景资料：与主资料库隔离，分析时合并、来源可区分 */}
      {materialsOpen ? (
        <div className="pnl material-panel">
          <div className="pnl-h">
            <div>
              <h2>本场景资料</h2>
              <p>
                本场景专属资料，与主资料库隔离；分析时合并使用，来源可区分（第 1/2 步的锚行与后续各步都会标注出处）
              </p>
            </div>
          </div>
          <div className="pnl-b">
            {live && project.product_line_id ? (
              <MaterialUpload lineId={project.product_line_id} onDone={onProjectsChanged} />
            ) : (
              <div className="model-discover-row">
                <button
                  className="btn"
                  type="button"
                  onClick={() => showToast("演示模式：上传入口仅为示意")}
                >
                  上传文件
                </button>
                <span className="brief-hint">演示模式不上传入库；连接后端后落到本场景专属库</span>
              </div>
            )}
            {/* 引用通用资料库（v1.11）：原先常驻页头的「资料来源」条搬到这里，
                用户点开本场景资料时勾选即可 */}
            {live ? (
              <MaterialSourcesBar
                projectId={project.id}
                ownLineId={project.product_line_id}
                onChanged={onProjectsChanged}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 资料失效横幅（上游表被改动，本阶段结果需重算） */}
      {live && stale.status === "ok" && stale.data?.banner && (
        <div className="stale-banner" role="status">
          <span className="badge warning">资料更新</span>
          {stale.data.banner}
        </div>
      )}

      {/* 流程进度轴（取代 v1.4 的 8 个阶段并列 tab） */}
      {flow ? (
        <FlowRail
          status={flow}
          activeStep={step}
          busy={busy}
          onSelectStep={setActiveStep}
          onComplete={() => void handleComplete()}
          analysis={analysisAction}
          recompute={recomputeAction}
        />
      ) : (
        <div className="flow-rail">
          <div className="pnl-b">
            {flowError ? (
              <div className="empty-state">
                <div className="empty-state-title">流程状态加载失败</div>
                <div className="empty-state-desc">{flowError}</div>
                <button className="btn" type="button" onClick={() => void reloadFlow()}>
                  重试
                </button>
              </div>
            ) : (
              <div className="loading-strip" role="status" aria-label="加载中" />
            )}
          </div>
        </div>
      )}

      {/* 当前步面板 */}
      <div className="ws">
        {stepDef?.state === "已完成" ? (
          <div className="flow-reopen" role="status">
            <span className="badge success">已完成</span>
            <span className="flow-reopen-text">
              正在回看第 {step} 步「{stepDef.title}」；回到这一步重跑会清掉该步及其后的完成标记，数据保留
            </span>
            <button
              className="btn btn-sm"
              type="button"
              disabled={busy}
              onClick={() => void handleReopen(step)}
            >
              回到这一步重跑
            </button>
          </div>
        ) : null}
        {renderStepBody()}
      </div>
    </>
  );
};
