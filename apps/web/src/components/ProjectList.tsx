import React, { useCallback, useEffect, useState } from "react";
import type { Project } from "../mock/project-data";

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string;
  /** 选中项目（同时父级会切到项目工作台视图） */
  onSelectProject: (id: string) => void;
}

/** ⋯ 菜单目标：项目或会话 */
interface MenuTarget {
  kind: "project" | "conversation";
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
export const ProjectList: React.FC<ProjectListProps> = ({ projects, activeProjectId, onSelectProject }) => {
  const [expandedId, setExpandedId] = useState<string | null>(activeProjectId);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  /* 外部切换项目时同步展开并重置会话选中 */
  useEffect(() => {
    setExpandedId(activeProjectId);
    setActiveConvId(null);
  }, [activeProjectId]);

  const handleProjectClick = (project: Project) => {
    onSelectProject(project.id);
    setExpandedId((cur) => (cur === project.id ? null : project.id));
  };

  const handleConvClick = (convId: string) => {
    setActiveConvId(convId);
  };

  /* ⋯ 菜单：按按钮位置定位，底部溢出时向上翻转 */
  const openMenu = useCallback((e: React.MouseEvent, kind: MenuTarget["kind"], name: string) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    let x = rect.right - MENU_WIDTH;
    let y = rect.bottom + MENU_OFFSET;
    if (y + MENU_HEIGHT > window.innerHeight - MENU_VIEWPORT_MARGIN) {
      y = rect.top - MENU_HEIGHT - MENU_OFFSET;
    }
    if (x < MENU_VIEWPORT_MARGIN) x = MENU_VIEWPORT_MARGIN;
    setMenu({ kind, name, x, y });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  /* 菜单外点击 / Esc 关闭；菜单项为 mock 占位，选中即关闭 */
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

  const handleMenuAction = (_action: string) => {
    /* 重命名/归档/删除：T2.5 会话管理接入后落地，当前仅收起菜单 */
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
                aria-expanded={isExpanded}
                onClick={() => handleProjectClick(project)}
              >
                <span className={`proj-dot ${project.status === "done" ? "done" : "on"}`} />
                <span className="proj-nm">{project.name}</span>
              </button>
              <button
                type="button"
                className="more-btn"
                aria-label={`${project.name} 更多操作`}
                onClick={(e) => openMenu(e, "project", project.name)}
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
                    onClick={() => handleConvClick(conv.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleConvClick(conv.id);
                      }
                    }}
                  >
                    <span className="cvx">{conv.name}</span>
                    <button
                      type="button"
                      className="more-btn"
                      aria-label={`${conv.name} 更多操作`}
                      onClick={(e) => openMenu(e, "conversation", conv.name)}
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
