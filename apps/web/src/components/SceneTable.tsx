import { fitWidthsMinHeight, type FitColumn } from "./table-fit";
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
/** 量不到自然宽时的兜底列宽（px） */
const FALLBACK_COL_WIDTH = 120;

/** 列宽（px，`key` → 宽）。用像素而非百分比：拖一条分割线只改它左边那一列 */
type Widths = Record<string, number>;

/**
 * 列宽留存版本（v4）
 *
 * v3 的毛病：**把自动适配算出来的宽也存了下来**，下次渲染读到就当成"用户手动调过"，
 * 于是表格内容更新后仍沿用旧内容的宽度（列挤成一条、行撑得很高），用户只能一列一列
 * 手动拖。v4 起只有用户真的拖过才留存；旧键（v3）直接不管，一次性回到自动适配。
 */
const COL_WIDTHS_KEY_PREFIX = "scene.colwidths.v4.";

/**
 * 读留存列宽（px）。键集与当前列不一致或垃圾值返回 null
 * （调用方按内容重新量宽）。
 */
function loadWidths(storageKey: string | undefined, colKeys: string[]): Widths | null {
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(`${COL_WIDTHS_KEY_PREFIX}${storageKey}`);
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
  /** 各列内容需求（表头 + 每行内容的单行自然宽，px）：自动适配的输入 */
  const demandsRef = useRef<FitColumn[]>([]);
  /** 上面这份需求对应的列集签名（切表后需求会过期，必须能识别出来） */
  const demandsSigRef = useRef<string | null>(null);
  const colKeysSigRef = useRef(colKeysSig);
  colKeysSigRef.current = colKeysSig;
  /** 用户手动拖过（或读到留存值）后不再自动重排 */
  const manualRef = useRef(widths !== null);
  /** 拖拽基线：起点 X、被拖列的起点宽、拖拽开始那一刻的全表列宽（冻结） */
  const dragRef = useRef<{
    key: string;
    startX: number;
    startW: number;
    base: Widths;
  } | null>(null);

  /* 测量阶段（无留存宽度）：整表单行自然宽渲染，量完立即适配容器（绘制前完成，无闪烁） */
  const measuring = widths === null;

  /**
   * 让列宽之和**恒等于中栏宽**（不变式：表宽 = 中栏宽，永不超出、永不出横向滚动条）
   *
   * 承接余量只认末列（其余列一律不动）——用户认可"往左调整没问题"，
   * 而余量若摊给所有列，就是用户反复反馈的「列宽联动」。
   */
  const padToContainer = useCallback((w: Widths): Widths => {
    const cols = columnsRef.current;
    const last = cols[cols.length - 1]?.key;
    if (last === undefined || cols.length < 2) return w;
    const container = Math.max(0, (wrapRef.current?.clientWidth ?? 0) - 1);
    if (container <= 0) return w;
    const sum = cols.reduce((a, c) => a + (w[c.key] ?? 0), 0);
    if (sum >= container) return w;
    return { ...w, [last]: (w[last] ?? 0) + (container - sum) };
  }, []);

  /**
   * 中栏宽变化时把列宽重新对齐到容器（**只准从最右一列往回让**，不搞全局比例缩放）
   *
   * 变宽：余量给末列（与 padToContainer 同一条规矩）。
   * 变窄：从最右列起逐列让出、各列保底可读下限；全部到底线仍不够（列太多）才整体按比例兜底。
   * 为什么不做全局比例缩放：那是把每一列都动一遍，正是"联动"的观感。
   */
  const syncToContainer = useCallback((w: Widths): Widths => {
    const cols = columnsRef.current;
    const keys = cols.map((c) => c.key);
    if (keys.length < 2) return w;
    const container = Math.max(0, (wrapRef.current?.clientWidth ?? 0) - 1);
    if (container <= 0) return w;
    const next = { ...w };
    let diff = container - keys.reduce((a, k) => a + (next[k] ?? 0), 0);
    if (diff === 0) return w;
    if (diff > 0) {
      const last = keys[keys.length - 1]!;
      next[last] = (next[last] ?? 0) + diff;
      return next;
    }
    for (let i = keys.length - 1; i >= 0 && diff < 0; i -= 1) {
      const k = keys[i]!;
      const give = Math.min(-diff, (next[k] ?? 0) - MIN_COL_WIDTH);
      if (give > 0) {
        next[k] = (next[k] ?? 0) - give;
        diff += give;
      }
    }
    if (diff < 0) {
      const total = keys.reduce((a, k) => a + (next[k] ?? 0), 0);
      const ratio = container / total;
      for (const k of keys) next[k] = Math.max(1, Math.round((next[k] ?? 0) * ratio));
    }
    return next;
  }, []);

  /** 自动适配：按各列内容需求求「总行高最小」的列宽（px） */
  const fitToContainer = useCallback(() => {
    const demands = demandsRef.current;
    /* 需求必须与当前列集同源：切表时需求还是上一张表的，用它算出来的宽与新表列 key
       对不上——每列都会掉回兜底宽 120px（实测就是这个现象）。等测量阶段产出新需求。 */
    if (demandsSigRef.current !== colKeysSigRef.current) return;
    /* 留 1px 余量：border-collapse 的表在宽度刚好等于容器时，最右那条边框会探出
       半像素，浏览器就认为"内容比容器宽 1px"（凭空多一条横向滚动条） */
    const container = Math.max(0, (wrapRef.current?.clientWidth ?? 0) - 1);
    if (demands.length === 0 || container <= 0) return;
    const fitted = fitWidthsMinHeight(demands, container);
    const next: Widths = {};
    for (const d of demands) {
      next[d.key] = Math.max(1, Math.round(fitted[d.key] ?? FALLBACK_COL_WIDTH));
    }
    // 求和取整可能比容器宽几像素——那会凭空多一条横向滚动条，把这点余量从最宽的列抹掉
    const total = demands.reduce((a, d) => a + next[d.key]!, 0);
    if (total > container) {
      const widest = demands.reduce((a, d) => (next[d.key]! > next[a.key]! ? d : a), demands[0]!);
      next[widest.key] = Math.max(1, next[widest.key]! - (total - container));
    }
    // 幂等：值没变就不 setState——ResizeObserver 与布局变化互相触发会打转（实测刷屏重渲染）
    const prev = widthsRef.current;
    if (prev && Object.keys(next).length === Object.keys(prev).length) {
      let same = true;
      for (const k of Object.keys(next)) if (prev[k] !== next[k]) { same = false; break; }
      if (same) return;
    }
    setWidths(next);
  }, []);

  /**
   * 测量阶段：整表单行自然宽渲染，逐格量出「内容需求」，再按总行高最小适配
   *
   * 量的是**每个单元格**的单行自然宽（不是只有表头）：行高由该行最高的那一格决定，
   * 只有知道每一行需要多宽，才能把宽给到真正撑高行的那一列。
   */
  useLayoutEffect(() => {
    if (!measuring) return;
    const table = tableRef.current;
    if (!table) return;
    const firstCell = table.querySelector("th, td");
    const cs = firstCell ? window.getComputedStyle(firstCell) : null;
    const padPx =
      (cs ? Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight) : 0) || 24;
    const contentPx = (el: Element): number =>
      Math.max(0, el.getBoundingClientRect().width - padPx);

    const demands: { key: string; headerPx: number; demands: number[] }[] = [];
    table.querySelectorAll("th").forEach((th) => {
      const key = (th as HTMLElement).dataset["colKey"];
      if (!key) return;
      demands.push({ key, headerPx: contentPx(th), demands: [] });
    });
    table.querySelectorAll("tbody tr").forEach((tr) => {
      // 列顺序 = DOM 顺序（表头与每行都是同一套 columns）
      tr.querySelectorAll("td").forEach((td, ci) => {
        demands[ci]?.demands.push(contentPx(td));
      });
    });
    if (demands.length === 0) return;
    demandsRef.current = demands;
    demandsSigRef.current = colKeysSig;
    manualRef.current = false;
    fitToContainer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, colKeysSig]);

  /**
   * 内容/行集变化（表格刚生成、重算换了一版）→ 重新自动适配
   *
   * 判据取"行数 + 行标识"：生成与重算会换掉行 id（重算=整批新行），而**就地编辑
   * 单元格不会**——否则用户改一个字就被重新排版，手动拖好的宽度会白拖。
   */
  const dataIdsSig = data
    .map((row) => {
      const id = (row as { id?: unknown }).id;
      return typeof id === "string" ? id : "";
    })
    .join(",");
  const dataSig = `${colKeysSig}|${data.length}|${dataIdsSig}`;
  const dataSigRef = useRef(dataSig);
  useEffect(() => {
    if (dataSigRef.current === dataSig) return;
    dataSigRef.current = dataSig;
    // 回到测量态：先按单行自然宽渲染量需求，再在绘制前换成适配结果（无闪烁）
    manualRef.current = false;
    setWidths(null);
  }, [dataSig]);

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
      /* 手动列宽遇到中栏变化：**用户拖过的宽度不动**，只把差值在右侧列上找平
         （中栏变窄也从最右列往回让，绝不整体缩放、绝不超出中栏） */
      const w = widthsRef.current;
      if (w) setWidths(syncToContainer(w));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measuring, fitToContainer, syncToContainer]);

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

  /**
   * 只有**用户手动拖过**的列宽才留存
   *
   * 自动适配的宽是"这份内容的临时最优解"，内容一变就该重算——存下来会让下一份
   * 内容沿用旧宽（用户抱怨的"得自己一列一列调"就是这么来的）。
   */
  useEffect(() => {
    if (!storageKey || widths === null || !manualRef.current) return;
    try {
      window.localStorage.setItem(`${COL_WIDTHS_KEY_PREFIX}${storageKey}`, JSON.stringify(widths));
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
   * 拖某列右缘的分割线：**被拖列与它右边紧邻那一列互换宽度**（v1.35 用户定调）
   *
   * 用户要求原话：「列宽调整不能在底部加横向移动条」「表格整体的宽度不能超过中栏的宽度」，
   * 要改的是「向右调整列分格线不要影响所有右边的列」。
   *
   * 于是：给被拖列加多少，就从**紧挨着它的右邻**身上等量取多少（拖窄反之）——
   *   ① 列宽之和不变 → 表宽恒等于中栏宽，永不出现横向滚动条；
   *   ② 右邻之后的列，宽度与**位置**都不动（第 i 列加 x、第 i+1 列减 x，两者右边界不动）；
   *   ③ 被拖列与右邻都不许越过可读下限，到线下限即停（不再"偷"别的列的宽度）。
   */
  const startResize = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.preventDefault();
      const cols = columnsRef.current;
      const rightKey = cols[cols.findIndex((c) => c.key === key) + 1]?.key;
      const base = { ...(widths ?? {}) };
      if (rightKey === undefined) return; // 末列右缘就是表右缘，没有可互换的邻居
      const startW = base[key] ?? FALLBACK_COL_WIDTH;
      const startRight = base[rightKey] ?? FALLBACK_COL_WIDTH;
      dragRef.current = { key, startX: e.clientX, startW, base };
      setIsResizing(true);
      manualRef.current = true;

      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const want = Math.round(drag.startW + (ev.clientX - drag.startX)) - startW;
        // 两侧都保底：被拖列不许低于下限，右邻也不许被抽干
        const delta = Math.max(Math.min(want, startRight - MIN_COL_WIDTH), MIN_COL_WIDTH - startW);
        setWidths({
          ...drag.base,
          [key]: startW + delta,
          [rightKey]: startRight - delta,
        });
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
      window.localStorage.removeItem(`${COL_WIDTHS_KEY_PREFIX}${storageKey}`);
    } catch {
      /* 忽略 */
    }
  }, [storageKey]);

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
        style={
          measuring
            ? undefined
            : {
                tableLayout: "fixed",
                /* 表宽恒为 100%（= 中栏宽）：列宽之和已经对齐到中栏宽，
                   `width: 100%` 只是最后一道保险——即便某次求和差了几像素，
                   浏览器也只会等比微调，绝不会撑出中栏、更不会出现横向滚动条 */
                width: "100%",
              }
        }
      >
        {!measuring && (
          <colgroup>
            {columns.map((col) => (
              <col
                key={col.key}
                /* 每列（含末列）都写死宽：谁都不许替别人变宽变窄（v1.34） */
                style={{ width: `${widths?.[col.key] ?? FALLBACK_COL_WIDTH}px` }}
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
