import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ApiProductLine,
  type ApiQualitySummary,
} from "../api";
import { useAsync } from "../hooks/useAsync";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { MaterialUpload } from "../components/MaterialUpload";
import type { RowDetail } from "../components/RowDetailPanel";
import { useToast } from "../components/Toast";

/**
 * 联真资料库视图（M5-T5.4）
 * - 产品线切换 / 质量总评（六维+完成度，领域层计算）/ M1-M6 / O 可选材料 / 补充提醒
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
  M1: ["former_name"],
};

const M_TABS: { code: string; label: string }[] = [
  { code: "M1", label: "M1 产品清单" },
  { code: "M2", label: "M2 规格书" },
  { code: "M3", label: "M3 能力清单" },
  { code: "M4", label: "M4 边界声明" },
  { code: "M5", label: "M5 已知限制" },
  { code: "M6", label: "M6 内部费率" },
];

const O_CODES = ["O1", "O2", "O3", "O4", "O5", "O6"];

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
    inapplicable_scene: "不适用场景",
  },
  M4: {
    description: "不做的事",
    reason: "原因",
    has_plan: "有无计划",
    response: "客户要求时怎么办",
    owner: "负责人",
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
    category: "类别",
    item: "项目",
    rate: "单价",
    unit: "单位",
    standard_hours: "标准工时",
    data_source: "数据来源",
  },
  O1: { cert_name: "认证名称", cert_body: "认证机构", cert_date: "认证日期", scope: "认证范围" },
  O2: { project_name: "项目名称", client: "客户", year: "年份", scale: "规模", summary: "摘要" },
  O3: { model: "型号", price: "价格", currency: "币种", channel: "渠道", date: "日期" },
  O4: { name: "名称", version: "版本", language: "语言", url: "链接", maturity: "成熟度" },
  O5: { feature: "特性", expected_release: "预计发布", priority: "优先级" },
  O6: { partner_name: "伙伴名称", integration_type: "集成类型", maturity: "成熟度" },
};

/** 字段名 → 中文表头（未登记字段原样显示） */
function fieldLabel(code: string, key: string): string {
  return FIELD_LABELS[code]?.[key] ?? COMMON_FIELD_LABELS[key] ?? key;
}

const O_LABELS: Record<string, string> = {
  O1: "O1 认证",
  O2: "O2 案例",
  O3: "O3 价格",
  O4: "O4 SDK",
  O5: "O5 路线图",
  O6: "O6 生态",
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
}

