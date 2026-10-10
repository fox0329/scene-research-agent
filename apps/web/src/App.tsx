import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { StageRightPanel } from "./components/StageRightPanel";
import { ScenarioDefinitionDialog } from "./components/ScenarioDefinitionDialog";
import { NewScenarioDialog } from "./components/NewScenarioDialog";
import { RowDetailPanel, type RowDetail } from "./components/RowDetailPanel";
import type { StageSnapshot } from "./components/stage-snapshot";
import { ToastProvider, useToast } from "./components/Toast";
import { LibraryView } from "./views/LibraryView";
import { ProjectView } from "./views/ProjectView";
import { SettingsView } from "./views/SettingsView";
import { useColumnLayout } from "./hooks/useColumnLayout";
import { api, type ApiConversation, type ApiProductLine, type ApiProject } from "./api";
import { projects, type Project } from "./mock/project-data";

/** 主视图：project 项目工作台（默认）/ library 资料库 / settings 设置 */
type ViewName = "project" | "library" | "settings";

/** 后端探测超时：超过即按演示模式渲染，避免首屏空等 */
const PROBE_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("后端探测超时")), ms),
    ),
  ]);
}

/** API 项目 + 会话 → 工作台 Project 形状（联真/演示同构，视图层零分支） */
function mapApiProject(
  p: ApiProject,
  conversations: ApiConversation[],
  lineNames: Map<string, string>,
): Project {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    own_line_id: p.own_line_id ?? null,
    stage: p.current_stage,
    status:
      p.flow?.finished || p.current_stage >= 8 || p.status === "已完成" || p.status === "已归档"
        ? "done"
        : "active",
    productLine: (p.own_line_id && lineNames.get(p.own_line_id)) || "",
    /* 流程进度（v1.5）：后端旧版本可能没有 flow 字段 → 可选，缺失即不显示 */
    ...(p.flow ? { flow: p.flow } : {}),
    conversations: conversations.map((c) => ({ id: c.id, name: c.title })),
  };
}

/**
 * 场景通 — App 入口
 * 三栏布局骨架：左栏 256px / 中栏自适应 / 右栏 280px
 * 对话只有一处：`ScenarioDefinitionDialog` 独立弹窗（变更表 #58 定调、#180 落地）
 *
 * 联真模式（M5-T5.3）：挂载时探测 /api/v1/health——
 * 后端可达 → 项目/工作台走真实数据；不可达 → 演示模式（mock 数据，页头徽标提示）。
 * vite preview（E2E 通道）不带 /api 代理，天然落在演示模式。
 */
const App: React.FC = () => (
  <ToastProvider>
    <AppShell />
  </ToastProvider>
);

