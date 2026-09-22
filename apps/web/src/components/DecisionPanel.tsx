import React from "react";
import { decisionData, type RiskKind } from "../mock/project-data";

const RISK_LABELS: Record<RiskKind, string> = {
  inherit: "继承",
  gap: "缺口",
  ok: "通过",
};

const DEP_ARROWS: Record<"up" | "down", string> = {
  up: "←",
  down: "→",
};

/** 来源标记 → 标签样式（AI 蓝 / 用户绿 / 推断橙） */
const SOURCE_CLASSES: Record<string, string> = {
  AI: "ai",
  用户: "user",
  推断: "infer",
};

/**
 * 右栏：决策支撑面板
 * 四个分区：来源与证据 / 数据流向 / 风险与缺口 / 质量关快照
 * 数据暂为 mock（decisionData），后续由选中要素联动
 */
export const DecisionPanel: React.FC = () => {
  const d = decisionData;
  const gatePct = Math.round((d.gate.passed / d.gate.total) * 100);
  const stagClass = SOURCE_CLASSES[d.evidence.sourceTag] ?? "infer";

  return (
    <>
      <div className="det-h det-h-fixed">
        <h3>{d.title}</h3>
      </div>
      <div className="det-body det-body-flush">
        {/* 来源与证据 */}
        <div className="det-section">
          <div className="det-label">来源与证据</div>
          <div className="kv-grid">
            <span className="kv-k">来源标记</span>
            <span className="kv-v">
              <span className={`stag ${stagClass}`}>{d.evidence.sourceTag} 提取</span>
            </span>
            <span className="kv-k">证据等级</span>
            <span className="kv-v">
              <span className={`badge ${d.evidence.evidenceLevelKind}`}>{d.evidence.evidenceLevel}</span>
            </span>
            <span className="kv-k">权威性</span>
            <span className="kv-v">
              <span className={`badge ${d.evidence.authorityKind}`}>{d.evidence.authority}</span>
            </span>
            <span className="kv-k">出处</span>
            <span className="kv-v kv-mono">{d.evidence.citation}</span>
            <span className="kv-k">用户确认</span>
            <span className="kv-v">
              <span className={`badge ${d.evidence.confirmed ? "success" : "warning"}`}>
                {d.evidence.confirmed ? "已确认" : "未确认"}
              </span>
            </span>
          </div>
        </div>

        {/* 数据流向：上游 / 下游依赖 */}
        <div className="det-section">
          <div className="det-label">数据流向</div>
          {d.dependencies.map((dep) => (
            <div key={dep.text} className="dep-item">
              <span className="dep-arrow">{DEP_ARROWS[dep.dir]}</span>
              <div>
                <div className="dep-text">{dep.text}</div>
                <div className="dep-sub">{dep.sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 风险与缺口：继承风险 + 本阶段缺口 */}
        <div className="det-section">
          <div className="det-label">风险与缺口</div>
          {d.risks.map((risk) => (
            <div key={risk.title} className="risk-item">
              <span className={`risk-tag ${risk.kind}`}>{RISK_LABELS[risk.kind]}</span>
              <span className="risk-title">{risk.title}</span>
              <div className="risk-detail">{risk.detail}</div>
            </div>
          ))}
        </div>

        {/* 质量关快照：进度条 + 不通过项 */}
        <div className="det-section">
          <div className="det-label">{d.gate.label}</div>
          <div className="gate-snap">
            <div className="gate-bar">
              <div className="gate-fill" style={{ width: `${gatePct}%` }} />
            </div>
            <span className="gate-num">
              {d.gate.passed}/{d.gate.total}
            </span>
          </div>
          <div style={{ marginTop: "var(--s2)" }}>
            {d.gate.failed.map((item) => (
              <div key={item} className="risk-item">
                <span className="risk-tag gap">不通过</span>
                <span className="risk-title">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};