const TablePanel: React.FC<TablePanelProps> = ({
  code,
  label,
  lineId,
  optional,
  reloadTick,
  onChanged,
  onRowSelect,
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

  const columns = useMemo(() => {
    const detailOnly = new Set(DETAIL_ONLY_KEYS[code] ?? []);
    const seen = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (k === "__id" || TRACE_SET.has(k) || detailOnly.has(k)) continue;
        seen.add(k);
      }
    }
    const cols: ColumnDef<Record<string, unknown>>[] = [...seen].map((key) => ({
      key,
      label: fieldLabel(code, key),
      editable: true,
    }));
    // 溯源四列合并为一个徽标列：只显示等级（T3·B），来源全文悬停/右栏可见
    cols.push({
      key: "__trace",
      label: "溯源",
      render: (_v, row) => (
        <span
          className="trace-badge"
          title={`来源类型：${cellText(row.source_type) || "—"}\n来源权威性：${cellText(row.source_authority) || "—"}\n证据等级：${cellText(row.evidence_level) || "—"}\n来源标注：${cellText(row.source) || "—"}`}
        >
          <span className="trace-tag">
            {[cellText(row.source_authority), cellText(row.evidence_level)].filter(Boolean).join("·") || "—"}
          </span>
        </span>
      ),
    });
    cols.push({
      key: "__ops",
      label: "操作",
      render: (_v, row) => (
        <button
          className="btn sm"
          type="button"
          onClick={() => void handleDelete(row)}
        >
          删除
        </button>
      ),
    });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const handleCellChange = useCallback(
    async (rowIndex: number, key: string, value: string) => {
      const row = rows[rowIndex];
      if (!row) return;
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
    [rows, code, optional, reload, onChanged, showToast],
  );

  const handleDelete = useCallback(
    async (row: Record<string, unknown>) => {
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

  const handleAdd = useCallback(async () => {
    const input = window.prompt(
      optional
        ? "新增行字段（JSON，整体存入 payload），例：{\"cert_name\":\"CE\",\"scope\":\"欧盟\"}"
        : "新增行字段（JSON），例：{\"name\":\"型号A\"}",
    );
    if (!input?.trim()) return;
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(input) as Record<string, unknown>;
    } catch {
      showToast("JSON 解析失败，未新增");
      return;
    }
    try {
      await api.addLibraryRow(code, lineId, values);
      reload();
      onChanged?.();
      showToast("已新增行");
    } catch (err: unknown) {
      showToast(`新增失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [code, lineId, optional, reload, onChanged, showToast]);

  /** 行点击 → 上报右栏行详情（补充字段 + 溯源全量 + 业务字段快照） */
  const handleRowClick = useCallback(
    (ri: number) => {
      const row = rows[ri];
      if (!row || !onRowSelect) return;
      const detailOnly = new Set(DETAIL_ONLY_KEYS[code] ?? []);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== "__id") fields[k] = cellText(v);
      }
      const businessFields = Object.keys(fields)
        .filter((k) => !TRACE_SET.has(k) && !detailOnly.has(k))
        .map((k) => ({ key: k, label: fieldLabel(code, k) }));
      onRowSelect({
        code,
        tableLabel: label,
        rowId: String(row.__id),
        fields,
        editableKeys: (DETAIL_ONLY_KEYS[code] ?? []).map((k) => ({
          key: k,
          label: fieldLabel(code, k),
        })),
        traceKeys: TRACE_KEYS.map((k) => ({ key: k, label: fieldLabel(code, k) })),
        traceEditable: !optional,
        businessFields,
      });
    },
    [rows, code, label, optional, onRowSelect],
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
          <p>{rows.length} 行（单元格点击即改，自动保存并触发下游待重算标记）</p>
        </div>
        {code === "M1" && (
          <button className="btn" type="button" onClick={() => void handleDedupe()}>
            产品去重
          </button>
        )}
        <button className="btn" type="button" onClick={() => void handleAdd()}>新增行</button>
      </div>
      <div className="pnl-b flush">
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
        {rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">本表暂无资料</div>
            <div className="empty-state-desc">上传材料解析入库，或点击"新增行"手工补录</div>
          </div>
        ) : (
          <SceneTable
            columns={columns}
            data={rows}
            storageKey={code}
            onRowClick={handleRowClick}
            onCellChange={(rowIndex, key, value) => void handleCellChange(rowIndex, key, value)}
          />
        )}
      </div>
    </div>
  );
};

/* ═══ 质量总评面板 ═══ */

const RATING_BADGE: Record<string, string> = { pass: "success", warn: "warning", fail: "error" };
const RATING_ICON: Record<string, string> = { pass: "✅", warn: "⚠️", fail: "❌" };

const QualityRealPanel: React.FC<{ summary: ApiQualitySummary }> = ({ summary }) => {
  const { quality, completeness } = summary;
  return (
    <>
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>质量总评</h2>
            <p>材料整体质量六维评估（领域层计算，落库可审计）</p>
          </div>
          <span className={`badge ${quality.failCount === 0 ? "success" : "warning"}`}>
            {quality.passCount}/{quality.dimensions.length} 达标
          </span>
        </div>
        <div className="pnl-b flush">
          <table>
            <thead>
              <tr><th>维度</th><th>评级</th><th>说明</th></tr>
            </thead>
            <tbody>
              {quality.dimensions.map((d) => (
                <tr key={d.dimension}>
                  <td>{d.dimension}</td>
                  <td><span className={`badge ${RATING_BADGE[d.status]}`}>{RATING_ICON[d.status]}</span></td>
                  <td>{d.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>完成度检查</h2>
            <p>8 项检查（不阻断，仅提示缺失风险）</p>
          </div>
        </div>
        <div className="pnl-b flush">
          <table>
            <thead>
              <tr><th>#</th><th>检查项</th><th>状态</th><th>缺失风险</th></tr>
            </thead>
            <tbody>
              {completeness.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.id}</td>
                  <td>{it.name}</td>
                  <td>{it.status}</td>
                  <td>{it.risk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

/* ═══ 视图主体 ═══ */

type TabKey = "quality" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "O" | "reminder";

const TABS: { key: TabKey; label: string }[] = [
  { key: "quality", label: "质量总评" },
  ...M_TABS.map((t) => ({ key: t.code as TabKey, label: t.label })),
  { key: "O", label: "O 可选材料" },
  { key: "reminder", label: "补充提醒" },
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
  const [tab, setTab] = useState<TabKey>("quality");
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

  const summary = useAsync<ApiQualitySummary | null>(
    () => (lineId ? api.qualitySummary(lineId) : Promise.resolve(null)),
    [lineId],
  );

  const handleNewLine = useCallback(async () => {
    const name = window.prompt("新建产品线 · 请输入名称");
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
    const name = window.prompt("重命名产品资料库 · 请输入新名称", cur?.name ?? "");
    if (!name?.trim() || name.trim() === cur?.name) return;
    try {
      await api.renameProductLine(lineId, name.trim());
      onChanged?.();
      showToast(`已重命名为「${name.trim()}」`);
    } catch (err: unknown) {
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [lines, lineId, onChanged, showToast]);

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
      case "quality":
        if (summary.status === "loading") {
          return (
            <div className="pnl">
              <div className="pnl-b"><div className="loading-strip" role="status" aria-label="加载中" /></div>
            </div>
          );
        }
        if (summary.status === "error" || !summary.data) {
          return (
            <div className="pnl">
              <div className="pnl-h">
                <div><h2>质量总评</h2><p>评估加载失败</p></div>
                <button className="btn" type="button" onClick={summary.reload}>重试</button>
              </div>
              <div className="pnl-b"><div className="empty-state"><div className="empty-state-title">{summary.error ?? "暂无数据"}</div></div></div>
            </div>
          );
        }
        return <QualityRealPanel summary={summary.data} />;
      case "O":
        return (
          <>
            {O_CODES.map((code) => (
              <TablePanel
                key={code}
                code={code}
                label={O_LABELS[code]}
                lineId={lineId}
                optional
                reloadTick={reloadTick}
                onRowSelect={onRowSelect}
                onChanged={() => {
                  setReloadTick((t) => t + 1);
                  onChanged?.();
                }}
              />
            ))}
          </>
        );
      case "reminder": {
        const reminders = summary.data?.completeness.reminders ?? [];
        return (
          <div className="pnl">
            <div className="pnl-h">
              <div>
                <h2>材料补充提醒</h2>
                <p>不阻断流程，仅提示缺失影响</p>
              </div>
            </div>
            <div className="pnl-b flush">
              {reminders.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-title">暂无缺失提醒</div>
                  <div className="empty-state-desc">核心材料齐备，或完成度评估尚未加载</div>
                </div>
              ) : (
                <table>
                  <thead>
                    <tr><th>对应表</th><th>缺失项</th><th>缺失影响</th><th>建议操作</th></tr>
                  </thead>
                  <tbody>
                    {reminders.map((r, i) => (
                      <tr key={i}>
                        <td>{r.table}</td>
                        <td>{r.missing}</td>
                        <td>{r.impact}</td>
                        <td>{r.suggestion ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      }
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
              summary.reload();
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

  return (
    <>
      <div className="pgh">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
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
              <button className="btn btn-sm" type="button" onClick={() => void handleRenameLine()}>
                重命名
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
            onDone={() => {
              setReloadTick((t) => t + 1);
              summary.reload();
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

      <div className="ws">{renderBody()}</div>
    </>
  );
};
