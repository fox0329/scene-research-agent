import React from "react";
import { SceneTable, type ColumnDef } from "../../components/SceneTable";
import { AdviceCard } from "../../components/AdviceCard";
import {
  sceneElements,
  type Competition,
  type Project,
  type SceneElement,
  type SourceTag,
} from "../../mock/project-data";
import { stage2Advice, gate1FullItems } from "../../mock/stage-data";

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

/* ═══ 引用产品资料库横幅 ═══ */

const LibraryBanner: React.FC<{ productLine: string }> = ({ productLine }) => (
  <div className="bnr warning">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span>引用产品资料库：{productLine} · M1-M6 已同步</span>
  </div>
);

/* ═══ 列定义 ═══ */

const elementColumns: ColumnDef<SceneElement>[] = [
  { key: "index", label: "#" },
  { key: "name", label: "要素名称", editable: true },
  {
    key: "type",
    label: "类型",
    render: (value) => <span className="badge primary">{value as string}</span>,
  },
  { key: "func", label: "功能", editable: true },
  { key: "params", label: "关键参数", editable: true },
  { key: "vendor", label: "供应商", editable: true },
  {
    key: "competition",
    label: "竞争",
    render: (value) => {
      const c = value as Competition;
      const cls = c === "高" ? "error" : c === "中" ? "warning" : "success";
      return <span className={`badge ${cls}`}>{c}</span>;
    },
  },
  {
    key: "source",
    label: "来源",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

/* ═══ 阶段 2 面板 ═══ */

interface Stage2PanelProps {
  project: Project;
  onNext?: () => void;
  onSupplement?: () => void;
  onStop?: () => void;
}

/**
 * 阶段 2：认识场景
 * - 引用横幅（引用产品资料库）
 * - 场景要素清单表（表 2-2：12 项要素）
 * - 质量关 1（9 项检查清单）
 * - 建议卡（"建议通过"）
 */
export const Stage2Panel: React.FC<Stage2PanelProps> = ({
  project,
  onNext,
  onSupplement,
  onStop,
}) => {
  const passedCount = gate1FullItems.filter((i) => i.pass).length;

  return (
    <>
      <LibraryBanner productLine={project.productLine} />

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>场景要素清单</h2>
            <p>关键要素：硬件、软件、服务</p>
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
            <span className="badge primary">{sceneElements.length} 项</span>
            <button className="btn" type="button">添加</button>
          </div>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={elementColumns} data={sceneElements} />
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量关 1 · 认识场景</h2>
            <p>9 项检查</p>
          </div>
          <span className={`badge ${passedCount === gate1FullItems.length ? "success" : "warning"}`}>
            {passedCount}/{gate1FullItems.length} 通过
          </span>
        </div>
        <div className="pnl-b">
          <ul className="cl">
            {gate1FullItems.map((item) => (
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
        level={stage2Advice.level}
        reason={stage2Advice.reason}
        risks={stage2Advice.risks}
        conditions={stage2Advice.conditions}
        satisfied={stage2Advice.satisfied}
        total={stage2Advice.total}
        onNext={onNext}
        onSupplement={onSupplement}
        onStop={onStop}
      />
    </>
  );
};