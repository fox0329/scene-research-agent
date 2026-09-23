import React, { useState } from "react";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import {
  knowledgeItems,
  type KnowledgeItem,
  type KnowledgeCategory,
} from "../mock/project-data";

/* ═══ 小部件 ═══ */

function CategoryBadge({ category }: { category: KnowledgeCategory }) {
  const cls =
    category === "竞品" ? "error" :
    category === "需求" ? "primary" :
    category === "趋势" ? "warning" :
    "success";
  return <span className={`badge ${cls}`}>{category}</span>;
}

function AuthorityBadge({ authority }: { authority: string }) {
  const cls =
    authority === "T1" ? "success" :
    authority === "T2" ? "primary" :
    "warning";
  return <span className={`badge ${cls}`}>{authority}</span>;
}

function StatusBadge({ confirmed }: { confirmed: boolean }) {
  return (
    <span className={`badge ${confirmed ? "success" : "warning"}`}>
      {confirmed ? "已确认" : "待确认"}
    </span>
  );
}

/* ═══ 统计卡片 ═══ */

interface StatsCardProps {
  label: string;
  value: number;
  color: string;
}

const StatsCard: React.FC<StatsCardProps> = ({ label, value, color }) => (
  <div className="stats-card" style={{ borderColor: color }}>
    <div className="stats-value" style={{ color }}>{value}</div>
    <div className="stats-label">{label}</div>
  </div>
);

/* ═══ 列定义 ═══ */

const columns: ColumnDef<KnowledgeItem>[] = [
  {
    key: "category",
    label: "分类",
    render: (value) => <CategoryBadge category={value as KnowledgeCategory} />,
  },
  { key: "content", label: "内容", editable: true },
  { key: "source", label: "来源", editable: true },
  {
    key: "source_authority",
    label: "权威性",
    render: (value) => <AuthorityBadge authority={value as string} />,
  },
  {
    key: "confirmed",
    label: "状态",
    render: (value) => <StatusBadge confirmed={value as boolean} />,
  },
  { key: "from_scenario_id", label: "来源场景" },
  { key: "created_at", label: "创建时间" },
];

/* ═══ 知识库视图 ═══ */

type TabType = "all" | KnowledgeCategory;

export const KnowledgeView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [searchKeyword, setSearchKeyword] = useState("");

  // 统计各分类数量
  const stats = {
    "竞品": knowledgeItems.filter((k) => k.category === "竞品").length,
    "需求": knowledgeItems.filter((k) => k.category === "需求").length,
    "趋势": knowledgeItems.filter((k) => k.category === "趋势").length,
    "成本": knowledgeItems.filter((k) => k.category === "成本").length,
  };

  // 过滤数据
  const filteredItems = knowledgeItems.filter((item) => {
    // Tab 过滤
    if (activeTab !== "all" && item.category !== activeTab) return false;

    // 关键词搜索
    if (searchKeyword) {
      const keyword = searchKeyword.toLowerCase();
      const contentMatch = item.content.toLowerCase().includes(keyword);
      const sourceMatch = item.source.toLowerCase().includes(keyword);
      if (!contentMatch && !sourceMatch) return false;
    }

    return true;
  });

  const tabs: Array<{ id: TabType; label: string; count: number }> = [
    { id: "all", label: "全部", count: knowledgeItems.length },
    { id: "竞品", label: "竞品", count: stats["竞品"] },
    { id: "需求", label: "需求", count: stats["需求"] },
    { id: "趋势", label: "趋势", count: stats["趋势"] },
    { id: "成本", label: "成本", count: stats["成本"] },
  ];

  return (
    <>
      {/* 页头 */}
      <div className="pgh pgh-fixed">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <div className="pgt">知识库</div>
          <span className="badge primary">{knowledgeItems.length} 条知识</span>
        </div>
        <div className="pga">
          <button className="btn" type="button">导出</button>
          <button className="btn primary" type="button">添加知识</button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="stats-grid">
        <StatsCard label="竞品" value={stats["竞品"]} color="var(--c-error)" />
        <StatsCard label="需求" value={stats["需求"]} color="var(--c-primary)" />
        <StatsCard label="趋势" value={stats["趋势"]} color="var(--c-warning)" />
        <StatsCard label="成本" value={stats["成本"]} color="var(--c-success)" />
      </div>

      {/* Tab 栏 */}
      <div className="stabs" role="tablist" aria-label="知识分类">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`stab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            <span className="stab-count">{tab.count}</span>
          </button>
        ))}
      </div>

      {/* 搜索栏 */}
      <div className="search-bar">
        <input
          type="text"
          className="search-input"
          placeholder="搜索知识内容或来源..."
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
        />
        {searchKeyword && (
          <button
            className="btn"
            type="button"
            onClick={() => setSearchKeyword("")}
          >
            清除
          </button>
        )}
      </div>

      {/* 知识表格 */}
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>知识条目</h2>
            <p>跨场景复用的知识资产，支持搜索和筛选</p>
          </div>
          <span className="badge primary">{filteredItems.length} 条</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={columns} data={filteredItems} />
        </div>
      </div>

      {/* 空状态 */}
      {filteredItems.length === 0 && (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div className="empty-state-title">暂无知识</div>
          <div className="empty-state-desc">
            {searchKeyword
              ? "没有找到匹配的知识条目"
              : "完成阶段 3/4/5 后，知识会自动沉淀到这里"}
          </div>
        </div>
      )}
    </>
  );
};
