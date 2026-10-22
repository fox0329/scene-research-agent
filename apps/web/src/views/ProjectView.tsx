import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FLOW_TOTAL, flowStep, tableDisplayName, type InfoStageId } from "@scene/contract";
import { RealStagePanel } from "./RealStagePanel";
import { DemoStagePanel } from "./DemoStagePanel";
import { AnchorStepPanel } from "./AnchorStepPanel";
import { DeliveryPanel } from "./DeliveryPanel";
import { DemoFirstStep } from "./DemoFlowPanels";
import { FlowRail } from "../components/FlowRail";
import { railOutputsOf, type StepOutput } from "../components/step-outputs";
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
  /** 右栏阶段快照：阶段总结（来源地址 + 结论提醒） */
  onStageSnapshot?: (snap: StageSnapshot | null) => void;
  /** 对话入口：流程轴第 1 步的运行按钮打开「场景定义」独立弹窗（变更表 #58 / #180） */
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
  /**
   * 流程轴第二行点的输出物 → 交给中栏面板套用
   *
   * 用"带上自增 id 的一次性请求"而不是双向绑定：面板自己也有默认选择（优先有数据的表），
   * 双向绑定会跟它打架（面板回落 → 回写 → 又套用外部选择）。id 变化才套用，面板自己
   * 的切换通过 onTableChange 回报，只用于流程轴高亮。
   */
  const [pick, setPick] = useState<{ id: number; step: number; code: string | null; block: string | null } | null>(null);
  const pickSeq = React.useRef(0);
  /** 中栏此刻显示的输出物（面板回报）→ 流程轴第二行高亮 */
  const [shownOutput, setShownOutput] = useState<{ step: number; key: string } | null>(null);
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

  /* 流程轴第二行：当前正在看的那一步的输出物（表名 / 表·子块）。
     交付物这一步没有表，它的第二行由 DeliveryPanel portal 进去（变更表 #148） */
  const railOutputs = useMemo<StepOutput[]>(
    () => railOutputsOf(step, flowStep(step).tables, FLOW_TOTAL),
    [step],
  );
  /* 高亮哪一项：面板回报过就用它；第 1 步只有一张锚表、面板不上报，恒定高亮它 */
  const activeOutputKey =
    shownOutput?.step === step
      ? shownOutput.key
      : step === 1
        ? "表1-1"
        : null;

  /** 流程轴第二行点了输出物 → 让中栏显示它 */
  const handleSelectOutput = useCallback(
    (o: StepOutput) => {
      setPick({ id: ++pickSeq.current, step, code: o.code ?? o.key, block: o.block });
      setShownOutput({ step, key: o.key });
    },
    [step],
  );
  /** 中栏面板回报此刻显示的表/块 → 流程轴第二行跟着高亮 */
  const handlePanelTableChange = useCallback(
    (code: string | null, block: string | null) => {
      if (!code) return;
      const key = block ? `${code}:${block}` : code;
      setShownOutput((prev) => (prev?.step === step && prev.key === key ? prev : { step, key }));
    },
    [step],
  );
  /** 交付物面板回报此刻看的是哪一份（solution / construction）→ 流程轴第二行据此高亮 */
  const handlePanelReportChange = useCallback((key: string) => {
    setShownOutput((prev) => (prev?.step === FLOW_TOTAL && prev.key === key ? prev : { step: FLOW_TOTAL, key }));
  }, []);
  /** 交给某个中栏面板的一次性选择：只传属于它这一步的（交付物步的 code 是那一份的 kind） */
  const pickForStep = pick && pick.step === step ? pick : undefined;

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
  /** 长跑对账信号：只让面板静默重取行数据，不重生成阶段总结（故障清单 #48） */
  const [silentRefresh, setSilentRefresh] = useState(0);
  const [ackStaleBusy, setAckStaleBusy] = useState(false);

  /**
   * 数据被改（阶段表单元格 / 资料上传 / 场景锚确认 / 回退）→ 失效横幅一起重取
   *
   * 横幅说的就是"哪些步要重算"，而这些动作恰恰会改 `is_stale`：改了不重取，
   * 横幅就停在打开页面那一刻的样子（用户实测：「重算完了，横幅没有变化」）。
   */
  const handleDataChanged = useCallback(() => {
    onProjectsChanged?.();
    stale.reload();
  }, [onProjectsChanged, stale]);

  /** v3.0：按需创建本场景私有库（幂等）；建完刷新项目，上传入口随即出现 */
  const handleCreateOwnLine = useCallback(async () => {
    setCreatingLine(true);
    try {
      const r = await api.ensureOwnLine(project.id);
      showToast(r.created ? `已为本场景创建私有资料库「${r.own_line.name}」` : "本场景私有资料库已存在");
      handleDataChanged();
    } catch (err: unknown) {
      showToast(`创建失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreatingLine(false);
    }
  }, [project.id, showToast, handleDataChanged]);

  const [creatingLine, setCreatingLine] = useState(false);

  /**
   * 分析收尾（onDone / onSettled）后横幅也必须重取
   *
   * 重算会把重新生成的行 `is_stale` 改回 false —— 本步的待重算就此消失，
   * 横幅要跟着少一条；不重取就会一直显示旧文案。用 `analysisRefresh` 当信号，
   * 与中栏面板的 `refreshToken` 同源（收尾无条件自增，done/失败/断连都覆盖）。
   */
  useEffect(() => {
    if (analysisRefresh > 0) stale.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload 是 useAsync 内 useCallback 稳定引用
  }, [analysisRefresh]);

  /**
   * 本步分析的运行态（v1.20）
   *
   * 用户定调「中栏只放信息，动作都在上面」：触发布钮上移到流程轴，
   * 进度流仍在中栏——两边都要这份状态，所以放在共同父级这里。
   */
  /**
   * 本步分析的收尾说明（常驻横幅）
   *
   * 进度区从 v1.20 起不进中栏了，跑完不留任何残留；但**失败**不能只靠一条几秒后
   * 就消失的提示——那样用户只看到按钮变回「开始本步分析」、不知道发生了什么。
   * 这里沿用已有的状态横幅样式，成功时不留痕（数据出现本身就是信号）。
   */
  const [analysisNotice, setAnalysisNotice] = useState<
    { kind: "error" | "info" | "warning"; text: string } | null
  >(null);
  /** 场景定义对话弹窗：入口在流程轴（第 1 步的运行按钮），状态因此提到这一层 */
  const [definitionDialogOpen, setDefinitionDialogOpen] = useState(false);
  const analysis = useStageAnalysis({
    projectId: project.id,
    stage: stepStage,
    stepId: step,
    // done 只是"更快知道成功了"：真正决定界面收敛的是下面的 onSettled
    onDone: (info) => {
      const failed = info?.tablesFailed ?? [];
      const needMaterial = info?.tablesNeedMaterial ?? [];
      /* 两类提示分开说：失败 = 这次没成（沿用旧内容）；需要补材料 = 现状类表没有客户材料，
         不是失败，是让用户先补材料（用户定调 2026-10-14：干脆不生成，直接提示需要先补材料） */
      const parts = [
        failed.length > 0
          ? `${failed.map(tableDisplayName).join("、")} 这次没生成成功，已沿用原有内容——可稍后重算本步补齐`
          : "",
        needMaterial.length > 0
          ? `${needMaterial.map(tableDisplayName).join("、")} 需要先补客户材料：这两张表问的是"该客户现在怎么做"，材料里没有就只能拿行业通例占位，所以本次没有生成——补上材料后重算本表即可`
          : "",
      ].filter((x) => x !== "");
      setAnalysisNotice(parts.length > 0 ? { kind: "warning", text: parts.join("；") } : null);
      onProjectsChanged?.();
    },
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
    onError: (message) => {
      setAnalysisNotice({ kind: "error", text: `本步分析失败：${message}（本步原有内容已保留，可直接重试）` });
      showToast(`本步分析失败：${message}`);
    },
    onWarn: (message) => {
      setAnalysisNotice({ kind: "info", text: message });
      showToast(message);
    },
  });

  /**
   * 服务端还在跑这一步时，页面自己继续对账
   *
   * 用户按 F5 会掐断那条 SSE 流，但服务端的生成**仍在继续**——新页面既收不到进度、
   * 也不知道还在跑，于是只能靠手动刷新才看到结果（故障清单 #47）。
   * 服务端在流程状态里标了"本步在跑"，这里就每 15 秒重取流程状态与本步数据，
   * 跑完自动收口：长跑期间还能顺带看到已完成的表逐张出现。
   */
  /** 有没有哪一步正在服务端跑（含回看重算：那一步不是流程轴当前步） */
  const serverRunning = Boolean(flow?.steps.some((s) => s.running));
  /** 正在跑的正是"眼前这一步"——本步按钮据此保持"分析中"，别让用户重复发起 */
  const stepServerRunning = Boolean(stepDef?.running);
  useEffect(() => {
    if (!serverRunning) return;
    const timer = setInterval(() => {
      // 用 silentRefresh 而不是 analysisRefresh：后者会连带强制模型重写阶段总结
      setSilentRefresh((n) => n + 1);
      void reloadFlow(true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [serverRunning, reloadFlow]);

  /**
   * 场景定义对话整理/关闭后，**流程状态必须重取**
   *
   * 曾经漏了这一步：App 层的「场景定义」弹窗（新建场景时自动打开的那条主路径）
   * 整理成功后只刷新了项目列表与定义数据，流程轴仍拿着旧状态——
   * 表现是用户聊完、整理完、关掉弹窗后，「完成本步」还是灰的（服务端其实已就绪）。
   * 两条路径（App 弹窗 / 第 1 步面板弹窗）都会 bump definitionRefresh，这里统一接住。
   */
  useEffect(() => {
    if (definitionRefresh > 0) {
      void reloadFlow();
      stale.reload();
    }
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

  /**
   * 顶部按钮位（用户定调「中栏不放按钮，上面有下一步」）
   *
   * **八步同形**（v1.23，用户定调「都与认识场景保持一致」）：不管是分析步还是第 1 步这样的
   * 确认步，运行入口都只有这一个位置、同一套按钮与说法：
   *  - 本步还没产出（服务端 ready=false）→ 主按钮「开始本步分析」
   *  - 已产出（含资料失效）              → 次级「重算本步」+ 主按钮「下一步」
   * 差别只在"运行"是什么：分析步跑模型；第 1 步打开场景定义对话（让智能体写出表1-1）。
   * **回到哪一步直接点阶段名称**（v1.24 用户定调）：回看任意一步都能就地重算，所以流程轴上
   * 不再有「回到这一步」「回到当前步」这类导航按钮——要看/要重跑哪一步，点它的名字就是。
   */
  /**
   * 「已知悉」：清掉本场景的待重算标记
   *
   * 只清标记、不碰数据（服务端 `POST /stale/ack`）；清完重取横幅与流程轴
   * （流程轴上的"待重算"态由 is_stale 派生），再让当前步面板重取一次行数据
   * （行级"待重算"徽标同源）。
   */
  const handleAckStale = useCallback(async () => {
    if (!live || ackStaleBusy) return;
    setAckStaleBusy(true);
    try {
      await api.ackStale(project.id);
      stale.reload();
      setAnalysisRefresh((n) => n + 1);
      await reloadFlow();
    } catch {
      // 清失败就保持原状：横幅还在，用户能再点一次
    } finally {
      setAckStaleBusy(false);
    }
  }, [live, ackStaleBusy, project.id, stale, reloadFlow]);

  const stepStale = (stale.data?.stages ?? []).includes(stepStage);
  // 认步（第 1 步）不跑模型，只打开场景定义对话 —— 演示态与联真同形；
  // 分析步只有联真才有真正可跑的后端，演示态不装这个按钮（避免点了个没反应的入口）
  const canRunStep =
    stepDef !== undefined &&
    (stepDef.kind === "确认" || (live && stepDef.kind === "分析")) &&
    // 回看历史步也给「重算本步」：想换一版不必先退回去（与"中栏不留重跑入口"配套）
    (stepDef.state === "当前" || stepDef.state === "已完成");
  const runAction =
    canRunStep
      ? {
          // 服务端仍在跑也算"分析中"：刷新后重新接上的页面不能显示成"没跑过"，否则用户会重复发起
          running: analysis.running || stepServerRunning,
          elapsedLabel: analysis.running ? analysis.elapsedLabel : "",
          ready: Boolean(stepDef.ready),
          hint: stepDef.readyHint,
          // 第 1 步的运行 = 打开场景定义对话（不跑表；表1-1 由对话里的「整理成定义」写）
          ...(stepDef.kind === "确认"
            ? {
                title: stepDef.ready
                  ? "重新打开场景定义对话，重做这一步的定义（会更新表1-1）"
                  : "打开场景定义对话：说一句你对这个场景的想法，智能体写出场景业务画像",
              }
            : stepStale
              ? { title: `本步资料因上游改动失效：${stepDef.readyHint}` }
              : {}),
          /* 本地在跑时也要给进度：stepServerRunning 来自轮询对账，刚点下按钮时还是 false，
             以前只认服务端状态，于是进度条一直停在「分析进行中…」（实测 125 秒）。 */
          progress: analysis.running
            ? analysis.streamLines.at(-1)
            : stepServerRunning
              ? "服务端仍在分析，跑完会自动更新"
              : undefined,
          onStart: () => {
            setAnalysisNotice(null);
            if (stepDef.kind === "确认") {
              setDefinitionDialogOpen(true);
              return;
            }
            /* 重算会覆盖本步已生成的表：不能一个误点就重来（旧版只在 title 里写了这句）。
               首次「开始本步分析」不拦，避免每次跑都多一步确认。 */
            if (
              stepDef.ready &&
              !window.confirm(
                `重算第 ${step} 步「${stepDef.title}」会用新结果覆盖本步 ${flowStep(step).tables.length} 张表，旧内容不可恢复（生成失败的表会保留原内容）。继续？`,
              )
            ) {
              return;
            }
            analysis.start();
          },
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
            onChanged={handleDataChanged}
            onFlowChanged={() => {
              void reloadFlow();
              stale.reload();
            }}
            onStageSnapshot={onStageSnapshot}
            refreshToken={definitionRefresh}
            definitionOpen={definitionDialogOpen}
            onDefinitionOpenChange={setDefinitionDialogOpen}
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
            pick={pickForStep}
            onReportChange={handlePanelReportChange}
          />
        );
      }
      const def = flowStep(step);
      return (
        <RealStagePanel
          projectId={project.id}
          stage={stepStage}
          tables={def.tables}
          stepId={step}
          /**
           * 收尾令牌照传，**不许**再按"是不是流程轴当前步"过滤（变更表 #172，用户实测）
           *
           * 曾经的写法是 `isCurrent ? analysisRefresh : 0`，而面板里是
           * `if (refreshToken === 0) return`——于是"回看已完成的步 → 点重算本步"这条路
           * （`isCurrent` 为假）永远拿不到令牌，面板一次都不重取，用户只能按 F5 才看到新结果
           * （复现：回看第 2 步重算，本步面板 0 次请求；当前步同一动作是 2 次）。
           *
           * 为什么照传是安全的：运行入口在流程轴上、且只对**正在看的那一步**发起，
           * 所以令牌每次自增都恰好对应"用户眼前这个面板"，不会误刷别的步。
           */
          refreshToken={analysisRefresh}
          silentRefreshToken={silentRefresh}
          onChanged={handleDataChanged}
          onStageSnapshot={onStageSnapshot}
          pick={pickForStep}
          onTableChange={handlePanelTableChange}
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
          definitionOpen={definitionDialogOpen}
          onDefinitionOpenChange={setDefinitionDialogOpen}
        />
      );
    }
    if (step === FLOW_TOTAL) {
      return (
        <DeliveryPanel
          flow={flow}
          live={false}
          onStageSnapshot={onStageSnapshot}
          pick={pickForStep}
          onReportChange={handlePanelReportChange}
        />
      );
    }
    const def = flowStep(step);
    return (
      <DemoStagePanel
        stage={stepStage}
        tables={def.tables}
        stepId={step}
        onStageSnapshot={onStageSnapshot}
        pick={pickForStep}
        onTableChange={handlePanelTableChange}
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
          {flowBadge ? <span className="badge primary step-badge">{flowBadge}</span> : null}
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
            {live && project.own_line_id ? (
              <MaterialUpload lineId={project.own_line_id} onDone={handleDataChanged} />
            ) : live ? (
              /* v3.0：私有库按需创建——第一次上传时才建，不建空库（变更表 #160） */
              <div className="model-discover-row">
                <button className="btn" type="button" disabled={creatingLine} onClick={() => void handleCreateOwnLine()}>
                  {creatingLine ? "创建中" : "上传本场景材料"}
                </button>
                <span className="brief-hint">
                  还没有本场景私有库；第一次上传材料时会自动建一个，空库也可以随时删掉
                </span>
              </div>
            ) : (
              <div className="model-discover-row">
                <button
                  className="btn"
                  type="button"
                  onClick={() => showToast("演示模式：上传入口仅为示意")}
                >
                  上传文件
                </button>
                <span className="brief-hint">演示模式不上传入库；连接后端后落到本场景私有库</span>
              </div>
            )}
            {/* 引用通用资料库（v1.11）：原先常驻页头的「资料来源」条搬到这里，
                用户点开本场景资料时勾选即可 */}
            {live ? (
              <MaterialSourcesBar
                projectId={project.id}
                ownLineId={project.own_line_id ?? undefined}
                onChanged={handleDataChanged}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 资料失效横幅（上游表被改动，本阶段结果需重算） */}
      {live && stale.status === "ok" && stale.data?.banner && (
        <div className="stale-banner" role="status">
          <span className="badge warning">资料更新</span>
          <span>{stale.data.banner}</span>
          {/* 用户有决定权：确认过、结论不受影响时给一个"已知悉"出口。
              否则标记只能靠重跑阶段消掉——为了消提示重跑一遍不划算。 */}
          <button
            type="button"
            className="btn"
            onClick={() => void handleAckStale()}
            disabled={ackStaleBusy}
            title="我看过了，结论不受影响——清掉「待重算」标记（不改任何分析数据）"
          >
            {ackStaleBusy ? "处理中…" : "已知悉"}
          </button>
        </div>
      )}

      {/* 本步分析收尾说明（失败/进度降级才出现；成功不留痕） */}
      {live && analysisNotice && (
        <div className="stale-banner" role="status">
          <span className={`badge ${analysisNotice.kind === "error" ? "error" : "warning"}`}>
            {analysisNotice.kind === "error"
              ? "分析失败"
              : analysisNotice.kind === "warning"
                ? "部分未生成"
                : "进度提示"}
          </span>
          {analysisNotice.text}
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
          run={runAction}
          outputs={railOutputs}
          activeOutputKey={activeOutputKey}
          onSelectOutput={handleSelectOutput}
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

      {/* 当前步面板（动作都在流程轴上，中栏只放信息） */}
      <div className="ws">
        {renderStepBody()}
      </div>
    </>
  );
};
