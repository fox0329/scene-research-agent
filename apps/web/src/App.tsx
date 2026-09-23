import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ConversationDrawer } from "./components/ConversationDrawer";
import { DecisionPanel } from "./components/DecisionPanel";
import type { DecisionSnapshot } from "./components/decision-snapshot";
import { ToastProvider, useToast } from "./components/Toast";
import { LibraryView } from "./views/LibraryView";
import { ProjectView } from "./views/ProjectView";
import { SettingsView } from "./views/SettingsView";
import { KnowledgeView } from "./views/KnowledgeView";
import { useColumnLayout } from "./hooks/useColumnLayout";
import { api, type ApiConversation, type ApiProductLine, type ApiProject } from "./api";
import { conversationMessages, projects, type Project } from "./mock/project-data";

/** 主视图：project 项目工作台（默认）/ library 资料库 / knowledge 知识库 / settings 设置 */
type ViewName = "project" | "library" | "knowledge" | "settings";

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
    stage: p.current_stage,
    status:
      p.current_stage >= 8 || p.status === "已完成" || p.status === "已归档"
        ? "done"
        : "active",
    productLine: lineNames.get(p.product_line_id) ?? "",
    conversations: conversations.map((c) => ({ id: c.id, name: c.title })),
  };
}

/**
 * 场景通 — App 入口
 * 三栏布局骨架：左栏 256px / 中栏自适应 / 右栏 280px
 * 中栏底部常驻对话输入栏（展开成对话抽屉）
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
  const [knowledgeCount, setKnowledgeCount] = useState<number | null>(null);
  /** 产品线快照（含 row_counts），供资料库视图常驻渲染不重挂 */
  const [lines, setLines] = useState<ApiProductLine[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(projects[0].id);
  /** 右栏决策支撑快照（联真模式，来自当前阶段真实数据；T5.6） */
  const [decisionSnapshot, setDecisionSnapshot] = useState<DecisionSnapshot | null>(null);
  /** 当前选中会话（对话抽屉随之切换；null=未选/项目未建会话） */
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
          api
            .knowledge()
            .then((k) => !cancelled && setKnowledgeCount(k.length))
            .catch(() => {});
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

  /** 左栏选中会话：对话抽屉切换到该会话 */
  const handleSelectConversation = (projectId: string, convId: string) => {
    setActiveProjectId(projectId);
    setActiveConvId(convId);
    setView("project");
  };

  /** 左栏底部入口：切换主视图（收窄 string 到 ViewName） */
  const handleViewChange = useCallback((v: string) => {
    if (v === "library" || v === "knowledge" || v === "settings") {
      setView(v);
    }
  }, []);

  /** 新建项目（仅联真模式；演示模式保持占位入口） */
  const handleNewProject = useCallback(async () => {
    if (!live) return;
    const name = window.prompt("新建项目 · 请输入项目名称");
    if (!name?.trim()) return;
    try {
      const created = await api.createProject(name.trim());
      await refreshProjects(created.id);
      setView("project");
      showToast(`项目「${created.name}」已创建`);
    } catch (err: unknown) {
      showToast(`创建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [live, refreshProjects, showToast]);

  /** 项目 ⋯ 菜单动作（仅联真模式落地） */
  const handleProjectAction = useCallback(
    async (project: Project, action: "重命名" | "归档" | "删除") => {
      if (!live) return;
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
      if (!live) return;
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

  /** 抽屉自动建会话成功：选中并刷新左栏列表 */
  const handleConversationCreated = useCallback(
    (conv: { id: string; title: string }) => {
      setActiveConvId(conv.id);
      void refreshProjects().catch(() => {});
    },
    [refreshProjects],
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
        onProjectAction={live ? (p, a) => void handleProjectAction(p, a) : undefined}
        onConversationAction={
          live ? (p, cid, cname, a) => void handleConversationAction(p, cid, cname, a) : undefined
        }
        libraryCount={lineCount}
        knowledgeCount={knowledgeCount}
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
            onDecisionSnapshot={live ? setDecisionSnapshot : undefined}
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
          />
        )}
        {view === "knowledge" && <KnowledgeView />}
        {view === "settings" && <SettingsView />}
        {/* 对话抽屉：联真模式走 converse SSE；演示模式保持本地 mock */}
        <ConversationDrawer
          messages={conversationMessages}
          live={live}
          projectId={live ? activeProject?.id ?? null : null}
          conversationId={live ? activeConvId : null}
          onConversationCreated={live ? handleConversationCreated : undefined}
        />
      </main>

      {/* 右栏：决策支撑（项目工作台实装，其余视图预留） */}
      <aside className="det">
        {view === "project" ? (
          <DecisionPanel snapshot={live ? decisionSnapshot : null} />
        ) : (
          <>
            <div className="det-h">
              <h3>决策支撑</h3>
            </div>
            <div className="det-body">
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <div className="empty-state-title">项目工作台专属</div>
                <div className="empty-state-desc">
                  决策支撑面板在项目工作台视图中显示
                </div>
              </div>
            </div>
          </>
        )}
      </aside>

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
              新建一个场景分析项目，上传产品资料后从阶段 0 开始推进
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
