import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  externalReport,
  deliverables,
  type ExternalReport,
  type Deliverable,
  type SourceTag,
} from "../../mock/project-data";
import { stage8Advice, gate7FullItems } from "../../mock/stage-data";

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

const reportColumns: ColumnDef<ExternalReport>[] = [
  { key: "section", label: "章节", editable: true },
  { key: "content", label: "内容", editable: true },
  { key: "audience", label: "受众", editable: true },
  {
    key: "tone",
    label: "语气",
    render: (value) => {
      const v = value as string;
      const cls = v === "自信" ? "success" : v === "客观" ? "primary" : "warning";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

const deliverableColumns: ColumnDef<Deliverable>[] = [
  { key: "name", label: "交付物", editable: true },
  { key: "format", label: "格式", editable: true },
  { key: "description", label: "说明", editable: true },
  {
    key: "status",
    label: "状态",
    render: (value) => {
      const v = value as string;
      const cls = v === "已完成" ? "success" : v === "进行中" ? "warning" : "error";
      return <span className={`badge ${cls}`}>{v}</span>;
    },
  },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

/* ═══ 交付物汇总 ═══ */

interface DeliverableSummaryProps {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

const DeliverableSummary: React.FC<DeliverableSummaryProps> = ({
  total,
  completed,
  inProgress,
  pending,
}) => (
  <div className="deliverable-summary">
    <div className="deliverable-item">
      <span className="deliverable-label">总计</span>
      <span className="deliverable-value">{total}</span>
    </div>
    <div className="deliverable-item success">
      <span className="deliverable-label">已完成</span>
      <span className="deliverable-value">{completed}</span>
    </div>
    <div className="deliverable-item warning">
      <span className="deliverable-label">进行中</span>
      <span className="deliverable-value">{inProgress}</span>
    </div>
    <div className="deliverable-item error">
      <span className="deliverable-label">待处理</span>
      <span className="deliverable-value">{pending}</span>
    </div>
  </div>
);

/* ═══ 阶段 8 面板 ═══ */

interface Stage8PanelProps {
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 8：外部报告
 * - 表 8-1 外部调研报告
 * - 表 8-2 交付物清单
 * - 交付物汇总
 * - 质量关 7（6 项检查）
 * - 建议卡
 */
export const Stage8Panel: React.FC<Stage8PanelProps> = ({
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate7FullItems.filter((i) => i.pass).length;

  // 计算交付物汇总
  const totalDeliverables = deliverables.length;
  const completedDeliverables = deliverables.filter((d) => d.status === "已完成").length;
  const inProgressDeliverables = deliverables.filter((d) => d.status === "进行中").length;
  const pendingDeliverables = deliverables.filter((d) => d.status === "待处理").length;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 8-1 · 外部调研报告</h2>
            <p>给客户看的解决方案文档</p>
          </div>
          <span className="badge primary">{externalReport.length} 个章节</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={reportColumns} data={externalReport} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 8-2 · 交付物清单</h2>
            <p>所有交付物及其状态</p>
          </div>
          <span className="badge success">{completedDeliverables}/{totalDeliverables} 已完成</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={deliverableColumns} data={deliverables} />
        </div>
      </div>

      <DeliverableSummary
        total={totalDeliverables}
        completed={completedDeliverables}
        inProgress={inProgressDeliverables}
        pending={pendingDeliverables}
      />

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 7 · 外部报告</h2>
            <p>6 项检查</p>
          </div>
          <span className={`badge ${passedCount === gate7FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate7FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate7FullItems.map((item) => (
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
        level={stage8Advice.level}
        reason={stage8Advice.reason}
        risks={stage8Advice.risks}
        conditions={stage8Advice.conditions}
        satisfied={stage8Advice.satisfied}
        total={stage8Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};
