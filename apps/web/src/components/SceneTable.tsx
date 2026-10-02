import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface ColumnDef<T> {
  key: keyof T & string;
  label: string;
  editable?: boolean;
  /**
   * 多行编辑（内容可能很长）：单元格用 textarea 就地编辑——
   * **内容换行显示、行高随内容长**（用户定调 2026-09-26）
   */
  multiline?: boolean;
  /** 空值占位文案（可按行给不同提示） */
  placeholder?: string | ((row: T) => string);
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
  /** 表格自身的类名（如 `schema-table--anchor`） */
  tableClassName?: string;
  /**
   * 行级可编辑判定（缺省整行可编辑）
   *
   * 场景锚里有"表定义有、库里没有"的固定行——写了也没处落，
   * 渲染成灰字提示，而不是给一个存不下去的控件。
   */
  rowEditable?: (row: T) => boolean;
}

/** 拖拽列宽下限（px）：再窄内容与标题都不可读 */
const MIN_COL_WIDTH = 64;
/** 自适应时允许压到的下限（比拖拽下限更小，避免窄容器被撑出横向滚动） */
const FIT_MIN_COL_WIDTH = 24;
/** 量不到自然宽时的兜底列宽（px） */
const FALLBACK_COL_WIDTH = 120;

/** 列宽（px，`key` → 宽）。用像素而非百分比：拖一条分割线只改它左边那一列 */
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
 * 读留存列宽（px）。键集与当前列不一致或垃圾值返回 null
 * （调用方按内容重新量宽）。
 */
