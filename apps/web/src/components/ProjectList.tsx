import React, { useCallback, useEffect, useState } from "react";
import { FLOW_TOTAL } from "@scene/contract";
import type { Project } from "../mock/project-data";

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string;
  /** 当前选中会话（受控，App 持有；null=未选） */
  activeConvId: string | null;
  /** 选中项目（同时父级会切到项目工作台视图） */
  onSelectProject: (id: string) => void;
  /** 选中会话（对话抽屉随之切换） */
  onSelectConversation: (projectId: string, convId: string) => void;
  /** 项目 ⋯ 菜单动作（联真模式落地；演示模式不传，菜单为占位） */
  onProjectAction?: (project: Project, action: "重命名" | "归档" | "删除") => void;
  /** 会话 ⋯ 菜单动作（联真模式落地；演示模式不传，菜单为占位） */
  onConversationAction?: (
    project: Project,
    convId: string,
    convName: string,
    action: "重命名" | "归档" | "删除",
  ) => void;
}

/** ⋯ 菜单目标：项目或会话 */
interface MenuTarget {
  kind: "project" | "conversation";
  project: Project;
  /** 会话动作携带的会话 id（项目动作为 null） */
  convId: string | null;
  name: string;
  x: number;
  y: number;
}

/** 菜单尺寸估算（min-width 104 + 边框），用于防溢出翻转 */
const MENU_WIDTH = 106;
const MENU_HEIGHT = 108;
const MENU_OFFSET = 4;
const MENU_VIEWPORT_MARGIN = 8;

/**
 * 左栏项目列表
 * - 项目行：状态圆点 + 项目名，点击展开/收起会话（手风琴）
 * - 会话行：首字与项目名首字对齐
 * - 项目/会话行右侧 ⋯ 按钮（hover 显示）：重命名 / 归档 / 删除
 */
export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  activeProjectId,
  activeConvId,
  onSelectProject,
  onSelectConversation,
  onProjectAction,
  onConversationAction,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(activeProjectId);
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  /* 外部切换项目时同步展开（会话选中与展开态由 App/手风琴管理） */
  useEffect(() => {
    setExpandedId(activeProjectId);
  }, [activeProjectId]);

  const handleProjectClick = (project: Project) => {
    onSelectProject(project.id);
    setExpandedId((cur) => (cur === project.id ? null : project.id));
  };

  /* ⋯ 菜单：按按钮位置定位，底部溢出时向上翻转 */
  const openMenu = useCallback(
    (
      e: React.MouseEvent,
      kind: MenuTarget["kind"],
      project: Project,
      name: string,
      convId: string | null = null,
    ) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
      let x = rect.right - MENU_WIDTH;
      let y = rect.bottom + MENU_OFFSET;
      if (y + MENU_HEIGHT > window.innerHeight - MENU_VIEWPORT_MARGIN) {
        y = rect.top - MENU_HEIGHT - MENU_OFFSET;
      }
      if (x < MENU_VIEWPORT_MARGIN) x = MENU_VIEWPORT_MARGIN;
      setMenu({ kind, project, convId, name, x, y });
    },
    [],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  /* 菜单外点击 / Esc 关闭；动作回调仅联真模式传入，演示模式选中即关闭 */
  useEffect(() => {
    if (!menu) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".ctx-menu") && !target.closest(".more-btn")) closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, closeMenu]);

  const handleMenuAction = (action: "重命名" | "归档" | "删除") => {
    if (!menu) return;
    /* 联真模式经回调落库；演示模式回调缺省，仅收起菜单 */
    if (menu.kind === "project" && onProjectAction) {
      onProjectAction(menu.project, action);
    } else if (menu.kind === "conversation" && onConversationAction && menu.convId) {
      onConversationAction(menu.project, menu.convId, menu.name, action);
    }
    closeMenu();
  };

  return (
    <div className="proj-list">
      {projects.map((project) => {
        const isExpanded = expandedId === project.id;
        const isActive = activeProjectId === project.id;
        return (
          <div key={project.id} className={`proj${isExpanded ? " exp" : ""}`}>
            <div className="proj-hd-wrap">
              <button
                type="button"
                className={`proj-hd${isActive ? " active" : ""}`}
                title={project.name}
                aria-expanded={isExpanded}
                onClick={() => handleProjectClick(project)}
              >
                <span className={`proj-dot ${project.status === "done" ? "done" : "on"}`} />
                <span className="proj-nm">{project.name}</span>
                {/* 流程进度（v1.5）：后端未返回 flow 时不显示，不做本地猜测 */}
                {project.flow ? (
                  <span className="proj-step">
                    {project.flow.finished
                      ? `已完成 ${FLOW_TOTAL}/${FLOW_TOTAL} 步`
                      : `第 ${project.flow.currentStep}/${FLOW_TOTAL} 步`}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="more-btn"
                aria-label={`${project.name} 更多操作`}
                onClick={(e) => openMenu(e, "project", project, project.name)}
              >
                ⋯
              </button>
            </div>

            <div className="proj-convs">
              {project.conversations.map((conv) => {
                const isConvActive = isActive && activeConvId === conv.id;
                return (
                  <div
                    key={conv.id}
                    className={`cvi${isConvActive ? " on" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectConversation(project.id, conv.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectConversation(project.id, conv.id);
                      }
                    }}
                  >
                    <span className="cvx">{conv.name}</span>
                    <button
                      type="button"
                      className="more-btn"
                      aria-label={`${conv.name} 更多操作`}
                      onClick={(e) => openMenu(e, "conversation", project, conv.name, conv.id)}
                    >
                      ⋯
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {menu && (
        <div className="ctx-menu" role="menu" aria-label={`${menu.kind === "project" ? "项目" : "会话"}操作`} style={{ left: menu.x, top: menu.y }}>
          <button type="button" className="ctx-item" role="menuitem" onClick={() => handleMenuAction("重命名")}>
            重命名
          </button>
          <button type="button" className="ctx-item" role="menuitem" onClick={() => handleMenuAction("归档")}>
            归档
          </button>
          <button type="button" className="ctx-item danger" role="menuitem" onClick={() => handleMenuAction("删除")}>
            删除
          </button>
        </div>
      )}
    </div>
  );
};
