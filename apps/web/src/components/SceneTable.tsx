import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
  /** 列宽本地留存键（如表编号）：刷新后列宽保留；缺省不持久化 */
  storageKey?: string;
  /** 点击行（含单元格）时上报：右栏详情联动用 */
  onRowClick?: (rowIndex: number) => void;
}

/** 拖拽列宽下限（px）：再窄内容与标题都不可读 */
const MIN_COL_WIDTH = 64;
/** 量不到自然宽时的兜底列宽（px） */
const FALLBACK_COL_WIDTH = 120;

/** 列宽 px（各自独立：拖一列只动这一列，其余列纹丝不动） */
type Widths = Record<string, number>;

/** 每列的自然宽（单行内容宽，px） */
interface NaturalWidth {
  key: string;
  px: number;
}

/**
 * 把各列自然宽适配到容器宽（仅默认态用），目标是整体高度最紧凑：
 * - 宽裕（自然宽总和 ≤ 容器）：自然宽 + 剩余按自然宽比例分——所有内容保持单行
 * - 不足：按自然宽的平方根分配——最小化各列换行行数之和（w ∝ √内容宽）
 */
function fitWidths(naturals: NaturalWidth[], container: number): number[] {
  const sum = naturals.reduce((a, n) => a + n.px, 0);
  if (naturals.length === 0) return [];
  if (sum <= container || sum <= 0) {
    const extra = container - sum;
    return naturals.map((n) => n.px + (sum > 0 ? (extra * n.px) / sum : extra / naturals.length));
  }
  const rootSum = naturals.reduce((a, n) => a + Math.sqrt(n.px), 0);
  // 每列不低于半个拖拽下限，防止极端窄容器压没
  return naturals.map((n) =>
    Math.max((container * Math.sqrt(n.px)) / rootSum, MIN_COL_WIDTH / 2),
  );
}

/**
 * 读留存列宽（px，绝对值）。键集与当前列不一致或垃圾值返回 null
 * （调用方按内容重新量宽）。v2 存储口径：px 绝对值、拖一列只动一列；
 * 与旧百分比口径不共用键名，避免误读。
 */
