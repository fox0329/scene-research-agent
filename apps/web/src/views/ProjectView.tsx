import React, { useState } from "react";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import {
  STAGES,
  barriers,
  gate0,
  gate1,
  sceneDefinition,
  sceneElements,
  stage0Checks,
  stage0Overrides,
  type BarrierItem,
  type CheckRating,
  type Competition,
  type Project,
  type QualityGate,
  type SceneDefinitionRow,
  type SceneElement,
  type SourceTag,
  type Stage0Check,
  type Stage0Override,
  type StageDef,
} from "../mock/project-data";

interface ProjectViewProps {
  project: Project;
}

/* ═══ 通用小部件 ═══ */

/** 评级徽标：✅ pass / ⚠️ warn / ❌ fail */
function StatusBadge({ rating, label }: { rating: CheckRating; label: string }) {
  const cls = rating === "pass" ? "success" : rating === "warn" ? "warning" : "error";
  const sym = rating === "pass" ? "\u2705" : rating === "warn" ? "\u26a0\ufe0f" : "\u274c";
  return (
    <span className={`badge ${cls}`}>
      {sym} {label}
    </span>
  );
}

/** 来源标记标签 */
function StagBadge({ source }: { source: SourceTag }) {
  const cls = source === "AI" ? "ai" : source === "用户" ? "user" : "infer";
  return <span className={`stag ${cls}`}>{source}</span>;
}

/** 引用产品资料库横幅 */
const LibraryBanner: React.FC<{ productLine: string }> = ({ productLine }) => (
  <div className="bnr warning">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span>引用产品资料库：{productLine} · M1-M6 已同步 · 资料更新自动带入</span>
  </div>
);

/** 质量关检查列表面板（阶段 1/2 复用） */
function QualityGatePanel({ gate }: { gate: QualityGate }) {
  return (
    <div className="pnl">
      <div className="pnl-h">
        <div>
          <h2>{gate.title}</h2>
          <p>{gate.subtitle}</p>
        </div>
        <span className={`badge ${gate.passed === gate.total ? "success" : "warning"}`}>
          {gate.passed}/{gate.total} 通过
        </span>
      </div>
      <div className="pnl-b">
        <ul className="cl">
          {gate.items.map((item) => (
            <li key={item.title} className="cli">
              {item.pass ? (
                <svg className="ci pass" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              ) : (
                <svg className="ci fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              )}
              <div>
                <div className="ct">{item.title}</div>
                <div className="cd">{item.desc}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ═══ 阶段 0：材料入库 ═══ */

const stage0CheckColumns: ColumnDef<Stage0Check>[] = [
  { key: "index", label: "#" },
  { key: "item", label: "检查项" },
  {
    key: "statusLabel",
    label: "状态",
    render: (value, row) => <StatusBadge rating={row.rating} label={value as string} />,
  },
  { key: "risk", label: "缺失风险（后续阶段继承）" },
];

const stage0OverrideColumns: ColumnDef<Stage0Override>[] = [
  { key: "item", label: "覆盖项", editable: true },
  { key: "libraryValue", label: "资料库值" },
  { key: "sceneValue", label: "场景值", editable: true },
  { key: "reason", label: "原因", editable: true },
  {
    key: "source",
    label: "来源标记",
    render: (value) => <StagBadge source={value as SourceTag} />,
  },
];

const Stage0Panel: React.FC<{ project: Project }> = ({ project }) => {
  const passCount = stage0Checks.filter((c) => c.rating === "pass").length;
  return (
    <>
      <LibraryBanner productLine={project.productLine} />
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>完成度检查</h2>
            <p>不阻断，仅记录缺失风险（对应 00b §2.4）</p>
          </div>
          <span className="badge warning">
            {passCount}/{stage0Checks.length} 通过
          </span>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={stage0CheckColumns} data={stage0Checks} />
        </div>
      </div>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>场景级覆盖</h2>
            <p>本场景对资料库的补充与覆盖（不影响资料库本身）</p>
          </div>
          <button className="btn">添加覆盖</button>
        </div>
        <div className="pnl-b flush">
          <SceneTable columns={stage0OverrideColumns} data={stage0Overrides} />
        </div>
      </div>
    </>
  );
};

/* ═══ 阶段 1：门槛筛查 ═══ */

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

const Stage1Panel: React.FC = () => (
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
    <QualityGatePanel gate={gate0} />
  </>
);

/* ═══ 阶段 2：认识场景 ═══ */

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

const Stage2Panel: React.FC<{ project: Project }> = ({ project }) => (
  <>
    <LibraryBanner productLine={project.productLine} />
    <div className="pnl">
      <div className="pnl-h">
        <div>
          <h2>场景要素清单</h2>
          <p>关键要素：硬件、软件、服务</p>
        </div>
        <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
          <span className="badge primary">12 项</span>
          <button className="btn">添加</button>
        </div>
      </div>
      <div className="pnl-b flush">
        <SceneTable columns={elementColumns} data={sceneElements} />
      </div>
    </div>
    <QualityGatePanel gate={gate1} />
  </>
);

/* ═══ 阶段 3-8：占位 ═══ */

const StagePlaceholder: React.FC<{ stage: StageDef }> = ({ stage }) => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>
          阶段 {stage.index} · {stage.label}
        </h2>
        <p>本阶段面板将在后续任务实现</p>
      </div>
    </div>
    <div className="pnl-b">
      <div className="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <div className="empty-state-title">待实现</div>
        <div className="empty-state-desc">
          阶段 {stage.index}「{stage.label}」的内容面板属于后续任务范围
        </div>
      </div>
    </div>
  </div>
);

/* ═══ 视图主体 ═══ */

/**
 * 项目工作台视图
 * 页头（48px）+ 9 阶段 Tab（完成态绿点、当前高亮）+ 阶段面板（0-2 实现，3-8 占位）
 */
export const ProjectView: React.FC<ProjectViewProps> = ({ project }) => {
  const [activeStage, setActiveStage] = useState(project.stage);

  const isProjectDone = project.status === "done";
  const badgeText = isProjectDone
    ? "已完成 · 交付物"
    : `阶段 ${project.stage} ${STAGES[project.stage].label}`;
  const badgeCls = isProjectDone ? "success" : "primary";

  const renderStagePanel = () => {
    switch (activeStage) {
      case 0:
        return <Stage0Panel project={project} />;
      case 1:
        return <Stage1Panel />;
      case 2:
        return <Stage2Panel project={project} />;
      default:
        return <StagePlaceholder stage={STAGES[activeStage]} />;
    }
  };

  return (
    <>
      {/* 页头：项目名 + 阶段徽标（单行 48px） */}
      <div className="pgh pgh-fixed">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <div className="pgt">{project.name}</div>
          <span className={`badge ${badgeCls}`}>{badgeText}</span>
        </div>
        <div className="pga">
          <button className="btn">上传材料</button>
          <button className="btn primary">完成阶段</button>
        </div>
      </div>

      {/* 阶段 Tab：完成态显示绿点，当前激活高亮 */}
      <div className="stabs" role="tablist" aria-label="分析阶段">
        {STAGES.map((stage) => {
          const isDone = stage.index < project.stage;
          const isActive = activeStage === stage.index;
          return (
            <button
              key={stage.index}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`stab${isActive ? " active" : ""}${isDone ? " done" : ""}`}
              onClick={() => setActiveStage(stage.index)}
            >
              <span className="sd" />
              {stage.label}
            </button>
          );
        })}
      </div>

      {/* 阶段面板 */}
      <div className="ws">{renderStagePanel()}</div>
    </>
  );
};
