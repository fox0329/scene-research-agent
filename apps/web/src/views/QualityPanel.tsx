import React from "react";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { qualityDimensions, reminders, type QualityDimension, type ReminderItem } from "../mock/library-data";

/* ── 评级 → Badge 映射 ── */
function RatingBadge({ rating }: { rating: QualityDimension["rating"] }) {
  const cls =
    rating === "pass" ? "success" :
    rating === "warn" ? "warning" :
    "error";
  const label =
    rating === "pass" ? "\u2705" :
    rating === "warn" ? "\u26a0\ufe0f" :
    "\u274c";
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ── 质量总评列定义 ── */
const qualityColumns: ColumnDef<QualityDimension>[] = [
  { key: "dimension", label: "维度" },
  {
    key: "rating",
    label: "评级",
    render: (value) => <RatingBadge rating={value as QualityDimension["rating"]} />,
  },
  { key: "note", label: "说明", editable: true },
];

/* ── 补充提醒列定义 ── */
const reminderColumns: ColumnDef<ReminderItem>[] = [
  { key: "table",   label: "对应表" },
  { key: "missing", label: "缺失项" },
  { key: "impact",  label: "缺失影响" },
];

/**
 * 质量总评面板
 * - 六维评估表格（状态可分辨/可追溯/可验证/有时效/含边界/含反面）
 * - 每维：维度名 + 评级(✅/⚠️/❌) + 说明
 * - 补充提醒表（缺失项 + 缺失影响 + 建议操作）
 */
export const QualityPanel: React.FC = () => {
  const passCount = qualityDimensions.filter((d) => d.rating === "pass").length;
  const totalCount = qualityDimensions.length;

  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量总评</h2>
            <p>材料整体质量六维评估</p>
          </div>
          <span className="badge warning">{passCount}/{totalCount} 达标</span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={qualityColumns} data={qualityDimensions} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>材料补充提醒</h2>
            <p>不阻断流程，仅提示缺失影响</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={reminderColumns} data={reminders} />
        </div>
      </div>
    </>
  );
};