import React, { useCallback, useEffect, useState } from "react";
import { api, type ApiProductLine } from "../api";
import { useAsync } from "../hooks/useAsync";
import { useToast } from "../components/Toast";

/**
 * 引用通用资料库（v2.9）
 *
 * 口径（用户定调）：**默认直接引用基础产品资料**——新建场景不做任何操作，通用库就是
 * 勾选态；取消勾选 = 不引用（该库不参与本场景分析）。因此**没有「保存引用」这个来回**：
 * 勾/取消即生效，勾选状态本身就是引用关系。
 *
 * 位置：从页头常驻条搬进「本场景资料」面板（用户定调：资料来源行删除，点这里勾选就行）。
 */
export const MaterialSourcesBar: React.FC<{
  projectId: string;
  /** 本场景专属库 id（它不在可引用集合里，挖掉以防误畫） */
  ownLineId?: string;
  onChanged?: () => void;
}> = ({ projectId, ownLineId, onChanged }) => {
  const { showToast } = useToast();
  const sources = useAsync(() => api.materialSources(projectId), [projectId]);
  const allLines = useAsync(() => api.productLines(), []);
  /** 通用库（默认全部引用；专属库不进选项） */
  const sharedLines = (allLines.data ?? []).filter((l) => !l.scenario_id && l.id !== ownLineId);

  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);

  /* 来源加载完成后初始化勾选；项目切换时重置 */
  useEffect(() => {
    setChecked(null);
  }, [projectId]);
  if (sources.status === "ok" && checked === null) {
    setChecked(new Set((sources.data?.linked ?? []).map((l) => l.id)));
  }

  /**
   * 勾/取消即生效：把**当前勾选集合**整份 PUT 上去（服务端落的是补集 = 被取消的库）。
   * 失败时回滚本地勾选，避免界面显示的状态和实际引用不一致。
   */
  const toggle = useCallback(
    async (id: string) => {
      if (!checked || saving) return;
      const next = new Set(checked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setChecked(next);
      setSaving(true);
      try {
        await api.linkMaterialSources(projectId, [...next]);
        onChanged?.();
      } catch (err: unknown) {
        setChecked(checked);
        showToast(`引用更新失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [checked, saving, projectId, onChanged, showToast],
  );

  if (sources.status !== "ok") return null;

  return (
    <div className="material-sources" role="group" aria-label="引用通用资料库">
      <span className="provider-item-meta">引用通用资料库（默认全引用，取消勾选即不参与分析）：</span>
      {sharedLines.length === 0 ? (
        <span className="provider-item-meta">暂无通用资料库可引用</span>
      ) : (
        sharedLines.map((l: ApiProductLine) => (
          <label key={l.id} className="ms-check">
            <input
              type="checkbox"
              checked={checked?.has(l.id) ?? false}
              disabled={saving}
              onChange={() => void toggle(l.id)}
            />
            {l.name}
          </label>
        ))
      )}
    </div>
  );
};
