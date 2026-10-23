import React from "react";
import { ProjectList } from "./ProjectList";
import type { Project } from "../mock/project-data";

interface SidebarProps {
  activeView: string;
  onViewChange: (view: string) => void;
  projects: Project[];
  activeProjectId: string;
  /** 选中项目：父级切换 activeProjectId 并切到项目工作台视图 */
  onSelectProject: (id: string) => void;
  /** 新建项目（联真模式接 api.createProject；演示模式不传，按钮保持占位） */
  onNewProject?: () => void;
  /** 项目 ⋯ 菜单动作（重命名/归档/删除） */
  onProjectAction?: (project: Project, action: "重命名" | "归档" | "删除") => void;
  /** 真实计数（联真模式）；缺省显示演示占位 */
  libraryCount?: number | null;
  /** 重新打开首次使用引导（用户可随时回看怎么用） */
  onOpenGuide?: () => void;
}

/**
 * 左栏导航
 * 顶部：产品名 + 新建按钮
 * 基础设施区（常驻，与场景无关）：产品资料库
 * 场景区：场景列表（只围绕场景，见 ProjectList）——每项显示「第 n/6 步」
 * 底部：设置
 */
export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onViewChange,
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onProjectAction,
  libraryCount,
  onOpenGuide,
}) => {
  return (
    <nav className="side">
      <div className="side-hd">
        <h1>场景通</h1>
        {/* 新建项目：联真模式接 API；演示模式保持占位入口 */}
        <button className="nbtn" type="button" aria-label="新建项目" onClick={onNewProject}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>新建</span>
        </button>
      </div>

      {/* 基础设施区：与场景无关的常驻入口（资料库） */}
      <div className="side-group">
        <div className="side-group-title">基础设施</div>
        <button
          className={`nav-item${activeView === "library" ? " active" : ""}`}
          onClick={() => onViewChange("library")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span>产品资料库</span>
          <span className="count">{libraryCount != null ? `${libraryCount} 线` : "2 线"}</span>
        </button>
      </div>

      <div className="side-group-title side-group-title--list">场景</div>
      <div className="side-body">
        <ProjectList
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectProject={onSelectProject}
          onProjectAction={onProjectAction}
        />
      </div>
      <div className="side-foot">
        {onOpenGuide ? (
          <button className="nav-item" type="button" onClick={onOpenGuide}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>使用引导</span>
          </button>
        ) : null}
        <button
          className={`nav-item${activeView === "settings" ? " active" : ""}`}
          onClick={() => onViewChange("settings")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>设置</span>
        </button>
      </div>
    </nav>
  );
};
