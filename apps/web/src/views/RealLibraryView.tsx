import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiMaterialFile, type ApiProductLine } from "../api";
import { useAsync } from "../hooks/useAsync";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { MaterialUpload } from "../components/MaterialUpload";
import type { RowDetail } from "../components/RowDetailPanel";
import { useToast } from "../components/Toast";
import { promptText } from "../components/prompt-text";
import {
  dedupePreviewText,
  sourceLabel,
  verificationRows,
  verificationSummaryText,
  verifyDoneText,
  type VerifyDisplayRow,
} from "../components/library-verify";
import { TABLES_BY_CODE } from "@scene/contract";
import {
  draftPayload,
  draftReady,
  isDraftRow,
  makeDraftRow,
  type DraftRow,
} from "./library-draft";

/**
 * 联真资料库视图（M5-T5.4）
 * - 产品线切换 / 已导入资料 / M1、M2、M3、M4（边界+限制）、M6、O 可选材料
 * - 质量总评与补充提醒两个 Tab 已下线（用户定调 2026-10-21）：接口与领域函数保留，
 *   只是本页不再请求 `qualitySummary`——结论看 M4 的「依据/来源」，不另开一页评分。
 * - 单元格编辑 → PATCH library rows（source_type 置"用户确认"，F3 失效由服务端内联处理）
 * - 上传材料 → multipart ingest + SSE 进度流（解析→落库→done 行数）
 * - §4.3 三态：加载 / 空态（无产品线、无行）/ 降级（错误+重试）
 */

/** 行数据中不展示的内部列（id/时间戳/关联外键） */
const HIDDEN_KEYS = new Set(["id", "created_at", "updated_at", "product_line_id", "product_id"]);

/**
 * 溯源四列：主表合并为一个「溯源」徽标列，全量详情落右栏行详情
 * （变更表 #19 组合拳：降维不删信息，溯源铁律的信息一键可达）
 */
const TRACE_KEYS = ["source_type", "source", "source_authority", "evidence_level"] as const;
const TRACE_SET = new Set<string>(TRACE_KEYS);

/** 每表收进右栏「补充信息」的次要列（主表不再占列；数据与契约不动） */
const DETAIL_ONLY_KEYS: Record<string, string[]> = {
  // v2.11：M1 只保留 型号/名称/状态/来源；DB 列不删，只是不再进表格
  M1: ["former_name", "launch_date", "position_desc"],
  // M3 依赖条件已并入 description，不再单列
  M3: ["dependency"],
};

/**
 * 固定列集与顺序（M3/M4/M6）
 *
 * M4 是 boundary + limitation 的合并视图，只显示用户要的四列：说明 / 依据 / 影响程度 /
 * 客户要求时怎么办。类型与对象仍在行数据里（依据门禁、编辑路由要用），但不占列；
 * 来源也收进右栏。M6 同理，价格口径/有效期留在 DB 与右栏，不再进表。
 * M3 固定能力五列中的四列（来源收右栏），不适用场景已从表定义删除。
 */
const FIXED_COLUMNS: Record<string, string[]> = {
  M3: ["domain", "name", "description", "maturity"],
  M4: ["description", "reason", "impact", "response"],
  M6: ["model", "config", "unit_price"],
};

/** 哪些表的「来源」要显示在主表；M3/M4/M6 均已收进右栏 */
const SHOW_SOURCE_CODES = new Set<string>();

/** 已从主表隐藏、但仍要在右栏可查的结构/历史字段（只读，避免把类型改坏） */
const READONLY_DETAIL_KEYS: Record<string, string[]> = {
  M3: ["inapplicable_scene"],
  M4: ["type", "target"],
  M6: ["price_scope", "valid_until"],
};

/**
 * 空表 / 新增行额外露出的列
 *
 * 平时 M4 只看四列（说明/依据/影响/怎么办），来源与类型收在右栏；但新增一行时
 * 右栏还没有行可点，而「不做」必须能填来源、类型必须能区分不做/限制——所以只在
 * 有草稿行时把这几列露出来，普通浏览视图不变。
 */
const DRAFT_EXTRA_KEYS: Record<string, string[]> = {
  M4: ["type", "target", "source"],
};

const M_TABS: { code: string; label: string }[] = [
  { code: "M1", label: "产品清单" },
  { code: "M2", label: "规格书" },
  { code: "M3", label: "能力清单" },
  { code: "M4", label: "边界与限制" },
  { code: "M6", label: "报价" },
];

const O_CODES = ["O1", "O2", "O4", "O5", "O6"];

/**
 * 可选材料：五类**共用一个面板**，用「类别」选择器切换（不再 5 张表叠一页；价格类别已下线）
 *
 * 为什么不并成一张表：五类字段完全不同（认证/案例/SDK/特性/伙伴），
 * 合成一张会得到 20+ 列、绝大多数格是空的稀疏表——那是"更宽"而不是"更简"。
 */


/** 通用列中文表头（溯源列等跨表字段） */
const COMMON_FIELD_LABELS: Record<string, string> = {
  category: "类别",
  source: "来源标注",
  source_type: "来源类型",
  source_authority: "来源权威性",
  evidence_level: "证据等级",
};

