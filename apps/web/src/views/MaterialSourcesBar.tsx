import React, { useCallback, useEffect, useState } from "react";
import { api, type ApiProductLine } from "../api";
import { useAsync } from "../hooks/useAsync";
import { useToast } from "../components/Toast";

/**
 * 引用通用资料库（v1.11）
 *
 * v1.10 把它做成了常驻页头的「资料来源」条（专属库 + 引用勾选 + 保存按钮）。
 * 用户定调**不需要这一行常驻信息**：点开「本场景资料」时勾选就行。
 * 因此它从页头搬进本场景资料面板，并去掉「专属库：—（场景内上传落这里）」这类
 * 复述性文案——面板本身已经在说这件事。
 *
 * 口径不变：引用不拷贝，通用库更新即时生效；阶段分析时两路合并。
 */
export const MaterialSourcesBar: React.FC<{
  projectId: string;
  ownLineId?: string;
  onChanged?: () => void;
}> = ({ projectId, ownLineId, onChanged }) => {
  const { showToast } = useToast();
  const sources = useAsync(() => api.materialSources(projectId), [projectId]);
  const allLines = useAsync(() => api.productLines(), []);
  /** 通用库（可被引用）；专属库不进选项 */
  const sharedLines = (allLines.data ?? []).filter((l) => !l.scenario_id);

  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);

  /* 来源加载完成后初始化勾选；项目切换时重置 */
  useEffect(() => {
    setChecked(null);
  }, [projectId]);
  if (sources.status === "ok" && checked === null) {
    setChecked(new Set((sources.data?.linked ?? []).map((l) => l.id)));
  }

  const toggle = (id: string) => {
    setChecked((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = useCallback(async () => {
    if (!checked) return;
    setSaving(true);
    try {
      await api.linkMaterialSources(projectId, [...checked]);
      showToast("引用已更新");
      sources.reload();
      onChanged?.();
    } catch (err: unknown) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [checked, projectId, sources, onChanged, showToast]);

  if (sources.status !== "ok") return null;

  return (
    <div className="material-sources" role="group" aria-label="引用通用资料库">
      <span className="provider-item-meta">引用通用资料库（分析时合并，不复制）：</span>
      {sharedLines.length === 0 ? (
        <span className="provider-item-meta">暂无通用资料库可引用</span>
      ) : (
        <>
          {sharedLines.map((l: ApiProductLine) => (
            <label key={l.id} className="ms-check">
              <input
                type="checkbox"
                checked={checked?.has(l.id) ?? false}
                onChange={() => toggle(l.id)}
                disabled={l.id === ownLineId}
              />
              {l.name}
            </label>
          ))}
          <button className="btn btn-sm" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存引用"}
          </button>
        </>
      )}
    </div>
  );
};
