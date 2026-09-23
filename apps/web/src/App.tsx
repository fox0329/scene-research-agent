import React, { useCallback, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ConversationDrawer } from "./components/ConversationDrawer";
import { DecisionPanel } from "./components/DecisionPanel";
import { ToastProvider } from "./components/Toast";
import { LibraryView } from "./views/LibraryView";
import { ProjectView } from "./views/ProjectView";
import { SettingsView } from "./views/SettingsView";
import { KnowledgeView } from "./views/KnowledgeView";
import { conversationMessages, projects } from "./mock/project-data";

/** 主视图：project 项目工作台（默认）/ library 资料库 / knowledge 知识库 / settings 设置 */
type ViewName = "project" | "library" | "knowledge" | "settings";

/**
 * 场景通 — App 入口
 * 三栏布局骨架：左栏 256px / 中栏自适应 / 右栏 280px
 * 中栏底部常驻对话输入栏（展开成对话抽屉）
 */
const App: React.FC = () => {
  const [view, setView] = useState<ViewName>("project");
  const [activeProjectId, setActiveProjectId] = useState(projects[0].id);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];

  /** 左栏选中项目：切换项目并回到项目工作台 */
  const handleSelectProject = (id: string) => {
    setActiveProjectId(id);
    setView("project");
  };

  /** 左栏底部入口：切换主视图（收窄 string 到 ViewName） */
  const handleViewChange = useCallback((v: string) => {
    if (v === "library" || v === "knowledge" || v === "settings") {
      setView(v);
    }
  }, []);

  return (
    <ToastProvider>
    <div className="shell">
      {/* 左栏：导航 + 项目列表 */}
      <Sidebar
        activeView={view}
        onViewChange={handleViewChange}
        projects={projects}
        activeProjectId={activeProject.id}
        onSelectProject={handleSelectProject}
      />

      {/* 中栏：内容区 + 常驻输入栏 */}
      <main className="main">
        {view === "project" && <ProjectView key={activeProject.id} project={activeProject} />}
        {view === "library" && <LibraryView />}
        {view === "knowledge" && <KnowledgeView />}
        {view === "settings" && <SettingsView />}
        <ConversationDrawer messages={conversationMessages} />
      </main>

      {/* 右栏：决策支撑（项目工作台实装，其余视图预留） */}
      <aside className="det">
        {view === "project" ? (
          <DecisionPanel />
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
    </div>
    </ToastProvider>
  );
};

/** 占位视图（知识库/设置未实现时显示） */
const PlaceholderView: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
  <>
    <div className="pgh">
      <div className="pgt">{title}</div>
    </div>
    <div className="ws">
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>{title}</h2>
            <p>{desc}</p>
          </div>
        </div>
        <div className="pnl-b">
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <div className="empty-state-title">即将实现</div>
            <div className="empty-state-desc">{desc}</div>
          </div>
        </div>
      </div>
    </div>
  </>
);

export default App;
