import React from "react";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import {
  specs,
  capabilities,
  boundaryRows,
  quotes,
  cases,
  type SpecItem,
  type CapabilityItem,
  type BoundaryItem,
  type QuoteItem,
  type CaseItem,
} from "../mock/library-data";

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
        <h2>规格书</h2>
        <p>每型号一张，参数类按产品类型生成</p>
      </div>
      <span className="badge primary">4 参数类</span>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={specColumns} data={specs} />
    </div>
  </div>
);

/* ── M3 能力清单 ── */
const capColumns: ColumnDef<CapabilityItem>[] = [
  { key: "domain",      label: "领域",       editable: true },
  { key: "name",        label: "能力项",     editable: true },
  {
    key: "description",
    label: "一句话描述（含依赖条件）",
    editable: true,
  },
  {
    key: "maturity",
    label: "成熟度",
    render: (value) => {
      const m = value as CapabilityItem["maturity"];
      const cls = m === "已交付" ? "success" : m === "组件具备" ? "primary" : "warning";
      return <span className={`badge ${cls}`}>{m}</span>;
    },
  },
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
        <h2>能力清单</h2>
        <p>产品线能做什么、做到什么程度；依赖条件写进描述</p>
      </div>
      <span className="badge primary">18 项 · 已交付 9</span>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={capColumns} data={capabilities} />
    </div>
  </div>
);

/* ── M4 边界与限制（合并展示：类型 = 不做 / 限制） ── */
const boundaryColumns: ColumnDef<BoundaryItem>[] = [
  { key: "description", label: "说明",             editable: true },
  { key: "reason",      label: "依据",             editable: true },
  {
    key: "impact",
    label: "影响程度",
    render: (value) => {
      const s = value as BoundaryItem["impact"];
      if (s === "—") return "—";
      const cls = s === "高" ? "error" : s === "中" ? "warning" : "success";
      return <span className={`badge ${cls}`}>{s}</span>;
    },
  },
  { key: "response", label: "客户要求时怎么办", editable: true },
];

export const BoundaryPanel: React.FC = () => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>边界与限制</h2>
        <p>一张表看清「不做」与「已知限制」；底层仍按两张表存，读取时合并</p>
      </div>
      <span className="badge primary">{boundaryRows.length} 条</span>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={boundaryColumns} data={boundaryRows} />
    </div>
  </div>
);

/* ── 报价（示例数据） ── */
const quoteColumns: ColumnDef<QuoteItem>[] = [
  { key: "model",       label: "型号",   editable: true },
  { key: "config",      label: "配置构成",  editable: true },
  { key: "unit_price",  label: "含税单价（元）", editable: true },
];

export const QuotePanel: React.FC = () => (
  <div className="pnl">
    <div className="pnl-h">
      <div>
        <h2>报价</h2>
        <p>一行一个报价口径；报价用于成本测算与赢面判断，不许自己编价格</p>
      </div>
      <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
        <span className="badge warning">示例数据</span>
        <span className="badge primary">{quotes.length} 个口径</span>
      </div>
    </div>
    <div className="pnl-b flush">
      <SceneTable columns={quoteColumns} data={quotes} />
    </div>
  </div>
);

/* ── 可选材料：已交付案例 ── */
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
          <h2>已交付案例</h2>
          <p>整理过往案例，验证真实交付能力</p>
        </div>
        <span className="badge primary">{cases.length} 案例</span>
      </div>
      <div className="pnl-b flush">
        <SceneTable columns={caseColumns} data={cases} />
      </div>
    </div>
    <div className="bnr warning" style={{ margin: "var(--s3) 0 0" }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span>认证 / SDK / 路线图 / 生态 共 4 项待补充</span>
    </div>
  </>
);
