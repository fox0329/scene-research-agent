import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  capabilityMatch,
  priorityMatrix,
  type CapabilityMatch,
  type PriorityMatrix,
  type SourceTag,
} from "../../mock/project-data";
import { stage4Advice, gate3FullItems } from "../../mock/stage-data";

/* ═══ 小部件 ═══ */

function StagBadge({ source }: { source: SourceTag }) {
  const cls = source === "AI" ? "ai" : source === "用户" ? "user" : "infer";
  return <span className={`stag ${cls}`}>{source}</span>;
}

/** SVG 勾选图标 */
const CheckIcon: React.FC = () => (
  <svg className="ci pass" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

/** SVG 叉号图标 */
const CrossIcon: React.FC = () => (
  <svg className="ci fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <line x1="15" y1="9" x2="9" y2="15" />
    <line x1="9" y1="9" x2="15" y2="15" />
  </svg>
);

/* ═══ 列定义 ═══ */

const matchColumns: ColumnDef<CapabilityMatch>[] = [
  { key: "scene", label: "场景需求", editable: true },
  { key: "capability", label: "我方能力", editable: true },
  {
    key: "matchLevel",
    label: "匹配度",
    render: (value) => {
      const v = value as string;
      const cls = v === "完全匹配" ? "success" : v === "部分匹配" ? "warning" : "error";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
  { key: "gap", label: "差距", editable: true },
  { key: "effort", label: "补齐成本", editable: true },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

const priorityColumns: ColumnDef<PriorityMatrix>[] = [
  { key: "scene", label: "细分场景", editable: true },
  { key: "painScore", label: "痛点分数", editable: true },
  { key: "matchScore", label: "匹配分数", editable: true },
  { key: "priorityScore", label: "优先级分数", editable: true },
  {
    key: "rank",
    label: "排名",
    render: (value) => <span className="badge primary">#{value as number}</span>,
  },
  {
    key: "recommendation",
    label: "建议",
    render: (value) => {
      const v = value as string;
      const cls = v === "优先推进" ? "success" : v === "条件推进" ? "warning" : "error";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
];

/* ═══ 阶段 4 面板 ═══ */

interface Stage4PanelProps {
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 4：能力匹配
 * - 表 4-3 缺口×能力匹配矩阵
 * - 表 4-4 场景优先级矩阵
 * - 质量关 3（7 项检查）
 * - 建议卡
 */
export const Stage4Panel: React.FC<Stage4PanelProps> = ({
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate3FullItems.filter((i) => i.pass).length;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 4-3 · 缺口×能力匹配矩阵</h2>
            <p>我方能力 vs 场景需求，差距在哪、补齐要多少成本</p>
          </div>
          <span className="badge warning">
            {capabilityMatch.filter((m) => m.matchLevel !== "完全匹配").length} 个缺口
          </span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={matchColumns} data={capabilityMatch} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 4-4 · 场景优先级矩阵</h2>
            <p>痛点×匹配综合排序，决定先做哪个细分</p>
          </div>
          <span className="badge success">{priorityMatrix.length} 个细分场景</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={priorityColumns} data={priorityMatrix} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 3 · 能力匹配</h2>
            <p>7 项检查</p>
          </div>
          <span className={`badge ${passedCount === gate3FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate3FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate3FullItems.map((item) => (
              <li key={item.title} className="cli">
                {item.pass ? <CheckIcon /> : <CrossIcon />}
                <div>
                  <div className="ct">{item.title}</div>
                  <div className="cd">{item.desc}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <AdviceCard
        level={stage4Advice.level}
        reason={stage4Advice.reason}
        risks={stage4Advice.risks}
        conditions={stage4Advice.conditions}
        satisfied={stage4Advice.satisfied}
        total={stage4Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};
