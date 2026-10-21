import React from "react";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { products, type ProductItem } from "../mock/library-data";

/* ── 状态 → Badge ── */
function StatusBadge({ status }: { status: ProductItem["status"] }) {
  const cls =
    status === "在售" ? "success" :
    status === "在研" ? "primary" :
    "warning"; // 停售
  return <span className={`badge ${cls}`}>{status}</span>;
}

/* ── 来源 → 颜色标签 ── */
function SourceTag({ source }: { source: ProductItem["source"] }) {
  const cls =
    source === "AI"   ? "ai" :
    source === "用户" ? "user" :
    "infer"; // 推断
  return <span className={`stag ${cls}`}>{source}</span>;
}

/* ── M1 产品清单列定义（v2.11 只保留 型号/名称/状态/来源） ── */
const productColumns: ColumnDef<ProductItem>[] = [
  { key: "model",      label: "型号",     editable: true },
  { key: "name",       label: "产品名",   editable: true },
  {
    key: "status",
    label: "状态",
    render: (value) => <StatusBadge status={value as ProductItem["status"]} />,
  },
  {
    key: "source",
    label: "来源",
    render: (value) => <SourceTag source={value as ProductItem["source"]} />,
  },
];

/**
 * M1 产品清单面板
 * - 可编辑表格：型号/产品名/状态/来源标记
 * - 状态列用 Badge（在售=绿、停售=灰、在研=蓝）
 * - 来源标记用颜色标签（AI=蓝、用户=绿、推断=黄）
 * - 添加产品按钮
 */
export const ProductListPanel: React.FC = () => {
  const [data, setData] = React.useState(products);

  const handleCellChange = (rowIndex: number, key: string, value: string) => {
    setData((prev) =>
      prev.map((row, i) =>
        i === rowIndex ? { ...row, [key]: value } : row,
      ),
    );
  };

  const handleAdd = () => {
    const newItem: ProductItem = {
      id: `p${data.length + 1}`,
      model: "",
      name: "",
      status: "在研",
      source: "AI",
    };
    setData((prev) => [...prev, newItem]);
  };

  return (
    <div className="pnl">
      <div className="pnl-h">
        <div>
          <h2>M1 产品清单</h2>
          <p>把所有产品列出来，建立候选池</p>
        </div>
        <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
          <span className="badge primary">{data.length} 型号</span>
          <button className="btn" onClick={handleAdd}>添加</button>
        </div>
      </div>
      <div className="pnl-b flush">
        <SceneTable
          columns={productColumns}
          data={data}
          onCellChange={handleCellChange}
        />
      </div>
    </div>
  );
};