function loadWidths(storageKey: string | undefined, colKeys: string[]): Widths | null {
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(`scene.colwidths.v3.${storageKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return null;
    const out: Widths = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && v > 0) out[k] = v;
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
 * 自适应高度的多行编辑器（用户定调：内容换行 + 行高随内容长）
 *
 * 为什么不是 `<input>`：单行输入框既显示不了换行，行高也永远只有一行。
 * 为什么不用固定 `rows={4}`：内容短时留白、内容长时框内滚动，都不叫"行高随内容"。
 * 这里按 scrollHeight 长高，并用 ResizeObserver 跟随列宽变化重算
 * （列被拖窄 → 换行变多 → 行随之变高）。
 */
const AutoGrowTextarea: React.FC<{
  value: string;
  placeholder: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
}> = ({ value, placeholder, ariaLabel, onCommit }) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = `${el.scrollHeight}px`;
    if (el.style.height !== next) el.style.height = next;
  }, []);

  useLayoutEffect(() => {
    grow();
  }, [grow]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => grow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [grow]);

  return (
    <textarea
      ref={ref}
      className="cell-input cell-input--multi"
      rows={1}
      defaultValue={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onInput={grow}
      onBlur={(e) => {
        const next = e.currentTarget.value;
        if (next !== value) onCommit(next);
      }}
    />
  );
};

/**
 * 通用场景表格组件
 * 支持：逐单元格编辑（短文本 contenteditable / 长文本 textarea）、来源与状态自定义渲染、
 *       表头右缘热区拖拽调列宽（**只动这一列**）、内容换行 + 行高随内容长。
 *
 * 列宽策略（用户定稿 2026-09-26）：
 * - 表宽跟着中栏走（表宽 ≥ 中栏内容宽；列宽之和超出时才出现横向滚动）
 * - 默认态：按各列实际内容的自然宽适配（整体高度最紧凑）
 * - 拖某列右缘：**只有这一列变宽/变窄**，其他列的宽与它们的分割线纹丝不动
 * - 双击分割线：该表回到「按内容自适应」
 * - 宽度按 storageKey 本地留存（留存后不再自动重排）
 */
export function SceneTable<T extends Record<string, unknown>>({
  columns,
  data,
  onCellChange,
  storageKey,
  onRowClick,
  tableClassName,
  rowEditable,
}: SceneTableProps<T>) {
  const colKeys = columns.map((c) => c.key);
  const colKeysSig = colKeys.join(",");
  const [widths, setWidths] = useState<Widths | null>(() => loadWidths(storageKey, colKeys));
  const [containerW, setContainerW] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  /** 选中行（右栏详情联动高亮） */
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  /** RO 回调里读最新列定义/列宽（effect 不随它们重建，避免反复解绑观察器） */
  const columnsRef = useRef(columns);
  const widthsRef = useRef(widths);
  columnsRef.current = columns;
  widthsRef.current = widths;
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 各列自然宽缓存 */
  const naturalsRef = useRef<NaturalWidth[]>([]);
  /** 用户手动拖过（或读到留存值）后不再自动重排 */
  const manualRef = useRef(widths !== null);
  /** 拖拽基线：起点 X、被拖列的起点宽、冻结的全表宽 */
  const dragRef = useRef<{
    key: string;
    startX: number;
    startW: number;
    /** 被拖列允许的最大宽（末列让到可读下限为止） */
    maxW: number;
    base: Widths;
  } | null>(null);

  /* 测量阶段（无留存宽度）：整表单行自然宽渲染，量完立即适配容器（绘制前完成，无闪烁） */
  const measuring = widths === null;

  /** 默认态：按内容自然宽适配到当前容器宽（px） */
  const fitToContainer = useCallback(() => {
    const naturals = naturalsRef.current;
    /* 留 1px 余量：border-collapse 的表在宽度刚好等于容器时，最右那条边框会探出
       半像素，浏览器就认为"内容比容器宽 1px"（凭空多一条横向滚动条） */
    const container = Math.max(0, (wrapRef.current?.clientWidth ?? 0) - 1);
    if (naturals.length === 0 || container <= 0) return;
    const fitted = fitWidths(naturals, container);
    const next: Widths = {};
    naturals.forEach((n, i) => {
      next[n.key] = Math.max(FIT_MIN_COL_WIDTH, Math.round(fitted[i] ?? FALLBACK_COL_WIDTH));
    });
    // 取整可能让总和比容器宽几个像素——那会凭空多一条横向滚动条，把这点余量从最宽的列抹掉
    const total = naturals.reduce((a, n) => a + next[n.key]!, 0);
    if (total > container) {
      const widest = naturals.reduce((a, n) => (next[n.key]! > next[a.key]! ? n : a), naturals[0]!);
      next[widest.key] = Math.max(FIT_MIN_COL_WIDTH, next[widest.key]! - (total - container));
    }
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

  /* 容器宽变化：记下来（算填充列宽）；未手动调过列宽时按内容重新适配 */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const sync = () => {
      setContainerW(wrap.clientWidth);
      if (!manualRef.current) {
        fitToContainer();
        return;
      }
      /* 手动列宽遇到中栏变窄：末列最多让到可读下限，再不够就按比例收（绝不出横滚） */
      const cols = columnsRef.current;
      const last = cols[cols.length - 1]?.key;
      const sumOthers = cols
        .filter((c) => c.key !== last)
        .reduce((a, c) => a + (widthsRef.current?.[c.key] ?? 0), 0);
      const room = wrap.clientWidth - sumOthers;
      if (room >= MIN_COL_WIDTH) return;
      const scale = Math.max(0.1, (wrap.clientWidth - MIN_COL_WIDTH) / Math.max(1, sumOthers));
      const next: Widths = {};
      for (const c of cols) {
        const w = widthsRef.current?.[c.key];
        if (typeof w === "number") next[c.key] = Math.max(FIT_MIN_COL_WIDTH, Math.round(w * scale));
      }
      setWidths(next);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measuring, fitToContainer]);

  /* 同一实例切换表（storageKey 或列集变了）：重新读留存宽度；读不到就回测量态——
     否则会把上一张表的列宽套到新表上（列 key 对不上 → 宽度全是 0） */
  const sigRef = useRef(`${storageKey ?? ""}|${colKeysSig}`);
  useEffect(() => {
    const sig = `${storageKey ?? ""}|${colKeysSig}`;
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    const loaded = loadWidths(storageKey, colKeys);
    manualRef.current = loaded !== null;
    setWidths(loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, colKeysSig]);

  useEffect(() => {
    if (!storageKey || widths === null) return;
    try {
      window.localStorage.setItem(`scene.colwidths.v3.${storageKey}`, JSON.stringify(widths));
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

  /**
   * 拖某列右缘的分割线：**只有这一列变宽/变窄**。
   *
   * 不做「左右两列交换宽度」——那会把右边那一列一起挪动（用户明确不要）。
   * 变宽到超过中栏宽时由 `.tw` 出横向滚动；变窄时空出的宽由填充列承接，
   * 所以其他列既不变宽也不变窄。
   */
  const startResize = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault();
      const base = { ...(widths ?? {}) };
      const startW = base[key] ?? FALLBACK_COL_WIDTH;
      /* 末列不设固定宽（承接余量）：它能让出的最多是"降到可读下限"那点，
         所以被拖列的加宽上限 = 自身宽 + 末列余量。表宽因此恒等于中栏宽，不出横滚。 */
      const lastTh = tableRef.current?.querySelector("th:last-child");
      const lastW = lastTh ? lastTh.getBoundingClientRect().width : 0;
      const maxW = startW + Math.max(0, lastW - MIN_COL_WIDTH);
      dragRef.current = { key, startX: e.clientX, startW, maxW, base };
      setIsResizing(true);
      manualRef.current = true;

      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const raw = Math.round(drag.startW + (ev.clientX - drag.startX));
        const next = Math.min(Math.max(raw, MIN_COL_WIDTH), Math.round(drag.maxW));
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

  /** 双击分割线：该表回到「按内容自适应」（撤销手动列宽） */
  const resetWidths = useCallback(() => {
    manualRef.current = false;
    setWidths(null);
    if (!storageKey) return;
    try {
      window.localStorage.removeItem(`scene.colwidths.v3.${storageKey}`);
    } catch {
      /* 忽略 */
    }
  }, [storageKey]);

  /** 末列宽不写死：它承接各列宽之和与中栏宽之间的余量（表宽恒等于中栏宽，不出横向滚动） */
  const lastKey = columns.length > 0 ? columns[columns.length - 1]!.key : undefined;
  const placeholderOf = (col: ColumnDef<T>, row: T): string =>
    typeof col.placeholder === "function" ? col.placeholder(row) : (col.placeholder ?? "");
  const resizeHandle = (col: ColumnDef<T>): React.ReactElement => (
    <span
      className="th-resize"
      title="拖拽调整这一列的宽度（只动这一列）；双击恢复按内容自适应"
      role="separator"
      aria-orientation="vertical"
      aria-label={`调整「${col.label}」列宽（只影响这一列）`}
      onMouseDown={(e) => startResize(col.key, e)}
      onDoubleClick={resetWidths}
    />
  );

  return (
    <div className={`tw${isResizing ? " is-resizing" : ""}`} ref={wrapRef}>
      <table
        ref={tableRef}
        className={measuring ? "measure" : tableClassName}
        style={measuring ? undefined : { tableLayout: "fixed", width: "100%" }}
      >
        {!measuring && (
          <colgroup>
            {columns.map((col) => (
              <col
                key={col.key}
                /* 末列不给宽：余量归它，表宽才恒等于中栏宽 */
                style={
                  col.key === lastKey && columns.length > 1
                    ? undefined
                    : { width: `${widths?.[col.key] ?? FALLBACK_COL_WIDTH}px` }
                }
              />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {columns.map((col, ci) => (
              <th key={col.key} data-col-key={col.key}>
                {col.label}
                {/* 只在"列与列之间"装手柄：末列右缘就是表右缘，无边界可移 */}
                {ci < columns.length - 1 ? resizeHandle(col) : null}
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
                  return <td key={col.key}>{col.render(value, row)}</td>;
                }

                /* 是否可编辑只看列定义与行（与旧行为一致）；
                   多行编辑在**测量阶段**先渲染纯文本，否则 textarea 会把自然宽量歪 */
                const canEdit =
                  Boolean(col.editable) &&
                  !(col.multiline && measuring) &&
                  (rowEditable ? rowEditable(row) : true);

                // 长文本：换行显示 + 行高随内容长
                if (col.multiline) {
                  if (canEdit) {
                    return (
                      <td key={col.key} className="ed ed-multi">
                        <AutoGrowTextarea
                          value={String(value ?? "")}
                          placeholder={placeholderOf(col, row)}
                          ariaLabel={`${col.label}（第 ${ri + 1} 行）`}
                          onCommit={(next) => onCellChange?.(ri, col.key, next)}
                        />
                      </td>
                    );
                  }
                  const text = String(value ?? "");
                  return (
                    <td key={col.key}>
                      {text !== "" ? (
                        <span className="cell-text">{text}</span>
                      ) : (
                        <span className="cell-hint">{placeholderOf(col, row) || "—"}</span>
                      )}
                    </td>
                  );
                }

                // 可编辑单元格（短文本；超出列宽即换行，行高随内容长）
                if (canEdit) {
                  return (
                    <td
                      key={col.key}
                      className="ed"
                      contentEditable
                      suppressContentEditableWarning
                      title={String(value ?? "")}
                      onKeyDown={(e) => {
                        // 短文本格是单段落值：Enter 当作"改完了"（回车换行会以块级子元素落进 DOM，
                        // blur 时读 textContent 会把两行粘成一行）
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={(e) => handleBlur(ri, col.key, e.currentTarget)}
                    >
                      {String(value ?? "")}
                    </td>
                  );
                }

                // 只读文本
                return (
                  <td key={col.key}>
                    <span className="cell-text">{String(value ?? "")}</span>
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
