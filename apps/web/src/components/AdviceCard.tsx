import React from "react";
import type { AdviceLevel } from "../mock/stage-data";

interface AdviceCardProps {
  level: AdviceLevel;
  reason: string;
  risks: string[];
  conditions?: string[];
  satisfied: number;
  total: number;
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/** 建议等级 → CSS class 映射 */
const LEVEL_CLASS: Record<AdviceLevel, string> = {
  "建议通过": "pass",
  "建议有条件通过": "cond",
  "建议不通过": "no",
};

/**
 * 阶段建议卡（通用组件）
 * 三档徽标 + 一句话结论 + 理由 + 检查项完成情况 + 不满足项列表 + 三个决定按钮
 * 阶段 3-8 后续复用此组件
 */
export const AdviceCard: React.FC<AdviceCardProps> = ({
  level,
  reason,
  risks,
  conditions,
  satisfied,
  total,
  onNext,
  onSupplement,
  onStop,
}) => {
  const badgeCls = LEVEL_CLASS[level];
  const pct = Math.round((satisfied / total) * 100);

  return (
    <div className="rec">
      <div className="rec-hd">
        <span className={`rec-badge ${badgeCls}`}>{level}</span>
        <span className="rec-title">{reason}</span>
      </div>

      <div className="rec-sec">
        <h4>检查项完成情况</h4>
        <div className="rec-progress">
          <div className="rec-bar">
            <div className="rec-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="rec-bar-num">
            {satisfied}/{total}
          </span>
        </div>
      </div>

      {risks.length > 0 && (
        <div className="rec-sec">
          <h4>不满足项</h4>
          <ul className="rec-list">
            {risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {conditions && conditions.length > 0 && (
        <div className="rec-sec">
          <h4>建议前提条件</h4>
          <ul className="rec-list">
            {conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rec-actions">
        {onNext && (
          <button className="btn primary" type="button" onClick={onNext}>
            进入下一阶段
          </button>
        )}
        {onSupplement && (
          <button className="btn" type="button" onClick={onSupplement}>
            补充材料
          </button>
        )}
        {onStop && (
          <button className="btn" type="button" onClick={onStop}>
            停止分析
          </button>
        )}
      </div>
    </div>
  );
};