import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  barriers,
  sceneDefinition,
  type BarrierItem,
  type SceneDefinitionRow,
} from "../../mock/project-data";
import { stage1Advice, gate0FullItems } from "../../mock/stage-data";

/* ═══ 列定义 ═══ */

const definitionColumns: ColumnDef<SceneDefinitionRow>[] = [
  { key: "key", label: "项目" },
  { key: "value", label: "内容", editable: true },
];

const barrierColumns: ColumnDef<BarrierItem>[] = [
  {
    key: "category",
    label: "类别",
    render: (value, row) => (
      <span className={`badge ${row.isVeto ? "error" : "primary"}`}>{value as string}</span>
    ),
  },
  { key: "barrier", label: "门槛", editable: true },
  { key: "vetoer", label: "否决者", editable: true },
  {
    key: "statusLabel",
    label: "现状",
    render: (value, row) => (
      <span className={`badge ${row.rating === "pass" ? "success" : "warning"}`}>{value as string}</span>
    ),
  },
  {
    key: "authority",
    label: "权威性",
    render: (value) => {
      const t = value as BarrierItem["authority"];
      const cls = t === "T1" ? "success" : t === "T2" ? "primary" : "warning";
      return <span className={`badge ${cls}`}>{t}</span>;
    },
  },
];

/* ═══ 质量关 0 检查列表 ═══ */

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

/* ═══ 阶段 1 面板 ═══ */

interface Stage1PanelProps {
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 1：门槛筛查
 * - 表 1-1 场景定义
 * - 表 1-3 门槛扫描
 * - 质量关 0（10 项检查清单）
 * - 建议卡（"建议有条件进入"）
 */
export const Stage1Panel: React.FC<Stage1PanelProps> = ({
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate0FullItems.filter((i) => i.pass).length;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 1-1 · 场景定义</h2>
            <p>一句话说清这个场景是什么、谁在买</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={definitionColumns} data={sceneDefinition} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>表 1-3 · 门槛扫描</h2>
            <p>五类门槛：技术 / 行业准入 / 经济 / 生态锁定 / 一票否决者</p>
          </div>
          <span className="badge success">5/6 过得了</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={barrierColumns} data={barriers} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 0 · 门槛筛查</h2>
            <p>10 项检查（示意 6 项，完整清单见 00b §3.3）</p>
          </div>
          <span className={`badge ${passedCount === gate0FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate0FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate0FullItems.map((item) => (
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
        level={stage1Advice.level}
        reason={stage1Advice.reason}
        risks={stage1Advice.risks}
        conditions={stage1Advice.conditions}
        satisfied={stage1Advice.satisfied}
        total={stage1Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};