function loadWidths(storageKey: string | undefined, colKeys: string[]): Widths | null {
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(`scene.colwidths.v2.${storageKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return null;
    const out: Widths = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && v >= MIN_COL_WIDTH) out[k] = Math.round(v);
    }
    if (Object.keys(out).length === 0) return null;
    const storedKeys = Object.keys(out).sort().join(",");
    if (storedKeys !== [...colKeys].sort().join(",")) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * 通用场景表格组件
 * 支持：逐单元格编辑（contenteditable）、来源/状态自定义渲染、
 *       列分割线、表头右缘热区拖拽调列宽。
 *
 * 列宽策略（用户定稿）：
 * - 默认态：按各列实际内容的自然宽适配容器宽（整体高度最紧凑），
 *   表宽 = 中栏内容宽；中栏拖宽时自动重新适配
 * - 手动拖拽后：各列绝对像素宽、各自独立——拖一列只动这一列；
 *   表宽 = 各列之和，超出容器时 .tw 横向滚动（内容始终可见）
 * - 宽度按 storageKey 本地留存
 */
export function SceneTable<T extends Record<string, unknown>>({
  columns,
  data,
  onCellChange,
  storageKey,
  onRowClick,
}: SceneTableProps<T>) {
  const colKeys = columns.map((c) => c.key);
  const colKeysSig = colKeys.join(",");
  const [widths, setWidths] = useState<Widths | null>(() => loadWidths(storageKey, colKeys));
  const [isResizing, setIsResizing] = useState(false);
  /** 选中行（右栏详情联动高亮） */
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 各列自然宽缓存 */
  const naturalsRef = useRef<NaturalWidth[]>([]);
  /** 用户手动拖过（或读到留存值）后不再自动重排 */
  const manualRef = useRef(widths !== null);
  /** 拖拽基线：起点 X、冻结的全表像素宽 */
  const dragRef = useRef<{ key: string; startX: number; startPx: number; base: Widths } | null>(null);

  /* 测量阶段（无留存宽度）：整表单行自然宽渲染，量完立即适配容器（绘制前完成，无闪烁） */
  const measuring = widths === null;

  /** 默认态：按内容自然宽适配到当前容器宽 */
  const fitToContainer = useCallback(() => {
    const naturals = naturalsRef.current;
    const container = wrapRef.current?.clientWidth ?? 0;
    if (naturals.length === 0 || container <= 0) return;
    const fitted = fitWidths(naturals, container);
    const next: Widths = {};
    naturals.forEach((n, i) => {
      next[n.key] = Math.round(fitted[i] ?? FALLBACK_COL_WIDTH);
    });
    setWidths(next);
  }, []);

  useLayoutEffect(() => {
    if (!measuring) return;
    const ths = tableRef.current?.querySelectorAll("th");
    const naturals: NaturalWidth[] = [];
    ths?.forEach((th) => {
      const key = th.dataset.colKey;
      if (key) naturals.push({ key, px: th.getBoundingClientRect().width });
    });
    if (naturals.length === 0) return;
    naturalsRef.current = naturals;
    manualRef.current = false;
    fitToContainer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, colKeysSig]);

  /* 中栏（壳层）拖宽 → 未手动调过列宽时按内容重新适配 */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || measuring) return;
    const ro = new ResizeObserver(() => {
      if (!manualRef.current) fitToContainer();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measuring, fitToContainer]);

  useEffect(() => {
    if (!storageKey || widths === null) return;
    try {
      window.localStorage.setItem(`scene.colwidths.v2.${storageKey}`, JSON.stringify(widths));
    } catch {
      /* 本地存储不可用时仅本次会话生效 */
    }
  }, [widths, storageKey]);

  const handleBlur = useCallback(
    (rowIndex: number, key: string, el: HTMLElement) => {
      const newValue = el.textContent ?? "";
      if (onCellChange) {
        onCellChange(rowIndex, key, newValue);
      }
    },
    [onCellChange],
  );

  /** 开始拖某列：只改这一列的像素宽，其余列纹丝不动 */
  const startResize = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault();
      const base = { ...(widths ?? {}) };
      const startPx = base[key] ?? FALLBACK_COL_WIDTH;
      dragRef.current = { key, startX: e.clientX, startPx, base };
      setIsResizing(true);
      manualRef.current = true;

      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const next = Math.max(MIN_COL_WIDTH, drag.startPx + (ev.clientX - drag.startX));
        setWidths({ ...drag.base, [drag.key]: next });
      };
      const onUp = () => {
        dragRef.current = null;
        setIsResizing(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [widths],
  );

  /* 表宽 = 各列之和（绝对像素）：列各自独立，浏览器不做二次分配 */
  const totalWidth = colKeys.reduce((sum, key) => sum + (widths?.[key] ?? FALLBACK_COL_WIDTH), 0);

  return (
    <div className={`tw${isResizing ? " is-resizing" : ""}`} ref={wrapRef}>
      <table
        ref={tableRef}
        className={measuring ? "measure" : undefined}
        style={measuring ? undefined : { tableLayout: "fixed", width: `${totalWidth}px` }}
      >
        {!measuring && (
          <colgroup>
            {columns.map((col) => (
              <col key={col.key} style={{ width: widths?.[col.key] ?? FALLBACK_COL_WIDTH }} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {columns.map((col, ci) => (
              <th key={col.key} data-col-key={col.key}>
                {col.label}
                {ci < columns.length - 1 ? (
                  <span
                    className="th-resize"
                    title="拖拽调整列宽（只动本列）"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`调整「${col.label}」列宽`}
                    onMouseDown={(e) => startResize(col.key, e)}
                  />
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, ri) => (
            <tr
              key={ri}
              className={ri === selectedIdx ? "sel" : undefined}
              onClick={() => {
                setSelectedIdx(ri);
                onRowClick?.(ri);
              }}
            >
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