/** 各表字段中文表头（与 ingest 归类口径一致，字段名照旧存库） */
const FIELD_LABELS: Record<string, Record<string, string>> = {
  M1: {
    model: "型号",
    name: "产品名称",
    status: "状态",
    launch_date: "发布日期",
    former_name: "曾用名",
    position_desc: "定位描述",
  },
  M2: {
    param_class: "参数类别",
    param_name: "参数名称",
    value: "参数值",
    measured: "实测口径",
    product_model: "关联产品型号",
  },
  M3: {
    domain: "领域",
    name: "能力名称",
    description: "描述",
    maturity: "成熟度",
    dependency: "依赖项",
    inapplicable_scene: "不适用场景（历史）",
  },
  M4: {
    type: "类型",
    target: "对象（产品/能力）",
    description: "说明",
    reason: "依据",
    impact: "影响程度",
    response: "客户要求时怎么办",
    source: "来源",
  },
  M5: {
    product_name: "产品名称",
    description: "限制描述",
    impact: "影响",
    fix_status: "修复状态",
    external_visible: "可否外提",
    owner: "负责人",
  },
  M6: {
    model: "型号",
    config: "配置构成",
    unit_price: "含税单价（元）",
    price_scope: "价格口径",
    valid_until: "报价有效期",
    source: "来源",
  },
  O1: {
    // 契约 payload 字段
    model: "型号",
    cert_type: "证书类型",
    cert_no: "证书号",
    valid_until: "有效期至",
    issuer: "发证机构",
    covered_models: "覆盖型号",
    file: "证书文件",
    // 历史 O1 行可能还是旧字段名，保留中文表头便于查看
    cert_name: "认证名称",
    cert_body: "认证机构",
    cert_date: "认证日期",
    scope: "认证范围",
  },
  O2: {
    name: "案例名",
    scene: "场景",
    delivered_at: "交付时间",
    acceptance: "验收指标与结果",
    customer: "客户（脱敏）",
    scale: "部署规模",
    revisit_allowed: "可否回访",
    evidence_level: "证据等级",
    // 历史字段
    project_name: "项目名称",
    client: "客户",
    year: "年份",
    summary: "摘要",
  },
  O4: {
    product: "产品",
    doc_name: "资料名称",
    version: "版本",
    coverage: "覆盖内容",
    // 历史字段
    name: "名称",
    language: "语言",
    url: "链接",
    maturity: "成熟度",
  },
  O5: {
    item: "能力/产品",
    status: "当前状态",
    planned_at: "计划可用时间",
    confidence: "置信度",
    owner: "负责人",
    // 历史字段
    feature: "特性",
    expected_release: "预计发布",
    priority: "优先级",
  },
  O6: {
    item: "项",
    coverage: "覆盖范围",
    status: "现状",
    partner: "合作方",
    depth: "合作深度",
    // 历史字段
    partner_name: "伙伴名称",
    integration_type: "集成类型",
    maturity: "成熟度",
  },
};

/** 字段名 → 中文表头（未登记字段原样显示） */
function fieldLabel(code: string, key: string): string {
  return FIELD_LABELS[code]?.[key] ?? COMMON_FIELD_LABELS[key] ?? key;
}

const O_LABELS: Record<string, string> = {
  O1: "认证",
  O2: "案例",
  O4: "SDK",
  O5: "路线图",
  O6: "生态",
};

/** 可选材料的 UI 类别码 → 契约 payload 键（空表表头必须从 payload 取，不能只看已落库行） */
const O_PAYLOAD_KEYS: Record<string, string> = {
  O1: "O1认证",
  O2: "O2案例",
  O4: "O4开发资料",
  O5: "O5路线图",
  O6: "O6交付与生态",
};

/** 值 → 单元格文本（对象转 JSON，null 转空） */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/* ═══ 单表面板（M 表 / O 表共用） ═══ */

interface TablePanelProps {
  code: string;
  label: string;
  lineId: string;
  /** O 表：编辑走 payload 整体合并 */
  optional?: boolean;
  reloadTick: number;
  onChanged?: () => void;
  /** 行点击上报右栏行详情（变更表 #19） */
  onRowSelect?: (detail: RowDetail) => void;
  /** 表头右侧插槽（O 类别切换等） */
  headerExtra?: React.ReactNode;
}

