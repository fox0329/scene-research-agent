import React, { useCallback, useEffect, useState } from "react";
import { FLOW_TOTAL } from "@scene/contract";
import type { Project } from "../mock/project-data";

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string;
  /** 选中项目（父级切到项目工作台视图） */
  onSelectProject: (id: string) => void;
  /** 项目 ⋯ 菜单动作（联真模式落地；演示模式不传，菜单为占位） */
  onProjectAction?: (project: Project, action: "重命名" | "归档" | "删除") => void;
}

/** ⋯ 菜单目标：左栏只有场景，不再有会话层级 */
interface MenuTarget {
  project: Project;
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
 * 左栏场景列表（v2：只围绕场景，不再挂会话）
 *
 * 产品定调（变更表 #295）：左栏不变化、不出现会话导航——会话属于右栏的
 * 某个阶段产物，一个产物只有一条会话。因此这里只保留场景行与场景 ⋯ 菜单。
 */
export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  activeProjectId,
  onSelectProject,
  onProjectAction,
}) => {
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  /* ⋯ 菜单：按按钮位置定位，底部溢出时向上翻转 */
  const openMenu = useCallback(
    (e: React.MouseEvent, project: Project, name: string) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
      let x = rect.right - MENU_WIDTH;
      let y = rect.bottom + MENU_OFFSET;
      if (y + MENU_HEIGHT > window.innerHeight - MENU_VIEWPORT_MARGIN) {
        y = rect.top - MENU_HEIGHT - MENU_OFFSET;
      }
      if (x < MENU_VIEWPORT_MARGIN) x = MENU_VIEWPORT_MARGIN;
      setMenu({ project, name, x, y });
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
    if (onProjectAction) onProjectAction(menu.project, action);
    closeMenu();
  };

  return (
    <div className="proj-list">
      {projects.map((project) => {
        const isActive = activeProjectId === project.id;
        return (
          <div key={project.id} className="proj">
            <div className="proj-hd-wrap">
              <button
                type="button"
                className={`proj-hd${isActive ? " active" : ""}`}
                title={project.name}
                onClick={() => onSelectProject(project.id)}
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
                onClick={(e) => openMenu(e, project, project.name)}
              >
                ⋯
              </button>
            </div>
          </div>
        );
      })}

      {menu && (
        <div
          className="ctx-menu"
          role="menu"
          aria-label="场景操作"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => handleMenuAction("重命名")}
          >
            重命名
          </button>
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => handleMenuAction("归档")}
          >
            归档
          </button>
          <button
            type="button"
            className="ctx-item danger"
            role="menuitem"
            onClick={() => handleMenuAction("删除")}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
};
