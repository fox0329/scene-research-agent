import React, { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { LibraryView } from "./views/LibraryView";

/**
 * 场景通 — App 入口
 * 三栏布局骨架：左栏 256px / 中栏自适应 / 右栏 280px
 */
const App: React.FC = () => {
  const [activeView, setActiveView] = useState("library");

  return (
    <div className="shell">
      {/* 左栏：导航 */}
      <Sidebar activeView={activeView} onViewChange={setActiveView} />

      {/* 中栏：内容区 */}
      <main className="main">
        {activeView === "library" && <LibraryView />}
        {activeView === "knowledge" && <PlaceholderView title="知识库" desc="后续实现竞品情报 / 未满足需求 / 行业趋势 / 能力底账" />}
        {activeView === "settings" && <PlaceholderView title="设置" desc="后续实现 DSH 连接 / 模型选择 / 数据管理" />}
      </main>

      {/* 右栏：决策支撑（预留） */}
      <aside className="det">
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
            <div className="empty-state-title">后续版本</div>
            <div className="empty-state-desc">
              决策支撑面板将在接入真实数据后实现
            </div>
          </div>
        </div>
      </aside>
    </div>
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