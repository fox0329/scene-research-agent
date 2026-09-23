import React from "react";
import { decisionData, type RiskKind } from "../mock/project-data";
import { ADVICE_BADGE, type DecisionSnapshot } from "./decision-snapshot";

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

interface DecisionPanelProps {
  /** 联真模式快照（来自当前阶段真实数据）；为空时回落 mock（演示模式） */
  snapshot?: DecisionSnapshot | null;
  /** 联真模式：无快照时渲染空态，不再回落 mock（M5 试用反馈 #46） */
  live?: boolean;
}

/**
 * 右栏：决策支撑面板
 * 四个分区：来源与证据 / 数据流向 / 风险与缺口 / 质量关快照
 * - 联真模式（snapshot）：三档建议 + 证据/权威性分布 + 真实质量关
 * - 联真模式无快照：空态引导（当前阶段尚无分析数据）
 * - 演示模式：回落 mock decisionData，DOM 结构一致
 */
export const DecisionPanel: React.FC<DecisionPanelProps> = ({ snapshot, live }) => {
  if (snapshot) return <DecisionPanelLive s={snapshot} />;
  if (live) return <DecisionPanelPending />;
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

/** 分布对象 → "A×3 B×1" 摘要（空分布给占位） */
function distText(dist: Record<string, number>): string {
  const parts = Object.entries(dist).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`);
  return parts.length ? parts.join("  ") : "—";
}

/** 联真模式：来源与证据 / 阶段与建议 / 风险与缺口 / 质量关快照（全部来自真实落库数据） */
const DecisionPanelLive: React.FC<{ s: DecisionSnapshot }> = ({ s }) => {
  const gatePct = s.gateTotal ? Math.round((s.gatePassed / s.gateTotal) * 100) : 0;
  return (
    <>
      <div className="det-h det-h-fixed">
        <h3>决策支撑</h3>
      </div>
      <div className="det-body det-body-flush">
        {/* 来源与证据：行级证据分级/权威性分布（G-R1/G-R2 落库口径） */}
        <div className="det-section">
          <div className="det-label">来源与证据</div>
          <div className="kv-grid">
            <span className="kv-k">阶段结果</span>
            <span className="kv-v">{s.rowCount} 行（用户确认 {s.userConfirmed}）</span>
            <span className="kv-k">证据等级</span>
            <span className="kv-v kv-mono">{distText(s.evidenceDist)}</span>
            <span className="kv-k">权威性</span>
            <span className="kv-v kv-mono">{distText(s.authorityDist)}</span>
            <span className="kv-k">待重算</span>
            <span className="kv-v">
              <span className={`badge ${s.staleCount ? "warning" : "success"}`}>
                {s.staleCount ? `${s.staleCount} 行资料待重算` : "无失效资料"}
              </span>
            </span>
          </div>
        </div>

        {/* 数据流向：阶段与建议（领域层判定，LLM 不参与） */}
        <div className="det-section">
          <div className="det-label">数据流向</div>
          <div className="dep-item">
            <span className="dep-arrow">→</span>
            <div>
              <div className="dep-text">当前阶段 {s.stage}「{s.stageLabel}」</div>
              <div className="dep-sub">rows/gates/advice 来自 GET stages/{s.stage}</div>
            </div>
          </div>
          <div className="dep-item">
            <span className="dep-arrow">→</span>
            <div>
              <div className="dep-text">
                阶段建议：
                {s.advice ? (
                  <span className={`badge ${ADVICE_BADGE[s.advice]}`}>{s.advice}</span>
                ) : (
                  <span className="badge primary">尚未生成（可发起分析）</span>
                )}
              </div>
              <div className="dep-sub">建议权在 AI，决定权在用户（§4.2 三档）</div>
            </div>
          </div>
        </div>

        {/* 风险与缺口：未通过/未检质量关条目 */}
        <div className="det-section">
          <div className="det-label">风险与缺口</div>
          {s.failedGates.length === 0 ? (
            <div className="risk-item">
              <span className="risk-tag ok">通过</span>
              <span className="risk-title">本阶段质量关无缺口</span>
            </div>
          ) : (
            s.failedGates.map((g) => (
              <div key={g.itemNo} className="risk-item">
                <span className={`risk-tag ${g.result === "不通过" ? "gap" : "inherit"}`}>
                  {g.result}
                </span>
                <span className="risk-title">
                  {g.itemNo} {g.title}
                </span>
                {g.detail && <div className="risk-detail">{g.detail}</div>}
              </div>
            ))
          )}
        </div>

        {/* 质量关快照：真实通过数/总数 + 未过项 */}
        <div className="det-section">
          <div className="det-label">质量关 · 阶段 {s.stage}</div>
          <div className="gate-snap">
            <div className="gate-bar">
              <div className="gate-fill" style={{ width: `${gatePct}%` }} />
            </div>
            <span className="gate-num">
              {s.gatePassed}/{s.gateTotal || 0}
            </span>
          </div>
          <div style={{ marginTop: "var(--s2)" }}>
            {s.failedGates.map((g) => (
              <div key={g.itemNo} className="risk-item">
                <span className="risk-tag gap">{g.result}</span>
                <span className="risk-title">{g.title}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};

/** 联真模式空态：当前阶段尚无真实分析快照（不回 mock） */
const DecisionPanelPending: React.FC = () => (
  <>
    <div className="det-h det-h-fixed">
      <h3>决策支撑</h3>
    </div>
    <div className="det-body">
      <div className="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <div className="empty-state-title">暂无决策数据</div>
        <div className="empty-state-desc">
          对当前阶段发起分析后，这里会显示建议、证据与质量关快照
        </div>
      </div>
    </div>
  </>
);