const TablePanel: React.FC<TablePanelProps> = ({
  code,
  label,
  lineId,
  optional,
  reloadTick,
  onChanged,
  onRowSelect,
  headerExtra,
}) => {
  const { showToast } = useToast();
  const { status, data, error, reload } = useAsync(
    () => api.libraryTable(code, lineId),
    [code, lineId, reloadTick],
  );

  /* M2 规格书按产品出表（一个产品一张表）；产品来自 M1 */
  const productRows = useAsync(
    () => (code === "M2" ? api.libraryTable("M1", lineId) : Promise.resolve([])),
    [code, lineId, reloadTick],
  );
  /** ""=默认首个产品；"__all__"=全部产品合表 */
  const [productPick, setProductPick] = useState("");
  const firstProductId = String((productRows.data?.[0] as Record<string, unknown> | undefined)?.__id ?? (productRows.data?.[0] as Record<string, unknown> | undefined)?.id ?? "");
  const filterProductId = useMemo(() => {
    if (code !== "M2") return "";
    if (productPick === "__all__") return "";
    return productPick || firstProductId;
  }, [code, productPick, firstProductId]);

  /* O 表把 payload 展开为行字段；M 表原样；值统一转字符串便于编辑与展示 */
  const rows = useMemo(() => {
    if (!data) return [];
    const src = filterProductId
      ? data.filter((r) => String((r as Record<string, unknown>)["product_id"] ?? "") === filterProductId)
      : data;
    return src.map((r) => {
      if (optional) {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        const flat: Record<string, unknown> = { category: r.category, __id: r.id };
        // 溯源字段带出（主表并入溯源徽标，详情落右栏）
        const raw = r as unknown as Record<string, unknown>;
        for (const tk of TRACE_KEYS) flat[tk] = cellText(raw[tk]);
        for (const [k, v] of Object.entries(payload)) flat[k] = cellText(v);
        return flat;
      }
      const flat: Record<string, unknown> = { __id: r.id };
      for (const [k, v] of Object.entries(r)) {
        if (!HIDDEN_KEYS.has(k)) flat[k] = cellText(v);
      }
      return flat;
    });
  }, [data, optional, filterProductId]);

  /**
   * 表格内新增行：空白行先留在本地，填满这张表的最小必填集才落库。
   *
   * 空表也要给一行可输入的空行（用户定调 2026-10-22：「不要空，哪怕是个空表也要把
   * 表头、空行显示出来，用户才好输入内容」）——所以首次拿到 0 行数据时自动放一行草稿。
   */
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const emptyDraftKeyRef = useRef<string | null>(null);
  const savingDraftsRef = useRef<Set<string>>(new Set());
  const tableKey = `${code}:${lineId}`;

  /** 切表/切产品线：丢掉上一张表没填完的草稿 */
  useEffect(() => {
    setDrafts([]);
    emptyDraftKeyRef.current = null;
  }, [code, lineId]);

  useEffect(() => {
    if (status !== "ok" || !data || data.length > 0) return;
    if (emptyDraftKeyRef.current === tableKey) return;
    emptyDraftKeyRef.current = tableKey;
    setDrafts((prev) => (prev.length > 0 ? prev : [makeDraftRow(code, firstProductId)]));
  }, [status, data, code, lineId, firstProductId, tableKey]);

  /** M2 的产品选择晚到/切换时，把草稿挂到当前产品上（草稿没有产品就无法落库） */
  useEffect(() => {
    if (code !== "M2" || !firstProductId) return;
    setDrafts((prev) =>
      prev.map((d) => (!d.product_id ? { ...d, product_id: firstProductId } : d)),
    );
  }, [code, firstProductId]);

  const displayRows = useMemo(() => [...rows, ...drafts], [rows, drafts]);

  /**
   * 表格简化（用户定调 2026-10-04「表格能不能简化？」）
   *
   * 规则：**整列一个值都没有、且不是必填列** → 默认不显示；「显示空列」可一键展开。
   * 为什么加"不是必填列"这个条件：必填列空着是"还没填"，藏起来等于把待办藏了；
   * 选填列整列全空纯粹是占位噪声（如 M1 全表的发布日期、M3 的旧依赖列）。
   * 判定来源是契约注册表（tables.ts）的 required 标记，不是这里拍的。
   */
  const requiredKeys = useMemo(() => {
    const def = TABLES_BY_CODE[code];
    if (!def) return new Set<string>();
    return new Set(def.columns.filter((c) => c.required).map((c) => c.key));
  }, [code]);

  /** 是否显示"整列全空"的选填列（默认不显示：先给干净的简化视图） */
  const [showEmptyCols, setShowEmptyCols] = useState(false);

  /** 整列全空、且不是必填列的选填列（默认收起；判定不碰状态） */
  const hiddenEmptyKeys = useMemo(() => {
    // 空表不收起任何列：表头本身就是用户填写的入口，藏列等于让人无从下手
    if (rows.length === 0) return [];
    const detailOnly = new Set(DETAIL_ONLY_KEYS[code] ?? []);
    const fixed = new Set(FIXED_COLUMNS[code] ?? []);
    const keys = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (k === "__id" || (TRACE_SET.has(k) && !SHOW_SOURCE_CODES.has(code)) || detailOnly.has(k)) continue;
        keys.add(k);
      }
    }
    // 固定列集不参与"整列空就收起"：M4/M6 的列由表定义定死
    return [...keys].filter(
      (k) =>
        !fixed.has(k) &&
        !requiredKeys.has(k) &&
        rows.every((r) => cellText(r[k]).trim() === ""),
    );
  }, [rows, code, requiredKeys]);

  /** 当前可选材料类别的 payload 列定义（空表表头与必填判定共用） */
  const optionalPayload = useMemo(
    () =>
      optional
        ? TABLES_BY_CODE["可选材料"]?.payloads?.[O_PAYLOAD_KEYS[code]] ?? []
        : [],
    [optional, code],
  );
  const optionalRequiredKeys = useMemo(
    () => optionalPayload.filter((c) => c.required).map((c) => c.key),
    [optionalPayload],
  );

  /**
   * 空表的列：直接取契约业务列，保证表头与输入位都在。
   *
   * 非空表沿用原规则（只显示有数据的列 + 固定列）；新增行草稿存在时补上草稿默认字段
   * 与 M4 的 type/target/source（右栏还没行可点，来源必须能在新增行里填）。
   */
  const columns = useMemo(() => {
    const detailOnly = new Set(DETAIL_ONLY_KEYS[code] ?? []);
    const seen = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (
          k === "__id" ||
          // 可选材料的 payload 里 evidence_level 是业务列（证据等级），不是顶部溯源列
          (TRACE_SET.has(k) && !SHOW_SOURCE_CODES.has(code) && !optional) ||
          detailOnly.has(k)
        ) continue;
        seen.add(k);
      }
    }
    const def = TABLES_BY_CODE[code];
    /**
     * 可选材料在契约里是一张动态 payload 表（表号不是 O1），空表时不能拿
     * TABLES_BY_CODE[code] 硬查；按当前类别取对应 payload 的列，才有表头可填。
     */
    const schemaColumns = optional ? optionalPayload : def?.columns ?? [];
    const schemaKeys = schemaColumns
      .map((c) => c.key)
      .filter(
        (k) =>
          !HIDDEN_KEYS.has(k) &&
          !(TRACE_SET.has(k) && !SHOW_SOURCE_CODES.has(code) && !optional) &&
          !detailOnly.has(k),
      );
    const fixed = FIXED_COLUMNS[code];
    let ordered: string[];
    if (rows.length === 0) {
      // 空表：固定列优先（M3/M4/M6），没有固定列就用契约业务列（M1/M2/O）
      ordered = fixed ? [...fixed] : schemaKeys;
    } else {
      ordered = fixed ? fixed.filter((k) => seen.has(k)) : [...seen];
    }
    // 新增行草稿额外的字段：默认值 + 只在草稿出现的列（M4 类型/来源）
    if (drafts.length > 0) {
      for (const k of Object.keys(drafts[0] ?? {})) {
        if (k.startsWith("__") || HIDDEN_KEYS.has(k) || detailOnly.has(k)) continue;
        if (!ordered.includes(k)) ordered.push(k);
      }
      for (const k of DRAFT_EXTRA_KEYS[code] ?? []) {
        if (!ordered.includes(k)) ordered.push(k);
      }
    }
    const cols: ColumnDef<Record<string, unknown>>[] = ordered
      .filter((k) => rows.length === 0 || fixed || showEmptyCols || !hiddenEmptyKeys.includes(k))
      .map((key) => ({
        key,
        label: fieldLabel(code, key),
        // 类型是记录归属（不做/限制），普通行由底层表决定；只有新行草稿能在格子里改
        editable:
          key === "type" ? (row: Record<string, unknown>) => isDraftRow(row) : true,
      }));
    // 溯源不占列：点行即报右栏，来源类型/权威性/证据等级/来源标注在右栏可看可改
    // （用户定调 2026-10-04：主表要简；「中栏说结果，来源归右栏」同一条口径）
    cols.push({
      key: "__ops",
      label: "操作",
      render: (_v, row) =>
        isDraftRow(row) ? (
          <button
            className="btn sm"
            type="button"
            onClick={() => setDrafts((prev) => prev.filter((d) => d.__draftId !== row.__draftId))}
          >
            取消
          </button>
        ) : (
          <button className="btn sm" type="button" onClick={() => void handleDelete(row)}>
            删除
          </button>
        ),
    });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, drafts, showEmptyCols, requiredKeys, hiddenEmptyKeys, code, optionalPayload]);

  const handleCellChange = useCallback(
    async (rowIndex: number, key: string, value: string) => {
      const row = displayRows[rowIndex];
      if (!row) return;

      /* 新增行：先改本地草稿；填满最小必填集才落库。用户不需要再点「保存」。 */
      if (isDraftRow(row)) {
        const draftId = row.__draftId;
        const next = { ...row, [key]: value };
        setDrafts((prev) => prev.map((d) => (d.__draftId === draftId ? next : d)));
        if (
          !draftReady(code, next, optionalRequiredKeys) ||
          savingDraftsRef.current.has(draftId)
        ) {
          return;
        }
        savingDraftsRef.current.add(draftId);
        try {
          await api.addLibraryRow(code, lineId, draftPayload(next));
          setDrafts((prev) => prev.filter((d) => d.__draftId !== draftId));
          reload();
          onChanged?.();
          showToast("已新增行");
        } catch (err: unknown) {
          showToast(`新增失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          savingDraftsRef.current.delete(draftId);
        }
        return;
      }

      if (code === "M4") {
        const kind = String(row.type ?? "");
        const inapplicable =
          (kind === "不做" && (key === "target" || key === "impact")) ||
          // 限制类没有「依据」（reason）与「客户要求时怎么办」（response）
          (kind === "限制" && (key === "reason" || key === "response"));
        if (key === "type" || inapplicable) {
          showToast("该字段不适用于这类记录（底层「不做」与「限制」字段不同）");
          return;
        }
      }
      const rowId = String(row.__id);
      try {
        if (optional) {
          const nextPayload = { ...row, category: undefined, __id: undefined, [key]: value };
          delete nextPayload.category;
          delete nextPayload.__id;
          await api.patchLibraryRow(code, rowId, "payload", nextPayload);
        } else {
          await api.patchLibraryRow(code, rowId, key, value);
        }
        reload();
        onChanged?.();
      } catch (err: unknown) {
        showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [displayRows, code, lineId, optional, optionalRequiredKeys, reload, onChanged, showToast],
  );

  const handleDelete = useCallback(
    async (row: Record<string, unknown>) => {
      if (isDraftRow(row)) {
        setDrafts((prev) => prev.filter((d) => d.__draftId !== row.__draftId));
        return;
      }
      if (!window.confirm(`删除该行资料？关联阶段结果将标记待重算。`)) return;
      try {
        await api.deleteLibraryRow(code, String(row.__id));
        reload();
        onChanged?.();
        showToast("已删除");
      } catch (err: unknown) {
        showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [code, reload, onChanged, showToast],
  );

  /** 新增行：直接在表尾追加一行可编辑草稿，不再弹 JSON 输入框 */
  const handleAdd = useCallback(() => {
    setDrafts((prev) => [
      ...prev,
      makeDraftRow(code, code === "M2" ? filterProductId || firstProductId : ""),
    ]);
  }, [code, filterProductId, firstProductId]);

  /** 行点击 → 上报右栏行详情（补充字段 + 溯源全量） */
  const handleRowClick = useCallback(
    (ri: number) => {
      const row = displayRows[ri];
      if (!row || isDraftRow(row) || !onRowSelect) return;
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== "__id") fields[k] = cellText(v);
      }
      onRowSelect({
        code,
        tableLabel: label,
        rowId: String(row.__id),
        fields,
        editableKeys: (DETAIL_ONLY_KEYS[code] ?? []).map((k) => ({
          key: k,
          label: fieldLabel(code, k),
        })),
        readonlyKeys: (READONLY_DETAIL_KEYS[code] ?? []).map((k) => ({
          key: k,
          label: fieldLabel(code, k),
        })),
        traceKeys: TRACE_KEYS.map((k) => ({ key: k, label: fieldLabel(code, k) })),
        traceEditable: !optional,
      });
    },
    [displayRows, code, label, optional, onRowSelect],
  );

  /** 产品去重（M1）：同型号合并为一条，规格参数归并，删除重复行 */
  const handleDedupe = useCallback(async () => {
    if (
      !window.confirm("同型号产品将合并为一条（规格参数归并、缺位字段补全、删除重复产品行）。继续？")
    ) {
      return;
    }
    try {
      const r = await api.dedupeProducts(lineId);
      showToast(
        `已去重：合并 ${r.groups} 组，删除 ${r.products_removed} 条重复产品，归并 ${r.specs_moved} 行规格参数`,
      );
      reload();
      onChanged?.();
    } catch (err: unknown) {
      showToast(`去重失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [lineId, reload, onChanged, showToast]);

  /**
   * 能力重复合并（M3）：同 `产品线 + 领域 + 能力名` 只留描述最长的一行
   *
   * 先 GET 预览再确认：用户点按钮时就知道会合并几组，避免"点完才发现删了东西"。
   */
  const handleMergeDuplicates = useCallback(async () => {
    try {
      const preview = await api.libraryDedupePreview(lineId);
      if (preview.merged.length === 0) {
        showToast("没有重复能力，无需合并");
        return;
      }
      const ok = window.confirm(
        `同产品线+领域+能力名的 ${preview.merged.length} 组重复能力，将各保留描述最长的一行，删除其余行。继续？`,
      );
      if (!ok) return;
      const report = await api.libraryDedupe(lineId);
      showToast(`合并 ${report.merged.length} 组重复能力`);
      reload();
      onChanged?.();
    } catch (err: unknown) {
      showToast(`合并失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [lineId, reload, onChanged, showToast]);

  if (status === "loading") {
    return (
      <div className="pnl">
        <div className="pnl-h"><div><h2>{label}</h2><p>加载中…</p></div></div>
        <div className="pnl-b"><div className="loading-strip" role="status" aria-label="加载中" /></div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="pnl">
        <div className="pnl-h">
          <div><h2>{label}</h2><p>数据加载失败</p></div>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
        <div className="pnl-b"><div className="empty-state"><div className="empty-state-title">加载失败</div><div className="empty-state-desc">{error}</div></div></div>
      </div>
    );
  }

  return (
    <div className="pnl">
      <div className="pnl-h">
        <div>
          <h2>{label}</h2>
          <p>
            {rows.length} 行
            {drafts.length > 0 ? ` · ${drafts.length} 行待填写` : ""}
            （单元格点击即改，自动保存并触发下游待重算标记）
          </p>
        </div>
        {headerExtra}

        {code === "M1" && (
          <button className="btn" type="button" onClick={() => void handleDedupe()}>
            产品去重
          </button>
        )}
        {code === "M3" && (
          <button
            className="btn"
            type="button"
            title="同产品线+领域+能力名的重复行只保留描述最长的一行"
            onClick={() => void handleMergeDuplicates()}
          >
            合并重复
          </button>
        )}
        {(hiddenEmptyKeys.length > 0 || showEmptyCols) && (
          <button
            className="btn"
            type="button"
            onClick={() => setShowEmptyCols((v) => !v)}
            title="整列一个值都没有的选填列，默认收起来；点这里展开"
          >
            {showEmptyCols ? "收起空列" : `显示空列（${hiddenEmptyKeys.length}）`}
          </button>
        )}
        <button className="btn" type="button" onClick={() => void handleAdd()}>新增行</button>
      </div>
      <div className="pnl-b flush">
        {code === "M4" && (
          <p className="provider-item-meta" style={{ margin: "0 0 var(--s2)" }}>
            「不做」结论必须能指到材料哪一页：依据与来源两列都要有值；来源不可定位的历史行不在此表显示（数据未删除，补来源后可重现）。
          </p>
        )}
        {code === "M2" && (productRows.data?.length ?? 0) > 0 && (
          <div className="model-discover-row" style={{ marginBottom: "var(--s2)" }}>
            <span className="provider-item-meta">按产品出表：</span>
            <select
              className="settings-select"
              value={productPick || firstProductId}
              onChange={(e) => setProductPick(e.target.value)}
              aria-label="选择产品"
            >
              {(productRows.data ?? []).map((p) => {
                const row = p as Record<string, unknown>;
                return (
                  <option key={String(row.id)} value={String(row.id)}>
                    {String(row.model ?? row.id)}
                  </option>
                );
              })}
              <option value="__all__">全部产品（合表）</option>
            </select>
          </div>
        )}
        {rows.length === 0 && (
          <p className="provider-item-meta" style={{ margin: "0 0 var(--s2)" }}>
            {code === "M2" && !firstProductId
              ? "先在产品清单新增一个产品，再在这里补它的规格；下面空白行可直接填写。"
              : "本表还没有内容：直接在下面空白行填写。填满必填列会自动保存，没填完的行不会进库。"}
          </p>
        )}
        <SceneTable
          columns={columns}
          data={displayRows}
          storageKey={code}
          onRowClick={handleRowClick}
          onCellChange={(rowIndex, key, value) => void handleCellChange(rowIndex, key, value)}
        />
      </div>
    </div>
  );
};

/* ═══ 本库已导入的资料（按文件删，变更表 #156） ═══ */

/** 表号 → 行数 的紧凑文案（如 `M1×3、O1×1`） */
function tablesSummary(tables: Record<string, number>): string {
  return Object.entries(tables)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, n]) => `${code}×${n}`)
    .join("、");
}

/**
 * 早期上传落库的是临时文件名（`ingest-<时间戳>-<序号>.<ext>`）
 *
 * 与服务端 `isLegacyTempSource` 同口径：前端只用来决定"要不要给一句说明"，
 * 判定本身不参与删除（删除永远按全等文件名走服务端）。
 */
const LEGACY_TEMP_NAME_RE = /^ingest-\d+-\d+\.[A-Za-z0-9]+$/;

/**
 * 本库已导入的资料文件清单（文件名 + 行数，逐项可删）
 *
 * 为什么单独一个面板：用户原话「只能选择，不能删除」——原来的资料区只能看行、不能按来源
 * 清一份材料。这里按来源文件聚合（服务端算，口径与 ingest 的 `文件名:页码` 同源），
 * 一次把一份材料在整个库里落的所有行删掉。
 *
 * 刻意**不用表格**：主表（M1–M4 + M6/O）的列语义是逐格编辑，而这里是"一条文件一行"的清单，
 * 用条目更像列表也更省横向空间（同 #149「右栏不用表格」的口径）。
 */
/** 上传状态区（进度 / 跳过清单）的容器 id：头部固定高，状态不能待在头部（变更表 #157） */
const LIB_UPLOAD_STATUS_ID = "lib-upload-status-slot";

/**
 * 联网核验明细表格（表 / 行摘要 / 状态 / 权威 / 来源 / 说明）
 *
 * 来源是可点开的真实链接（title 显示完整 URL）；没有来源时给占位符，
 * 不把"未核实"写成"无问题"。
 */
const VerificationTable: React.FC<{ rows: VerifyDisplayRow[] }> = ({ rows }) => {
  if (rows.length === 0) return <div className="mat-note">还没有核验记录。</div>;
  return (
    <div className="mat-audit-table-wrap">
      <table className="mat-audit-table">
        <thead>
          <tr>
            <th>表</th>
            <th>行摘要</th>
            <th>状态</th>
            <th>权威</th>
            <th>来源</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.table}-${index}`}>
              <td>{row.table}</td>
              <td>{row.summary}</td>
              <td>{row.status}</td>
              <td>{row.authority}</td>
              <td>
                {row.sources.length === 0
                  ? "—"
                  : row.sources.map((source, index) => (
                      <span key={source.url}>
                        {index > 0 ? "、" : ""}
                        <a href={source.url} target="_blank" rel="noreferrer" title={source.url}>
                          {sourceLabel(source)}
                        </a>
                      </span>
                    ))}
              </td>
              <td>{row.note || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const LibraryMaterialsPanel: React.FC<{
  lineId: string;
  /** 行数据变化（入库/编辑/删行）后由父级 +1，触发本面板重取 */
  reloadTick: number;
  onChanged: () => void;
}> = ({ lineId, reloadTick, onChanged }) => {
  const { showToast } = useToast();
  const { status, data, error, reload } = useAsync(
    () => api.libraryMaterials(lineId),
    [lineId, reloadTick],
  );

  /**
   * 联网核验：GET 只读统计 → POST 分批核验（每次 ≤20 行）直到 remaining = 0
   *
   * 单批可能有 T1/T2 命中，也可能全是"未核实"；所有批次结果累加后一次 toast，
   * 避免每 20 行弹一条把用户别的提示冲掉。
   */
  const verification = useAsync(() => api.libraryVerification(lineId), [lineId, reloadTick]);
  const [verifying, setVerifying] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState("");
  const dedupePreview = useAsync(() => api.libraryDedupePreview(lineId), [lineId, reloadTick]);

  const handleVerify = useCallback(async () => {
    setVerifying(true);
    const totals = { checked: 0, upgraded: 0, conflict: 0, unverified: 0 };
    try {
      let batch = 0;
      for (;;) {
        const report = await api.libraryVerify({ productLineId: lineId, limit: 20 });
        batch += 1;
        totals.checked += report.checked;
        totals.upgraded += report.upgraded;
        totals.conflict += report.conflict;
        totals.unverified += report.unverified;
        const finished = report.checked === 0 || report.remaining <= 0;
        setVerifyProgress(
          finished
            ? ""
            : `已核验 ${totals.checked} 行，剩余 ${report.remaining} 行（第 ${batch} 批）`,
        );
        if (finished) break;
        showToast(`联网核验第 ${batch} 批：已核验 ${totals.checked} 行，剩余 ${report.remaining} 行`);
        // 防御：服务端 remaining 异常时最多连续 20 批，剩下的再点一次继续
        if (batch >= 20) {
          showToast("已连续核验 20 批，先停一下；可再次点击「联网核验」继续");
          break;
        }
      }
      showToast(verifyDoneText(totals));
      verification.reload();
      onChanged();
    } catch (err: unknown) {
      showToast(`核验失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVerifying(false);
      setVerifyProgress("");
    }
  }, [lineId, verification, onChanged, showToast]);

  const items = data ?? [];
  const totalRows = items.reduce((sum, g) => sum + g.rows, 0);
  const hasLegacyNames = items.some((g) => LEGACY_TEMP_NAME_RE.test(g.file));

  const handleDeleteFile = useCallback(
    async (item: ApiMaterialFile) => {
      // 二次确认说清三件事：删哪个文件、删多少行、不可恢复。
      // 下游待重算只在"这份资料真被场景分析用过"时才发生，所以写成条件句、不打包票。
      const ok = window.confirm(
        `删除资料文件「${item.file}」？\n\n将从本库删除它的 ${item.rows} 行资料（${tablesSummary(item.tables)}），删掉后不可恢复。\n若其中产品行的规格参数来自别的文件，那些规格行会一并删除（删完会报数）。\n若这些资料已被某个场景的分析用过，对应阶段会被标记为待重算。`,
      );
      if (!ok) return;
      try {
        const r = await api.deleteLibraryMaterial(lineId, item.file);
        showToast(
          `已删除「${r.file}」${r.deleted} 行` +
            (r.cascaded_specs ? `（含 ${r.cascaded_specs} 行连带规格）` : ""),
        );
        reload();
        onChanged();
      } catch (err: unknown) {
        showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [lineId, reload, onChanged, showToast],
  );

  if (status === "loading") {
    return (
      <div className="pnl">
        <div className="pnl-h"><div><h2>本库已导入的资料</h2><p>加载中…</p></div></div>
        <div className="pnl-b"><div className="loading-strip" role="status" aria-label="加载中" /></div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="pnl">
        <div className="pnl-h">
          <div><h2>本库已导入的资料</h2><p>加载失败</p></div>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
        <div className="pnl-b"><div className="empty-state"><div className="empty-state-title">加载失败</div><div className="empty-state-desc">{error}</div></div></div>
      </div>
    );
  }

  return (
    <div className="pnl">
      <div className="pnl-h">
        <div>
          <h2>本库已导入的资料</h2>
          <p>按来源文件聚合；删除即删掉该文件在本库落的全部行</p>
        </div>
        <span className="badge success">{items.length} 个文件 · {totalRows} 行</span>
      </div>
      <div className="pnl-b">
        <div className="mat-audit">
          <div className="mat-audit-head">
            <span className="mat-audit-summary">
              {verification.data
                ? verificationSummaryText(verification.data)
                : verification.status === "error"
                  ? `联网核验：读取失败（${verification.error ?? "未知原因"}）`
                  : "联网核验：加载中…"}
            </span>
            <button
              className="btn btn-sm"
              type="button"
              disabled={verifying}
              title="联网检索核验关键事实；T1/T2 独立来源命中才把证据级升为 A"
              onClick={() => void handleVerify()}
            >
              {verifying ? "核验中…" : "联网核验"}
            </button>
          </div>
          <div className="mat-note">
            可选：联网核对已导入资料里的型号、能力、报价、证书号。只有 T1/T2
            独立来源命中才把证据升为 A；T3/T4 或检索失败只记「未核实」，不降级；单价对不上记「有冲突」。
          </div>
          {verifying && verifyProgress && <div className="mat-note">{verifyProgress}</div>}
          {verification.data && verification.data.total > 0 && (
            <>
              <div className="mat-audit-actions">
                <button
                  className="btn btn-sm"
                  type="button"
                  aria-pressed={verifyOpen}
                  onClick={() => setVerifyOpen((cur) => !cur)}
                >
                  {verifyOpen ? "收起明细" : `看明细（${verification.data.total}）`}
                </button>
              </div>
              {verifyOpen && <VerificationTable rows={verificationRows(verification.data.details)} />}
            </>
          )}
          {dedupePreview.data && dedupePreview.data.merged.length > 0 && (
            <div className="mat-note">{dedupePreviewText(dedupePreview.data)}</div>
          )}
        </div>
        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">本库还没有导入资料</div>
            <div className="empty-state-desc">上传材料解析入库后，这里按文件列出各自的名称与行数</div>
          </div>
        ) : (
          <ul className="mat-list">
            {items.map((item) => (
              <li className="mat-item" key={item.file}>
                <span className="mat-name" title={item.file}>{item.file}</span>
                <span className="mat-meta">
                  {item.rows} 行
                  {tablesSummary(item.tables) ? `（${tablesSummary(item.tables)}）` : ""}
                </span>
                {item.deletable ? (
                  <button className="btn btn-sm" type="button" onClick={() => void handleDeleteFile(item)}>
                    删除
                  </button>
                ) : (
                  <span className="badge warning" title="手工补录的行没有来源标注，只能逐行删除">
                    逐行删
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {hasLegacyNames && (
          <div className="mat-note">
            带 ingest- 数字的是早期上传留下的临时文件名（当时没记原始名，无法还原），按行数与所属表可以判断是哪一批材料。
          </div>
        )}
      </div>
    </div>
  );
};

/* ═══ 视图主体 ═══ */

type TabKey = "materials" | "M1" | "M2" | "M3" | "M4" | "M6" | "O";

const TABS: { key: TabKey; label: string }[] = [
  { key: "materials", label: "已导入资料" },
  ...M_TABS.map((t) => ({ key: t.code as TabKey, label: t.label })),
  { key: "O", label: "可选材料" },
];

export const RealLibraryView: React.FC<{
  lines: ApiProductLine[];
  /** 资料变化后通知父级刷新侧栏计数 */
  onChanged?: () => void;
  /** 行点击上报右栏行详情；null=清空（切表/切产品线时） */
  onRowSelect?: (detail: RowDetail | null) => void;
}> = ({ lines, onChanged, onRowSelect }) => {
  const { showToast } = useToast();
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [tab, setTab] = useState<TabKey>("M1");
  const [reloadTick, setReloadTick] = useState(0);

  /* 产品线列表变化时保证选中有效 */
  useEffect(() => {
    if (!lines.some((l) => l.id === lineId)) setLineId(lines[0]?.id ?? "");
  }, [lines, lineId]);

  /* 切表 / 切产品线：清空右栏行详情 */
  useEffect(() => {
    onRowSelect?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, lineId]);

  const handleNewLine = useCallback(async () => {
    const name = await promptText({ title: "新建产品线", message: "请输入名称", placeholder: "例如：鸿蒙生态产品线", okText: "创建" });
    if (!name?.trim()) return;
    try {
      const created = await api.createProductLine(name.trim());
      onChanged?.();
      setLineId(created.id);
      showToast(`产品线「${created.name}」已创建`);
    } catch (err: unknown) {
      showToast(`创建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [onChanged, showToast]);

  /** 重命名产品线（资料库） */
  const handleRenameLine = useCallback(async () => {
    const cur = lines.find((l) => l.id === lineId);
    const name = await promptText({ title: "重命名产品资料库", message: "请输入新名称", defaultValue: cur?.name ?? "", okText: "重命名" });
    if (!name?.trim() || name.trim() === cur?.name) return;
    try {
      await api.renameProductLine(lineId, name.trim());
      onChanged?.();
      showToast(`已重命名为「${name.trim()}」`);
    } catch (err: unknown) {
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [lines, lineId, onChanged, showToast]);

  /**
   * 删除资料库（产品线）（变更表 #156）
   *
   * 入口只对「可删」的库可用（空线 + 非通用库）；真正的闸门在服务端（非空 409、通用库 409、
   * 仍被活场景占用 409），前端把服务端给的中文原因原样弹出来，不自己编。
   */
  const handleDeleteLine = useCallback(async () => {
    const cur = lines.find((l) => l.id === lineId);
    if (!cur) return;
    // 变更表 #158：按钮原来在"不可删"时是 disabled——用户点它**毫无反应**，
    // 只能靠 title 猜到原因（真机反馈「点击删除资料库目前是没有反应的」）。
    // 改成永远可点，点了先把"为什么现在不能删"说清楚。
    const rows = cur.row_counts ? Object.values(cur.row_counts).reduce((a, b) => a + b, 0) : 0;
    if (rows > 0) {
      showToast(`「${cur.name}」还有 ${rows} 行资料，先删资料再删库`);
      return;
    }
    /* 空私有库可删（v3.0，变更表 #160）：删掉后该场景回到"只用基础库"的状态，
       下次在场景里上传材料时会自动再建一个——所以确认文案说清楚"不丢资料"。 */
    const ok = window.confirm(
      `删除资料库「${cur.name}」？\n\n该库当前 0 行资料，删掉后不可恢复。` +
        (cur.scenario_id
          ? "\n如果它是某个场景的私有库，该场景会回到只用基础库的状态；下次在场景里上传材料时会自动重建。"
          : ""),
    );
    if (!ok) return;
    try {
      await api.deleteProductLine(lineId);
      showToast(`资料库「${cur.name}」已删除`);
      // 删完刷新产品线快照（选中项由 useEffect 兜底落到第一条）
      onChanged?.();
    } catch (err: unknown) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [lines, lineId, onChanged, showToast]);

  /** 可选材料当前查看的类别（五类共用面板） */
  const [oPick, setOPick] = useState<string>("O1");

  const renderBody = () => {
    if (!lineId) {
      return (
        <div className="pnl">
          <div className="pnl-b">
            <div className="empty-state">
              <div className="empty-state-title">还没有产品线</div>
              <div className="empty-state-desc">资料按产品线组织，先创建一条产品线再上传材料</div>
              <button className="btn primary" type="button" onClick={() => void handleNewLine()}>
                新建产品线
              </button>
            </div>
          </div>
        </div>
      );
    }
    switch (tab) {
      case "materials":
        return (
          <LibraryMaterialsPanel
            lineId={lineId}
            reloadTick={reloadTick}
            onChanged={() => {
              setReloadTick((t) => t + 1);
              onChanged?.();
            }}
          />
        );
      case "O":
        return (
          <TablePanel
            key={`${oPick}-${lineId}`}
            code={oPick}
            label={O_LABELS[oPick] ?? "可选材料"}
            lineId={lineId}
            optional
            reloadTick={reloadTick}
            onRowSelect={onRowSelect}
            onChanged={() => {
              setReloadTick((t) => t + 1);
              onChanged?.();
            }}
            headerExtra={
              <select
                className="settings-select"
                value={oPick}
                onChange={(e) => setOPick(e.target.value as typeof oPick)}
                aria-label="选择可选材料类别"
              >
                {O_CODES.map((c) => (
                  <option key={c} value={c}>
                    {O_LABELS[c]}
                  </option>
                ))}
              </select>
            }
          />
        );
      default:
        return (
          <TablePanel
            key={`${tab}-${lineId}`}
            code={tab}
            label={TABS.find((t) => t.key === tab)?.label ?? tab}
            lineId={lineId}
            reloadTick={reloadTick}
            onRowSelect={onRowSelect}
            onChanged={() => {
              setReloadTick((t) => t + 1);
              onChanged?.();
            }}
          />
        );
    }
  };

  const activeLine = lines.find((l) => l.id === lineId);
  const totalRows = activeLine?.row_counts
    ? Object.values(activeLine.row_counts).reduce((a, b) => a + b, 0)
    : 0;
  /**
   * 删除资料库的可用条件（变更表 #157 修正）：只看"还有没有行"。
   *
   * 原来还加了"通用库禁删"（`scenario_id` 为空即禁），可库里没有"通用库"标记——用户自己
   * 新建的库同样没场景，于是永远删不掉。真正该拦的是"还有行"（删了就把分析依据抽走）与
   * "仍被活场景引用"，后者只有服务端知道（勾选集合不在前端），所以按钮先放开、
   * 由服务端 409 给出准确原因（前端把它如实弹出来）。
   */
  /* 只有"没选库"才禁用——其余情况一律可点，点了给明确回应（变更表 #158） */
  const canDeleteLine = Boolean(activeLine);
  const deleteLineHint = !activeLine
    ? "先选择一条资料库"
    : totalRows > 0
      ? `该资料库还有 ${totalRows} 行资料，先删资料再删库`
      : "删除该资料库（不可恢复；仍被场景引用的库会被服务端拦下并说明原因）";

  return (
    <>
      <div className="pgh">
        <div className="pgh-left">
          <div className="pgt">产品资料库</div>
          {lines.length > 0 ? (
            <>
              <select
                className="btn"
                aria-label="选择产品线"
                value={lineId}
                onChange={(e) => setLineId(e.target.value)}
              >
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.scenario_id ? "（场景专属）" : ""}
                  </option>
                ))}
              </select>
              {/* 故障清单 #70：「新建产品线」原来只在空态出现——一旦有库，想建第二条线没有入口。
                  补回工具栏入口，与重命名/删除并排。 */}
              <button className="btn btn-sm" type="button" onClick={() => void handleNewLine()}>
                新建产品线
              </button>
              <button className="btn btn-sm" type="button" onClick={() => void handleRenameLine()}>
                重命名
              </button>
              <button
                className="btn btn-sm"
                type="button"
                disabled={!canDeleteLine}
                title={deleteLineHint}
                onClick={() => void handleDeleteLine()}
              >
                删除资料库
              </button>
            </>
          ) : (
            <span className="badge warning">无产品线</span>
          )}
          {activeLine && <span className="badge success">{totalRows} 行资料</span>}
        </div>
        <div className="pga">
          <MaterialUpload
            lineId={lineId}
            /* 状态区搬到内容区顶部：头部固定 48px，进度条挤在这里会压到 Tab 栏（变更表 #157） */
            statusSlotId={LIB_UPLOAD_STATUS_ID}
            onDone={() => {
              setReloadTick((t) => t + 1);
              onChanged?.();
            }}
          />
        </div>
      </div>

      <div className="stabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`stab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ws">
        {/* 上传进度 / 跳过清单的落点：放在可滚动的内容区里，多长都不挤头部 */}
        <div id={LIB_UPLOAD_STATUS_ID} className="lib-upload-status" />
        {renderBody()}
      </div>
    </>
  );
};
