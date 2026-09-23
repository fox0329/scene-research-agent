import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  costEstimate,
  competitorPricing,
  type CostEstimate,
  type CompetitorPricing,
  type SourceTag,
} from "../../mock/project-data";
import { stage5Advice, gate4FullItems } from "../../mock/stage-data";

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

const costColumns: ColumnDef<CostEstimate>[] = [
  { key: "category", label: "成本类别", editable: true },
  { key: "item", label: "项目", editable: true },
  { key: "unitCost", label: "单价", editable: true },
  { key: "quantity", label: "数量", editable: true },
  { key: "total", label: "小计", editable: true },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

const competitorColumns: ColumnDef<CompetitorPricing>[] = [
  { key: "competitor", label: "竞品", editable: true },
  { key: "price", label: "报价", editable: true },
  { key: "coverage", label: "功能覆盖率", editable: true },
  {
    key: "priceComparison",
    label: "价格对比",
    render: (value) => {
      const v = value as string;
      const cls = v === "高于我方" ? "success" : v === "低于我方" ? "error" : "warning";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
  { key: "advantage", label: "我方优势", editable: true },
];

/* ═══ 成本汇总 ═══ */

interface CostSummaryProps {
  hardware: number;
  software: number;
  service: number;
  total: number;
}

const CostSummary: React.FC<CostSummaryProps> = ({ hardware, software, service, total }) => (
  <div className="cost-summary">
    <div className="cost-item">
      <span className="cost-label">硬件成本</span>
      <span className="cost-value">¥{hardware.toLocaleString()}</span>
    </div>
    <div className="cost-item">
      <span className="cost-label">软件成本</span>
      <span className="cost-value">¥{software.toLocaleString()}</span>
    </div>
    <div className="cost-item">
      <span className="cost-label">服务成本</span>
      <span className="cost-value">¥{service.toLocaleString()}</span>
    </div>
    <div className="cost-item total">
      <span className="cost-label">总计</span>
      <span className="cost-value">¥{total.toLocaleString()}</span>
    </div>
  </div>
);

/* ═══ 阶段 5 面板 ═══ */

interface Stage5PanelProps {
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 5：方案设计
 * - 表 5-5 成本估算
 * - 表 5-6 竞品价格对照
 * - 成本汇总
 * - 质量关 4（6 项检查）
 * - 建议卡
 */
export const Stage5Panel: React.FC<Stage5PanelProps> = ({
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate4FullItems.filter((i) => i.pass).length;

  // 计算成本汇总
  const hardwareCost = costEstimate
    .filter((c) => c.category === "硬件")
    .reduce((sum, c) => sum + c.total, 0);
  const softwareCost = costEstimate
    .filter((c) => c.category === "软件")
    .reduce((sum, c) => sum + c.total, 0);
  const serviceCost = costEstimate
    .filter((c) => c.category === "服务")
    .reduce((sum, c) => sum + c.total, 0);
  const totalCost = hardwareCost + softwareCost + serviceCost;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 5-5 · 成本估算</h2>
            <p>硬件、软件、服务各项成本明细</p>
          </div>
          <span className="badge primary">{costEstimate.length} 项</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={costColumns} data={costEstimate} />
        </div>
      </div>

      <CostSummary
        hardware={hardwareCost}
        software={softwareCost}
        service={serviceCost}
        total={totalCost}
      />

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 5-6 · 竞品价格对照</h2>
            <p>对照方案根据阶段 3 的替代方案选取</p>
          </div>
          <span className="badge warning">
            {competitorPricing.filter((c) => c.priceComparison === "低于我方").length} 个更便宜
          </span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={competitorColumns} data={competitorPricing} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 4 · 方案设计</h2>
            <p>6 项检查</p>
          </div>
          <span className={`badge ${passedCount === gate4FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate4FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate4FullItems.map((item) => (
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
        level={stage5Advice.level}
        reason={stage5Advice.reason}
        risks={stage5Advice.risks}
        conditions={stage5Advice.conditions}
        satisfied={stage5Advice.satisfied}
        total={stage5Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};
