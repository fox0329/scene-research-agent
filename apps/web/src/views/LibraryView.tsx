import React, { useState } from "react";
import { ProductListPanel } from "./ProductListPanel";
import { RealLibraryView } from "./RealLibraryView";
import type { RowDetail } from "../components/RowDetailPanel";
import type { ApiProductLine } from "../api";
import {
  SpecPanel,
  CapabilityPanel,
  BoundaryPanel,
  QuotePanel,
  OptionalPanel,
} from "./MaterialPanels";

/** Tab 定义 */
interface TabDef {
  key: string;
  label: string;
}

const tabs: TabDef[] = [
  { key: "m1",       label: "产品清单" },
  { key: "m2",       label: "规格书" },
  { key: "m3",       label: "能力清单" },
  { key: "m4",       label: "边界与限制" },
  { key: "m6",       label: "报价" },
  { key: "optional", label: "可选材料" },
];

/**
 * 产品资料库视图
 * - 联真模式（live）：RealLibraryView——产品线切换/5 张核心表 + 可选材料编辑/上传入库 SSE 进度
 * - 演示模式：mock 面板（E2E 依赖），页头徽标提示
 * - 质量总评 / 补充提醒已下线（用户定调 2026-10-21），演示态与联真态页签保持一致
 */
interface LibraryViewProps {
  live: boolean;
  /** 联真模式的产品线快照（App 常驻，编辑/入库后随 refreshProjects 更新，不重建视图） */
  lines?: ApiProductLine[];
  /** 资料变化（新建产品线/入库/编辑）后通知父级刷新计数与行统计 */
  onChanged?: () => void;
  /** 行点击上报右栏行详情（联真，变更表 #19） */
  onRowSelect?: (detail: RowDetail | null) => void;
  /** 当前产品线变化（右栏资料对话按产品线隔离，#305） */
  onActiveLine?: (lineId: string) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  live,
  lines = [],
  onChanged,
  onRowSelect,
  onActiveLine,
}) => {
  const [activeTab, setActiveTab] = useState("m1");

  if (live) {
    return (
      <RealLibraryView
        lines={lines}
        onChanged={onChanged}
        onRowSelect={onRowSelect}
        onActiveLine={onActiveLine}
      />
    );
  }

  const renderPanel = () => {
    switch (activeTab) {
      case "m1":
        return <ProductListPanel />;
      case "m2":
        return <SpecPanel />;
      case "m3":
        return <CapabilityPanel />;
      case "m4":
        return <BoundaryPanel />;
      case "m6":
        return <QuotePanel />;
      case "optional":
        return <OptionalPanel />;
      default:
        return <ProductListPanel />;
    }
  };

  return (
    <>
      {/* 页头 */}
      <div className="pgh">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <div className="pgt">产品资料库</div>
          <span className="badge success">感知与控制产品线</span>
          <button className="btn">切换产品线</button>
        </div>
        <div className="pga">
          <button className="btn">上传材料</button>
          <button className="btn primary">开始解析</button>
        </div>
      </div>

      {/* Tab 栏 */}
      <div className="stabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`stab${activeTab === tab.key ? " active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 工作区 */}
      <div className="ws">
        {renderPanel()}
      </div>
    </>
  );
};