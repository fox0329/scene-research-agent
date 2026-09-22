import React from "react";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { specs, capabilities, limits, rates, cases, type SpecItem, type CapabilityItem, type LimitItem, type RateItem, type CaseItem } from "../mock/library-data";

/* ── M2 规格书 ── */
const specColumns: ColumnDef<SpecItem>[] = [
  { key: "category", label: "参数类" },
  { key: "param",    label: "参数项", editable: true },
  { key: "value",    label: "值",     editable: true },
  { key: "citation", label: "出处" },
  {
    key: "verified",
    label: "实测/宣称",
    render: (value) => {
      const v = value as SpecItem["verified"];
      return (
        <span className={`badge ${v === "实测" ? "success" : "warning"}`}>
          {v}
        </span>
      );
    },
  },
];

export const SpecPanel: React.FC = () => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>M2 规格书</h2>
        <p>每型号一张，参数类按产品类型生成</p>
      </div>
      <span className="badge primary">4 参数类</span>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={specColumns} data={specs as unknown as Record<string, unknown>[]} />
    </div>
  </div>
);

/* ── M3 能力清单 ── */
const capColumns: ColumnDef<CapabilityItem>[] = [
  { key: "name",        label: "能力项",     editable: true },
  { key: "description", label: "一句话描述", editable: true },
  {
    key: "maturity",
    label: "成熟度",
    render: (value) => {
      const m = value as CapabilityItem["maturity"];
      const cls = m === "已交付" ? "success" : m === "组件具备" ? "primary" : "warning";
      return <span className={`badge ${cls}`}>{m}</span>;
    },
  },
  { key: "dependency", label: "依赖条件", editable: true },
  {
    key: "source",
    label: "来源",
    render: (value) => {
      const s = value as CapabilityItem["source"];
      const cls = s === "AI" ? "ai" : s === "用户" ? "user" : "infer";
      return <span className={`stag ${cls}`}>{s}</span>;
    },
  },
];

export const CapabilityPanel: React.FC = () => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>M3 能力清单</h2>
        <p>产品线能做什么、做到什么程度</p>
      </div>
      <span className="badge primary">18 项 · 已交付 9</span>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={capColumns} data={capabilities as unknown as Record<string, unknown>[]} />
    </div>
  </div>
);

/* ── M4 边界声明（空态） ── */
export const BoundaryPanel: React.FC = () => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>M4 能力边界声明</h2>
        <p>说清楚不做什么，避免承诺超出能力</p>
      </div>
      <button className="btn">添加边界</button>
    </div>
    <div className="pnl-b">
      <div className="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div className="empty-state-title">边界声明为空</div>
        <div className="empty-state-desc">
          材料中未找到"不做什么"的声明，可由 AI 基于材料推断（标注"待确认"）
        </div>
        <button className="btn primary">AI 推断边界</button>
      </div>
    </div>
  </div>
);

/* ── M5 已知限制 ── */
const limitColumns: ColumnDef<LimitItem>[] = [
  { key: "product",    label: "产品/能力", editable: true },
  { key: "limit",      label: "已知限制",  editable: true },
  {
    key: "severity",
    label: "影响程度",
    render: (value) => {
      const s = value as LimitItem["severity"];
      const cls = s === "高" ? "error" : s === "中" ? "warning" : "success";
      return <span className={`badge ${cls}`}>{s}</span>;
    },
  },
  { key: "fixStatus",  label: "修复状态",  editable: true },
  {
    key: "disclosure",
    label: "对外可否提及",
    render: (value) => {
      const d = value as LimitItem["disclosure"];
      return (
        <span className={`badge ${d === "内部可提" ? "primary" : "error"}`}>
          {d}
        </span>
      );
    },
  },
  {
    key: "source",
    label: "来源",
    render: (value) => {
      const s = value as LimitItem["source"];
      const cls = s === "AI" ? "ai" : s === "用户" ? "user" : "infer";
      return <span className={`stag ${cls}`}>{s}</span>;
    },
  },
];

export const LimitPanel: React.FC = () => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>M5 已知限制清单</h2>
        <p>列出已知缺陷，避免验收时踩坑</p>
      </div>
      <span className="badge primary">{limits.length} 条</span>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={limitColumns} data={limits as unknown as Record<string, unknown>[]} />
    </div>
  </div>
);

/* ── M6 内部费率 ── */
const rateColumns: ColumnDef<RateItem>[] = [
  { key: "category",  label: "类别" },
  { key: "item",      label: "项目",     editable: true },
  { key: "unitPrice", label: "单价",     editable: true },
  { key: "refHours",  label: "标准工时参考", editable: true },
  {
    key: "source",
    label: "数据来源",
    render: (value) => {
      const s = value as string;
      const cls = s === "历史项目" ? "user" : "infer";
      return <span className={`stag ${cls}`}>{s}</span>;
    },
  },
];

export const RatePanel: React.FC = () => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>M6 内部费率基准</h2>
        <p>公司侧投入单价，场景成本在阶段 5 算</p>
      </div>
      <span className="badge primary">{rates.length} 项</span>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={rateColumns} data={rates as unknown as Record<string, unknown>[]} />
    </div>
  </div>
);

/* ── O 可选材料：已交付案例 ── */
const caseColumns: ColumnDef<CaseItem>[] = [
  { key: "name",   label: "案例名",     editable: true },
  { key: "client", label: "客户（脱敏）", editable: true },
  { key: "scene",  label: "场景",       editable: true },
  { key: "date",   label: "交付时间",   editable: true },
  { key: "result", label: "验收指标与结果", editable: true },
  {
    key: "evidenceLevel",
    label: "证据级",
    render: (value) => {
      const e = value as CaseItem["evidenceLevel"];
      return <span className={`badge ${e === "A" ? "success" : e === "B" ? "primary" : "warning"}`}>{e}</span>;
    },
  },
];

export const OptionalPanel: React.FC = () => (
  <>
    <div className="pnl">
      <div className="pnl-h">
        <div>
          <h2>O2 已交付案例</h2>
          <p>整理过往案例，验证真实交付能力</p>
        </div>
        <span className="badge primary">{cases.length} 案例</span>
      </div>
      <div className="pnl-b flush">
        <SceneTable columns={caseColumns} data={cases as unknown as Record<string, unknown>[]} />
      </div>
    </div>
    <div className="bnr warning" style={{ margin: "var(--s3) 0 0" }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span>O1 认证 / O3 价格 / O4 SDK / O5 路线图 / O6 生态 共 5 项待补充</span>
    </div>
  </>
);