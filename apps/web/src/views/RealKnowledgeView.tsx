import React, { useMemo, useState } from "react";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { useAsync } from "../hooks/useAsync";
import { api, type ApiKnowledge } from "../api";

/**
 * 知识库视图（联真模式，M5 试用反馈 #46）
 * - 数据来自 GET /api/v1/knowledge（knowledge 表只读资产，随阶段 3/4/5 自动沉淀）
 * - 分类统计/Tab/搜索均为真实计数；契约无 confirmed 字段，不渲染"状态"列
 * - §4.3 三态：加载 / 空态（引导完成分析后自动沉淀）/ 降级（错误+重试）
 */

type TabType = "all" | ApiKnowledge["category"];

const CATEGORIES: ApiKnowledge["category"][] = ["竞品", "需求", "趋势", "成本"];

function CategoryBadge({ category }: { category: ApiKnowledge["category"] }) {
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

const columns: ColumnDef<ApiKnowledge & Record<string, unknown>>[] = [
  {
    key: "category",
    label: "分类",
    render: (value) => <CategoryBadge category={value as ApiKnowledge["category"]} />,
  },
  { key: "content", label: "内容" },
  { key: "source", label: "来源" },
  {
    key: "source_authority",
    label: "权威性",
    render: (value) => <AuthorityBadge authority={String(value ?? "")} />,
  },
  { key: "from_scenario_id", label: "来源场景" },
  { key: "created_at", label: "创建时间" },
];

export const RealKnowledgeView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [searchKeyword, setSearchKeyword] = useState("");

  const { status, data, error, reload } = useAsync<ApiKnowledge[]>(
    () => api.knowledge(),
    [],
  );
  const items = useMemo(() => data ?? [], [data]);

  const stats = useMemo(
    () =>
      Object.fromEntries(
        CATEGORIES.map((c) => [c, items.filter((k) => k.category === c).length]),
      ) as Record<ApiKnowledge["category"], number>,
    [items],
  );

  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (activeTab !== "all" && item.category !== activeTab) return false;
        if (searchKeyword) {
          const kw = searchKeyword.toLowerCase();
          if (
            !item.content.toLowerCase().includes(kw) &&
            !item.source.toLowerCase().includes(kw)
          )
            return false;
        }
        return true;
      }),
    [items, activeTab, searchKeyword],
  );

  const tabs: Array<{ id: TabType; label: string; count: number }> = [
    { id: "all", label: "全部", count: items.length },
    ...CATEGORIES.map((c) => ({ id: c as TabType, label: c, count: stats[c] })),
  ];

  /* ── 加载态 ── */
  if (status === "loading") {
    return (
      <>
        <div className="pgh pgh-fixed">
          <div className="pgt">知识库</div>
        </div>
        <div className="pnl">
          <div className="pnl-h"><div><h2>知识条目</h2><p>加载中…</p></div></div>
          <div className="pnl-b"><div className="loading-strip" role="status" aria-label="加载中" /></div>
        </div>
      </>
    );
  }

  /* ── 降级态 ── */
  if (status === "error") {
    return (
      <>
        <div className="pgh pgh-fixed">
          <div className="pgt">知识库</div>
        </div>
        <div className="pnl">
          <div className="pnl-h">
            <div><h2>知识条目</h2><p>数据加载失败</p></div>
            <button className="btn" type="button" onClick={reload}>重试</button>
          </div>
          <div className="pnl-b">
            <div className="empty-state">
              <div className="empty-state-title">加载失败</div>
              <div className="empty-state-desc">{error}</div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* 页头 */}
      <div className="pgh pgh-fixed">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <div className="pgt">知识库</div>
          <span className="badge success">实时数据</span>
          <span className="badge primary">{items.length} 条知识</span>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="stats-grid">
        {CATEGORIES.map((c) => (
          <div key={c} className="stats-card" style={{ borderColor: "var(--c-primary)" }}>
            <div className="stats-value">{stats[c]}</div>
            <div className="stats-label">{c}</div>
          </div>
        ))}
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
          <button className="btn" type="button" onClick={() => setSearchKeyword("")}>
            清除
          </button>
        )}
      </div>

      {/* 知识表格（只读：knowledge 为自动沉淀资产） */}
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>知识条目</h2>
            <p>跨场景复用的知识资产，随阶段分析自动沉淀</p>
          </div>
          <span className="badge primary">{filtered.length} 条</span>
        </div>
        <div className="pnl-b flush">
          {filtered.length > 0 ? (
            <SceneTable
              columns={columns}
              data={filtered as unknown as (ApiKnowledge & Record<string, unknown>)[]}
            />
          ) : null}
        </div>
      </div>

      {/* 空态 */}
      {filtered.length === 0 && (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div className="empty-state-title">暂无知识</div>
          <div className="empty-state-desc">
            {searchKeyword || activeTab !== "all"
              ? "没有找到匹配的知识条目"
              : "完成阶段 3/4/5 后，知识会自动沉淀到这里"}
          </div>
        </div>
      )}
    </>
  );
};
