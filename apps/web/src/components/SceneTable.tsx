import React, { useCallback } from "react";

export interface ColumnDef<T> {
  key: keyof T & string;
  label: string;
  editable?: boolean;
  /** 自定义渲染，如 Badge / 来源标签。value 使用 unknown，调用方自行 narrow */
  render?: (value: unknown, row: T) => React.ReactNode;
}

interface SceneTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  onCellChange?: (rowIndex: number, key: string, value: string) => void;
}

/**
 * 通用场景表格组件
 * 支持：逐单元格编辑（contenteditable）、来源标记自动渲染为颜色标签、状态列自动渲染为 Badge
 */
export function SceneTable<T extends Record<string, unknown>>({
  columns,
  data,
  onCellChange,
}: SceneTableProps<T>) {
  const handleBlur = useCallback(
    (rowIndex: number, key: string, el: HTMLElement) => {
      const newValue = el.textContent ?? "";
      if (onCellChange) {
        onCellChange(rowIndex, key, newValue);
      }
    },
    [onCellChange],
  );

  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, ri) => (
            <tr key={ri}>
              {columns.map((col) => {
                const value = row[col.key];

                // 自定义渲染（Badge / 来源标签等）
                if (col.render) {
                  return (
                    <td key={col.key}>{col.render(value, row)}</td>
                  );
                }

                // 可编辑单元格
                if (col.editable) {
                  return (
                    <td
                      key={col.key}
                      className="ed"
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) =>
                        handleBlur(ri, col.key, e.currentTarget)
                      }
                    >
                      {String(value ?? "")}
                    </td>
                  );
                }

                // 只读文本
                return (
                  <td key={col.key} style={{ fontSize: "var(--t2x)", color: "var(--ct2)" }}>
                    {String(value ?? "")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}