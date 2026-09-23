import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  profitPool,
  alternatives,
  unmetNeeds,
  type ProfitPoolEntry,
  type Alternative,
  type UnmetNeed,
  type SourceTag,
} from "../../mock/project-data";
import { stage3Advice, gate2FullItems } from "../../mock/stage-data";

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

const profitPoolColumns: ColumnDef<ProfitPoolEntry>[] = [
  { key: "segment", label: "细分市场", editable: true },
  { key: "revenue", label: "营收规模", editable: true },
  { key: "margin", label: "利润率", editable: true },
  { key: "growth", label: "增长率", editable: true },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

const alternativeColumns: ColumnDef<Alternative>[] = [
  { key: "name", label: "替代方案", editable: true },
  { key: "cost", label: "成本", editable: true },
  { key: "featureCoverage", label: "功能覆盖率", editable: true },
  {
    key: "costComparison",
    label: "成本对比",
    render: (value) => {
      const v = value as string;
      const cls = v === "高于我方" ? "error" : v === "低于我方" ? "success" : "warning";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
  { key: "featureAdvantage", label: "功能优势", editable: true },
];

const unmetNeedColumns: ColumnDef<UnmetNeed>[] = [
  { key: "description", label: "未满足需求", editable: true },
  {
    key: "evidenceLevel",
    label: "证据等级",
    render: (value) => {
      const v = value as string;
      const cls = v === "A" ? "success" : v === "B" ? "primary" : v === "C" ? "warning" : "error";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
  {
    key: "sourceAuthority",
    label: "权威性",
    render: (value) => {
      const t = value as string;
      const cls = t === "T1" ? "success" : t === "T2" ? "primary" : "warning";
      return <span className={`badge ${cls}`}>{t}</span>;
    },
  },
  {
    key: "isConfirmed",
    label: "交叉验证",
    render: (value) => (
      <span className={`badge ${value ? "success" : "warning"}`}>
        {value ? "已确认" : "待确认"}
      </span>
    ),
  },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

/* ═══ 阶段 3 面板 ═══ */

interface Stage3PanelProps {
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 3：理解商业
 * - 表 3-1 利润池
 * - 表 3-6 替代方案
 * - 表 3-8 未被满足的需求
 * - 质量关 2（8 项检查）
 * - 建议卡
 */
export const Stage3Panel: React.FC<Stage3PanelProps> = ({
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate2FullItems.filter((i) => i.pass).length;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 3-1 · 利润池</h2>
            <p>钱怎么流、谁在赚、利润在哪里</p>
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
            <span className="badge primary">{profitPool.length} 个细分</span>
            <button className="btn" type="button">添加</button>
          </div>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={profitPoolColumns} data={profitPool} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 3-6 · 替代方案</h2>
            <p>客户不用我们还能用什么、成本和功能对比</p>
          </div>
          <span className="badge warning">成本 vs 功能矩阵</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={alternativeColumns} data={alternatives} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 3-8 · 未被满足的需求</h2>
            <p>客户痛点、证据等级、交叉验证状态</p>
          </div>
          <span className="badge success">
            {unmetNeeds.filter((n) => n.isConfirmed).length}/{unmetNeeds.length} 已确认
          </span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={unmetNeedColumns} data={unmetNeeds} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 2 · 理解商业</h2>
            <p>8 项检查</p>
          </div>
          <span className={`badge ${passedCount === gate2FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate2FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate2FullItems.map((item) => (
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
        level={stage3Advice.level}
        reason={stage3Advice.reason}
        risks={stage3Advice.risks}
        conditions={stage3Advice.conditions}
        satisfied={stage3Advice.satisfied}
        total={stage3Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};
