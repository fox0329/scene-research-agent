import React, { useState } from "react";
import { QualityPanel } from "./QualityPanel";
import { ProductListPanel } from "./ProductListPanel";
import { RealLibraryView } from "./RealLibraryView";
import type { RowDetail } from "../components/RowDetailPanel";
import type { ApiProductLine } from "../api";
import {
  SpecPanel,
  CapabilityPanel,
  BoundaryPanel,
  LimitPanel,
  RatePanel,
  OptionalPanel,
} from "./MaterialPanels";

/** Tab 定义 */
interface TabDef {
  key: string;
  label: string;
}

const tabs: TabDef[] = [
  { key: "quality",  label: "质量总评" },
  { key: "m1",       label: "M1 产品清单" },
  { key: "m2",       label: "M2 规格书" },
  { key: "m3",       label: "M3 能力清单" },
  { key: "m4",       label: "M4 边界声明" },
  { key: "m5",       label: "M5 已知限制" },
  { key: "m6",       label: "M6 内部费率" },
  { key: "optional", label: "O 可选材料" },
  { key: "reminder", label: "补充提醒" },
];

/**
 * 产品资料库视图
 * - 联真模式（live）：RealLibraryView——产品线切换/六维质量/12 表编辑/上传入库 SSE 进度
 * - 演示模式：mock 面板（E2E 依赖），页头徽标提示
 */
interface LibraryViewProps {
  live: boolean;
  /** 联真模式的产品线快照（App 常驻，编辑/入库后随 refreshProjects 更新，不重建视图） */
  lines?: ApiProductLine[];
  /** 资料变化（新建产品线/入库/编辑）后通知父级刷新计数与行统计 */
  onChanged?: () => void;
  /** 行点击上报右栏行详情（联真，变更表 #19） */
  onRowSelect?: (detail: RowDetail | null) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  live,
  lines = [],
  onChanged,
  onRowSelect,
}) => {
  const [activeTab, setActiveTab] = useState("quality");

  if (live) {
    return (
      <RealLibraryView lines={lines} onChanged={onChanged} onRowSelect={onRowSelect} />
    );
  }

  const renderPanel = () => {
    switch (activeTab) {
      case "quality":
        return <QualityPanel />;
      case "m1":
        return <ProductListPanel />;
      case "m2":
        return <SpecPanel />;
      case "m3":
        return <CapabilityPanel />;
      case "m4":
        return <BoundaryPanel />;
      case "m5":
        return <LimitPanel />;
      case "m6":
        return <RatePanel />;
      case "optional":
        return <OptionalPanel />;
      case "reminder":
        return <QualityPanel />;
      default:
        return <QualityPanel />;
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