const AppShell: React.FC = () => {
  const { showToast } = useToast();
  const [view, setView] = useState<ViewName>("project");
  /** null = 演示模式（mock）；非 null = 联真模式的项目快照 */
  const [liveProjects, setLiveProjects] = useState<Project[] | null>(null);
  /** 侧栏真实计数（联真模式） */
  const [lineCount, setLineCount] = useState<number | null>(null);
  /** 产品线快照（含 row_counts），供资料库视图常驻渲染不重挂 */
  const [lines, setLines] = useState<ApiProductLine[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(projects[0].id);
  /** 右栏决策支撑快照（联真模式，来自当前阶段真实数据；T5.6） */
  const [stageSnapshot, setStageSnapshot] = useState<StageSnapshot | null>(null);
  /** 新建场景只问名称（场景本体在「场景定义」对话里聊清楚） */
  const [newScenarioOpen, setNewScenarioOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** 项目刚建好、待打开定义对话的目标（null = 不显示定义对话） */
  const [definitionTarget, setDefinitionTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  /** 定义对话在 App 层发生变化的信号：通知第 1 步面板重取定义状态 */
  const [definitionRefresh, setDefinitionRefresh] = useState(0);
  /** 资料库行详情（右栏备注区，变更表 #19） */
  const [rowDetail, setRowDetail] = useState<RowDetail | null>(null);
  /** 当前选中会话（左栏高亮用；用户可见的会话只有「场景定义」，点它开独立弹窗） */
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const layout = useColumnLayout();

  const live = liveProjects !== null;
  const shownProjects = liveProjects ?? projects;
  const activeProject =
    shownProjects.find((p) => p.id === activeProjectId) ?? shownProjects[0];

  /** 重新拉取项目列表（含会话），并保持/校正当前选中项 */
  const refreshProjects = useCallback(async (selectId?: string) => {
    const [apiProjects, lines] = await Promise.all([
      api.listProjects(),
      api.productLines(),
    ]);
    const convLists = await Promise.all(
      apiProjects.map((p) =>
        api.listConversations(p.id).catch(() => [] as ApiConversation[]),
      ),
    );
    const lineNames = new Map(lines.map((l) => [l.id, l.name]));
    const mapped = apiProjects.map((p, i) =>
      mapApiProject(p, convLists[i], lineNames),
    );
    setLiveProjects(mapped);
    setLines(lines);
    setLineCount(lines.length);
    setActiveProjectId((cur) => {
      if (selectId && mapped.some((m) => m.id === selectId)) return selectId;
      if (mapped.some((m) => m.id === cur)) return cur;
      return mapped[0]?.id ?? cur;
    });
    /* 选中会话随刷新对账：所属项目/会话已删则清空 */
    setActiveConvId((cur) =>
      cur && mapped.some((m) => m.conversations.some((c) => c.id === cur)) ? cur : null,
    );
    return mapped;
  }, []);

  /* 挂载探测：可达则接真，失败静默留在演示模式 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await withTimeout(api.health(), PROBE_TIMEOUT_MS);
        if (!cancelled) {
          await refreshProjects();
        }
      } catch {
        /* 后端未启动：演示模式 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshProjects]);

  /** 左栏选中项目：切换项目、清空会话选中并回到项目工作台 */
  const handleSelectProject = (id: string) => {
    setActiveProjectId(id);
    setActiveConvId(null);
    setView("project");
  };

  /**
   * 左栏选中会话：打开「场景定义」独立弹窗（变更表 #180）
   *
   * 用户可见的会话只有「场景定义」（变更表 #174 起阶段分析会话不再登记），而
   * 变更表 #58 已定调「对话是独立弹窗/单独页面（不是中栏、不是右下角抽屉）」，
   * 所以这里直接开那个弹窗，不再有第二套对话界面。
   */
  const handleSelectConversation = (projectId: string, convId: string) => {
    const target = shownProjects.find((x) => x.id === projectId);
    setActiveProjectId(projectId);
    setActiveConvId(convId);
    setView("project");
    setDefinitionTarget({ id: projectId, name: target?.name ?? "" });
  };

  /** 左栏底部入口：切换主视图（收窄 string 到 ViewName） */
  const handleViewChange = useCallback((v: string) => {
    if (v === "library" || v === "settings") {
      setView(v);
    }
  }, []);

  /** 新建项目：只问名称（演示模式保持占位入口） */
  const handleNewProject = useCallback(async () => {
    if (!live) return;
    setCreateError(null);
    setNewScenarioOpen(true);
  }, [live]);

  /**
   * 提交名称 → 建项目 → 直接打开独立的「场景定义」对话页
   *
   * 产品口径：新建只输名称，场景本体在对话里聊清楚；不再让用户填三段式表单。
   */
  const handleCreateProject = useCallback(
    async (name: string) => {
      setCreating(true);
      setCreateError(null);
      try {
        const created = await api.createProject(name);
        setNewScenarioOpen(false);
        await refreshProjects(created.id);
        setView("project");
        setDefinitionTarget({ id: created.id, name: created.name });
      } catch (err: unknown) {
        setCreateError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    },
    [refreshProjects],
  );

  /** 定义对话整理完成：刷新列表（本步是否可完成由服务端按「定义已整理」判定） */
  const handleDefinitionConsolidated = useCallback(async () => {
    setDefinitionRefresh((n) => n + 1);
    await refreshProjects().catch(() => {});
    showToast("场景定义已整理成表1-1——本步已可就绪，可直接点「完成本步」；想更准就去右栏表态或留待定");
  }, [refreshProjects, showToast]);

  /** 关闭 App 层的定义对话：让第 1 步面板重取对话条数与表1-1 */
  const handleDefinitionClosed = useCallback(() => {
    setDefinitionTarget(null);
    setDefinitionRefresh((n) => n + 1);
  }, []);

  /** 项目 ⋯ 菜单动作（仅联真模式落地；演示模式显式说明，不做无声无息的空操作） */
  const handleProjectAction = useCallback(
    async (project: Project, action: "重命名" | "归档" | "删除") => {
      if (!live) {
        showToast(`演示模式：${action}不会落库（连上后端才生效）`);
        return;
      }
      try {
        if (action === "重命名") {
          const name = window.prompt("重命名项目", project.name);
          if (!name?.trim()) return;
          await api.patchProject(project.id, { name: name.trim() });
        } else if (action === "归档") {
          await api.patchProject(project.id, { status: "已归档" });
        } else {
          if (
            !window.confirm(
              `删除项目「${project.name}」？其会话与阶段数据将一并删除，不可恢复。`,
            )
          )
            return;
          await api.deleteProject(project.id);
        }
        await refreshProjects();
        showToast(`已${action}：${project.name}`);
      } catch (err: unknown) {
        showToast(`${action}失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [live, refreshProjects, showToast],
  );

  /** 会话 ⋯ 菜单动作（仅联真模式落地；删除带消息会话需 force，二次确认后强制删） */
  const handleConversationAction = useCallback(
    async (
      project: Project,
      convId: string,
      convName: string,
      action: "重命名" | "归档" | "删除",
    ) => {
      if (!live) {
        showToast(`演示模式：${action}不会落库（连上后端才生效）`);
        return;
      }
      try {
        if (action === "重命名") {
          const title = window.prompt("重命名会话", convName);
          if (!title?.trim()) return;
          await api.renameConversation(convId, title.trim());
        } else if (action === "归档") {
          await api.archiveConversation(convId);
        } else {
          if (
            !window.confirm(`删除会话「${convName}」？其消息将一并删除，不可恢复。`)
          )
            return;
          await api.deleteConversation(convId, true);
        }
        if (action !== "重命名" && convId === activeConvId) setActiveConvId(null);
        await refreshProjects();
        showToast(`已${action}：${convName}`);
      } catch (err: unknown) {
        showToast(`${action}失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [live, refreshProjects, showToast, activeConvId],
  );

  return (
    <div className={layout.shellClass} style={layout.shellStyle}>
      {/* 左栏：导航 + 项目列表 */}
      <Sidebar
        activeView={view}
        onViewChange={handleViewChange}
        projects={shownProjects}
        activeProjectId={activeProject?.id ?? ""}
        activeConvId={activeConvId}
        onSelectProject={handleSelectProject}
        onSelectConversation={handleSelectConversation}
        onNewProject={live ? () => void handleNewProject() : undefined}
        onProjectAction={(p, a) => void handleProjectAction(p, a)}
        onConversationAction={
          (p, cid, cname, a) => void handleConversationAction(p, cid, cname, a)
        }
        libraryCount={lineCount}
      />

      {/* 中栏：内容区 + 常驻输入栏 */}
      <main className="main">
        {view === "project" && activeProject && (
          <ProjectView
            key={activeProject.id}
            project={activeProject}
            live={live}
            hasProjects={shownProjects.length > 0}
            onProjectsChanged={() => void refreshProjects().catch(() => {})}
            onNewProject={() => void handleNewProject()}
            onStageSnapshot={setStageSnapshot}
            definitionRefresh={definitionRefresh}
          />
        )}
        {view === "project" && !activeProject && (
          <NoProjectsPanel onNew={() => void handleNewProject()} />
        )}
        {view === "library" && (
          <LibraryView
            live={live}
            lines={lines}
            onChanged={() => void refreshProjects().catch(() => {})}
            onRowSelect={live ? setRowDetail : undefined}
          />
        )}
        {view === "settings" && <SettingsView live={live} />}
      </main>

      {/* 右栏：项目工作台显示阶段面板（补充说明 + 阶段总结）/ 资料库选中行显示行详情。
          变更表 #149：没有可显示的内容时右栏就空着——不再放装饰性说明文案
          （「决策支撑 / 项目工作台专属」与库页引导都是重复或承诺做不到的废话） */}
      <aside className="det">
        {view === "project" ? (
          <StageRightPanel snapshot={stageSnapshot} live={live} />
        ) : view === "library" && live && rowDetail ? (
          <RowDetailPanel detail={rowDetail} onClose={() => setRowDetail(null)} />
        ) : null}
      </aside>

      <NewScenarioDialog
        open={newScenarioOpen}
        busy={creating}
        error={createError}
        onSubmit={(name) => void handleCreateProject(name)}
        onClose={() => setNewScenarioOpen(false)}
      />

      {/* 新建后直接进入的「场景定义」对话（独立页面级弹窗，不是中栏/抽屉） */}
      <ScenarioDefinitionDialog
        open={definitionTarget !== null}
        projectId={definitionTarget?.id ?? ""}
        scenarioName={definitionTarget?.name ?? ""}
        onClose={handleDefinitionClosed}
        onConsolidated={() => void handleDefinitionConsolidated()}
      />

      {/* 列宽热区（骑在分割线上，不画第二根线）+ 缘收起胶囊柄 */}
      <span
        className="col-resizer col-resizer--side"
        aria-label="拖拽调整左栏宽度"
        onPointerDown={(e) => layout.beginResize("side", e)}
      />
      <span
        className="col-resizer col-resizer--det"
        aria-label="拖拽调整右栏宽度"
        onPointerDown={(e) => layout.beginResize("det", e)}
      />
      <button
        type="button"
        className="edge-toggle edge-toggle--side"
        aria-label={layout.sideCollapsed ? "展开左栏" : "收起左栏"}
        onClick={layout.toggleSide}
      >
        <ChevronIcon flip={layout.sideCollapsed} />
      </button>
      <button
        type="button"
        className="edge-toggle edge-toggle--det"
        aria-label={layout.detCollapsed ? "展开右栏" : "收起右栏"}
        onClick={layout.toggleDet}
      >
        <ChevronIcon flip={!layout.detCollapsed} />
      </button>
    </div>
  );
};

/** 联真模式下无任何项目的空态（引导新建） */
const NoProjectsPanel: React.FC<{ onNew: () => void }> = ({ onNew }) => (
  <>
    <div className="pgh pgh-fixed">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
        <div className="pgt">项目工作台</div>
        <span className="badge success">实时数据</span>
      </div>
    </div>
    <div className="ws">
      <div className="pnl">
        <div className="pnl-b">
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <div className="empty-state-title">还没有项目</div>
            <div className="empty-state-desc">
              新建一个场景分析项目，上传产品资料后从第 1 步「场景定义与边界」开始推进
            </div>
            <button className="btn primary" type="button" onClick={onNew}>
              新建项目
            </button>
          </div>
        </div>
      </div>
    </div>
  </>
);

/** 缘收起柄箭头：flip=false 指左（收起左栏），true 指右 */
const ChevronIcon: React.FC<{ flip: boolean }> = ({ flip }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    style={{ width: "var(--size-14)", height: "var(--size-14)", transform: flip ? "rotate(180deg)" : undefined }}
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export default App;
