import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  internalReport,
  decisionSupport,
  type InternalReport,
  type DecisionSupport,
  type SourceTag,
} from "../../mock/project-data";
import { stage7Advice, gate6FullItems } from "../../mock/stage-data";

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

const reportColumns: ColumnDef<InternalReport>[] = [
  { key: "section", label: "章节", editable: true },
  { key: "content", label: "内容", editable: true },
  { key: "conclusion", label: "结论", editable: true },
  {
    key: "confidence",
    label: "置信度",
    render: (value) => {
      const v = value as string;
      const cls = v === "高" ? "success" : v === "中" ? "warning" : "error";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

const decisionColumns: ColumnDef<DecisionSupport>[] = [
  { key: "factor", label: "决策因素", editable: true },
  { key: "weight", label: "权重", editable: true },
  { key: "score", label: "得分", editable: true },
  { key: "weightedScore", label: "加权分", editable: true },
  {
    key: "recommendation",
    label: "建议",
    render: (value) => {
      const v = value as string;
      const cls = v === "强烈推荐" ? "success" : v === "推荐" ? "primary" : v === "中性" ? "warning" : "error";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
];

/* ═══ 决策汇总 ═══ */

interface DecisionSummaryProps {
  totalScore: number;
  recommendation: string;
  keyFactors: string[];
}

const DecisionSummary: React.FC<DecisionSummaryProps> = ({
  totalScore,
  recommendation,
  keyFactors,
}) => (
  <div className="decision-summary">
    <div className="decision-score">
      <span className="score-label">综合得分</span>
      <span className="score-value">{totalScore.toFixed(1)}</span>
      <span className="score-max">/100</span>
    </div>
    <div className="decision-recommendation">
      <span className="recommendation-label">建议</span>
      <span className={`recommendation-value ${totalScore >= 70 ? "success" : totalScore >= 50 ? "warning" : "error"}`}>
        {recommendation}
      </span>
    </div>
    <div className="decision-factors">
      <span className="factors-label">关键因素</span>
      <ul className="factors-list">
        {keyFactors.map((factor, index) => (
          <li key={index}>{factor}</li>
        ))}
      </ul>
    </div>
  </div>
);

/* ═══ 阶段 7 面板 ═══ */

interface Stage7PanelProps {
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 7：内部报告
 * - 表 7-1 内部调研报告
 * - 表 7-2 决策支撑
 * - 决策汇总
 * - 质量关 6（6 项检查）
 * - 建议卡
 */
export const Stage7Panel: React.FC<Stage7PanelProps> = ({
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate6FullItems.filter((i) => i.pass).length;

  // 计算决策汇总
  const totalScore = decisionSupport.reduce((sum, d) => sum + d.weightedScore, 0);
  const recommendation = totalScore >= 70 ? "强烈推荐进入" : totalScore >= 50 ? "建议有条件进入" : "不建议进入";
  const keyFactors = decisionSupport
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, 3)
    .map((d) => d.factor);

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 7-1 · 内部调研报告</h2>
            <p>给决策者看的结论性文档</p>
          </div>
          <span className="badge primary">{internalReport.length} 个章节</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={reportColumns} data={internalReport} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 7-2 · 决策支撑</h2>
            <p>量化决策因素、加权打分</p>
          </div>
          <span className="badge success">{decisionSupport.length} 个因素</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={decisionColumns} data={decisionSupport} />
        </div>
      </div>

      <DecisionSummary
        totalScore={totalScore}
        recommendation={recommendation}
        keyFactors={keyFactors}
      />

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 6 · 内部报告</h2>
            <p>6 项检查</p>
          </div>
          <span className={`badge ${passedCount === gate6FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate6FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate6FullItems.map((item) => (
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
        level={stage7Advice.level}
        reason={stage7Advice.reason}
        risks={stage7Advice.risks}
        conditions={stage7Advice.conditions}
        satisfied={stage7Advice.satisfied}
        total={stage7Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};
