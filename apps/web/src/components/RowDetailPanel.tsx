import React, { useCallback, useState } from "react";
import { api } from "../api";
import { useToast } from "./Toast";

/**
 * 行详情面板（右栏备注区，变更表 #19「组合拳」）
 *
 * 主表降维后收进来的补充字段（如 M1 曾用名）与溯源四列在这里全量展示：
 * 补充字段与溯源字段可直接编辑（失焦保存，走 PATCH library rows），
 * 业务字段仍留在主表编辑。来源信息一键可达，满足溯源铁律。
 */

export interface RowDetailField {
  key: string;
  label: string;
}

export interface RowDetail {
  /** 表编号（M1-M6 / O1-O6） */
  code: string;
  /** 表名（显示用） */
  tableLabel: string;
  rowId: string;
  /** 行全部字段（字符串化，只读快照） */
  fields: Record<string, string>;
  /** 补充信息字段（从主表收进来，可编辑） */
  editableKeys: RowDetailField[];
  /** 溯源字段（M 表可编辑；O 表只读——此前主表也不展示） */
  traceKeys: RowDetailField[];
  /** 溯源字段是否可编辑（M 表 true） */
  traceEditable: boolean;
  /** 业务字段（主表可编辑，这里只读列出方便对照） */
  businessFields: RowDetailField[];
}

interface RowDetailPanelProps {
  detail: RowDetail;
  onClose: () => void;
}

export const RowDetailPanel: React.FC<RowDetailPanelProps> = ({ detail, onClose }) => {
  const { showToast } = useToast();
  const [fields, setFields] = useState<Record<string, string>>(detail.fields);

  /* 切换行时刷新快照 */
  const [lastId, setLastId] = useState(detail.rowId);
  if (lastId !== detail.rowId) {
    setLastId(detail.rowId);
    setFields(detail.fields);
  }

  const saveField = useCallback(
    async (key: string, value: string) => {
      try {
        await api.patchLibraryRow(detail.code, detail.rowId, key, value);
        showToast("已保存");
      } catch (err: unknown) {
        showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [detail.code, detail.rowId, showToast],
  );

  const renderField = (f: RowDetailField, canEdit: boolean) => (
    <div className="rd-field" key={f.key}>
      <span className="rd-label">{f.label}</span>
      <span
        className={canEdit ? "rd-value ed" : "rd-value"}
        contentEditable={canEdit}
        suppressContentEditableWarning
        title={canEdit ? "点击编辑，失焦保存" : undefined}
        onBlur={(e) => {
          if (!canEdit) return;
          const v = e.currentTarget.textContent ?? "";
          if (v !== fields[f.key]) {
            setFields((prev) => ({ ...prev, [f.key]: v }));
            void saveField(f.key, v);
          }
        }}
      >
        {fields[f.key] ?? ""}
      </span>
    </div>
  );

  return (
    <>
      <div className="det-h">
        <h3>行详情 · {detail.tableLabel}</h3>
        <button className="btn btn-sm" type="button" onClick={onClose} aria-label="关闭详情">
          关闭
        </button>
      </div>
      <div className="det-body row-detail">
        {detail.editableKeys.length > 0 && (
          <div className="rd-group">
            <h4>补充信息（可编辑）</h4>
            {detail.editableKeys.map((f) => renderField(f, true))}
          </div>
        )}
        <div className="rd-group">
          <h4>来源溯源{detail.traceEditable ? "（可编辑）" : ""}</h4>
          {detail.traceKeys.map((f) => renderField(f, detail.traceEditable))}
        </div>
        {detail.businessFields.length > 0 && (
          <div className="rd-group">
            <h4>业务字段（主表可编辑）</h4>
            {detail.businessFields.map((f) => (
              <div className="rd-field" key={f.key}>
                <span className="rd-label">{f.label}</span>
                <span className="rd-value">{fields[f.key]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};
