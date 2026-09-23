import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  pilotDesign,
  roiEstimate,
  type PilotDesign,
  type RoiEstimate,
  type SourceTag,
} from "../../mock/project-data";
import { stage6Advice, gate5FullItems } from "../../mock/stage-data";

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

const pilotColumns: ColumnDef<PilotDesign>[] = [
  { key: "phase", label: "试点阶段", editable: true },
  { key: "scope", label: "范围", editable: true },
  { key: "duration", label: "时长", editable: true },
  { key: "successCriteria", label: "成功标准", editable: true },
  { key: "risk", label: "风险", editable: true },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

const roiColumns: ColumnDef<RoiEstimate>[] = [
  { key: "metric", label: "指标", editable: true },
  { key: "baseline", label: "基线值", editable: true },
  { key: "improvement", label: "提升幅度", editable: true },
  { key: "monetaryValue", label: "货币价值", editable: true },
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

/* ═══ ROI 汇总 ═══ */

interface RoiSummaryProps {
  totalInvestment: number;
  totalBenefit: number;
  roi: number;
  paybackPeriod: number;
}

const RoiSummary: React.FC<RoiSummaryProps> = ({
  totalInvestment,
  totalBenefit,
  roi,
  paybackPeriod,
}) => (
  <div className="roi-summary">
    <div className="roi-item">
      <span className="roi-label">总投资</span>
      <span className="roi-value">¥{totalInvestment.toLocaleString()}</span>
    </div>
    <div className="roi-item">
      <span className="roi-label">总收益</span>
      <span className="roi-value">¥{totalBenefit.toLocaleString()}</span>
    </div>
    <div className="roi-item highlight">
      <span className="roi-label">投资回报率</span>
      <span className="roi-value">{roi.toFixed(1)}%</span>
    </div>
    <div className="roi-item">
      <span className="roi-label">回收周期</span>
      <span className="roi-value">{paybackPeriod} 个月</span>
    </div>
  </div>
);

/* ═══ 阶段 6 面板 ═══ */

interface Stage6PanelProps {
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 6：价值验证
 * - 表 6-3 投资回报估算
 * - 表 6-4 试点设计
 * - ROI 汇总
 * - 质量关 5（7 项检查）
 * - 建议卡
 */
export const Stage6Panel: React.FC<Stage6PanelProps> = ({
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate5FullItems.filter((i) => i.pass).length;

  // 计算 ROI 汇总
  const totalInvestment = roiEstimate
    .filter((r) => r.metric.includes("投入") || r.metric.includes("成本"))
    .reduce((sum, r) => sum + r.monetaryValue, 0);
  const totalBenefit = roiEstimate
    .filter((r) => r.metric.includes("收益") || r.metric.includes("节省"))
    .reduce((sum, r) => sum + r.monetaryValue, 0);
  const roi = totalInvestment > 0 ? ((totalBenefit - totalInvestment) / totalInvestment) * 100 : 0;
  const paybackPeriod = totalBenefit > 0 ? Math.ceil(totalInvestment / (totalBenefit / 12)) : 0;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 6-3 · 投资回报估算</h2>
            <p>投入和收益摆在一起，看值不值</p>
          </div>
          <span className="badge primary">{roiEstimate.length} 项指标</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={roiColumns} data={roiEstimate} />
        </div>
      </div>

      <RoiSummary
        totalInvestment={totalInvestment}
        totalBenefit={totalBenefit}
        roi={roi}
        paybackPeriod={paybackPeriod}
      />

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 6-4 · 试点设计</h2>
            <p>小范围验证、逐步扩大、降低风险</p>
          </div>
          <span className="badge success">{pilotDesign.length} 个阶段</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={pilotColumns} data={pilotDesign} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 5 · 价值验证</h2>
            <p>7 项检查</p>
          </div>
          <span className={`badge ${passedCount === gate5FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate5FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate5FullItems.map((item) => (
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
        level={stage6Advice.level}
        reason={stage6Advice.reason}
        risks={stage6Advice.risks}
        conditions={stage6Advice.conditions}
        satisfied={stage6Advice.satisfied}
        total={stage6Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};
