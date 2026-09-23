import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  stage0Checks,
  stage0Overrides,
  type Project,
  type SourceTag,
  type Stage0Check,
  type Stage0Override,
} from "../../mock/project-data";
import { stage0Advice } from "../../mock/stage-data";

/* ═══ 评级徽标 ═══ */

function StatusBadge({ rating, label }: { rating: Stage0Check["rating"]; label: string }) {
  const cls = rating === "pass" ? "success" : rating === "warn" ? "warning" : "error";
  const sym = rating === "pass" ? "\u2705" : rating === "warn" ? "\u26a0\ufe0f" : "\u274c";
  return (
    <span className={`badge ${cls}`}>
      {sym} {label}
    </span>
  );
}

function StagBadge({ source }: { source: SourceTag }) {
  const cls = source === "AI" ? "ai" : source === "用户" ? "user" : "infer";
  return <span className={`stag ${cls}`}>{source}</span>;
}

/* ═══ 引用产品资料库横幅 ═══ */

const LibraryBanner: React.FC<{ productLine: string }> = ({ productLine }) => (
  <div className="bnr warning">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span>引用产品资料库：{productLine} · M1-M6 已同步 · 资料更新自动带入</span>
  </div>
);

/* ═══ 列定义 ═══ */

const stage0CheckColumns: ColumnDef<Stage0Check>[] = [
  { key: "index", label: "#" },
  { key: "item", label: "检查项" },
  {
    key: "statusLabel",
    label: "状态",
    render: (value, row) => <StatusBadge rating={row.rating} label={value as string} />,
  },
  { key: "risk", label: "缺失风险（后续阶段继承）" },
];

const stage0OverrideColumns: ColumnDef<Stage0Override>[] = [
  { key: "item", label: "覆盖项", editable: true },
  { key: "libraryValue", label: "资料库值" },
  { key: "sceneValue", label: "场景值", editable: true },
  { key: "reason", label: "原因", editable: true },
  {
    key: "source",
    label: "来源标记",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

/* ═══ 阶段 0 面板 ═══ */

interface Stage0PanelProps {
  project: Project;
  onNext?: () => void;
}

/**
 * 阶段 0：材料入库
 * - 引用横幅
 * - 完成度检查面板（8 项）
 * - 场景级覆盖表
 * - 无质量关，底部直接放建议卡
 */
export const Stage0Panel: React.FC<Stage0PanelProps> = ({ project, onNext }) => {
  const passCount = stage0Checks.filter((c) => c.rating === "pass").length;

  return (
    <>
      <LibraryBanner productLine={project.productLine} />

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>完成度检查</h2>
            <p>不阻断，仅记录缺失风险（对应 00b §2.4）</p>
          </div>
          <span className="badge warning">
            {passCount}/{stage0Checks.length} 通过
          </span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={stage0CheckColumns} data={stage0Checks} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>场景级覆盖</h2>
            <p>本场景对资料库的补充与覆盖（不影响资料库本身）</p>
          </div>
          <button className="btn" type="button">添加覆盖</button>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={stage0OverrideColumns} data={stage0Overrides} />
        </div>
      </div>

      <AdviceCard
        level={stage0Advice.level}
        reason={stage0Advice.reason}
        risks={stage0Advice.risks}
        conditions={stage0Advice.conditions}
        satisfied={stage0Advice.satisfied}
        total={stage0Advice.total}
        onNext={onNext}
        onSupplement={() => {}}
      />
    </>
  );
};