import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ingestStream,
  type ApiProductLine,
  type ApiQualitySummary,
} from "../api";
import { useAsync } from "../hooks/useAsync";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { useToast } from "../components/Toast";

/**
 * 联真资料库视图（M5-T5.4）
 * - 产品线切换 / 质量总评（六维+完成度，领域层计算）/ M1-M6 / O 可选材料 / 补充提醒
 * - 单元格编辑 → PATCH library rows（source_type 置"用户确认"，F3 失效由服务端内联处理）
 * - 上传材料 → multipart ingest + SSE 进度流（解析→落库→done 行数）
 * - §4.3 三态：加载 / 空态（无产品线、无行）/ 降级（错误+重试）
 */

/** 行数据中不展示的内部列 */
const HIDDEN_KEYS = new Set(["id", "created_at", "updated_at", "product_line_id"]);

const M_TABS: { code: string; label: string }[] = [
  { code: "M1", label: "M1 产品清单" },
  { code: "M2", label: "M2 规格书" },
  { code: "M3", label: "M3 能力清单" },
  { code: "M4", label: "M4 边界声明" },
  { code: "M5", label: "M5 已知限制" },
  { code: "M6", label: "M6 内部费率" },
];

const O_CODES = ["O1", "O2", "O3", "O4", "O5", "O6"];

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
}

const TablePanel: React.FC<TablePanelProps> = ({
  code,
  label,
  lineId,
  optional,
  reloadTick,
  onChanged,
}) => {
  const { showToast } = useToast();
  const { status, data, error, reload } = useAsync(
    () => api.libraryTable(code, lineId),
    [code, lineId, reloadTick],
  );

  /* O 表把 payload 展开为行字段；M 表原样；值统一转字符串便于编辑与展示 */
  const rows = useMemo(() => {
    if (!data) return [];
    return data.map((r) => {
      if (optional) {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        const flat: Record<string, unknown> = { category: r.category, __id: r.id };
        for (const [k, v] of Object.entries(payload)) flat[k] = cellText(v);
        return flat;
      }
      const flat: Record<string, unknown> = { __id: r.id };
      for (const [k, v] of Object.entries(r)) {
        if (!HIDDEN_KEYS.has(k)) flat[k] = cellText(v);
      }
      return flat;
    });
  }, [data, optional]);

  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (k !== "__id") seen.add(k);
      }
    }
    const cols: ColumnDef<Record<string, unknown>>[] = [...seen].map((key) => ({
      key,
      label: key,
      editable: true,
    }));
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
        <button className="btn" type="button" onClick={() => void handleAdd()}>新增行</button>
      </div>
      <div className="pnl-b flush">
        {rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">本表暂无资料</div>
            <div className="empty-state-desc">上传材料解析入库，或点击"新增行"手工补录</div>
          </div>
        ) : (
          <SceneTable
            columns={columns}
            data={rows}
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
}> = ({ lines, onChanged }) => {
  const { showToast } = useToast();
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [tab, setTab] = useState<TabKey>("quality");
  const [reloadTick, setReloadTick] = useState(0);
  const [progress, setProgress] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /* 产品线列表变化时保证选中有效 */
  useEffect(() => {
    if (!lines.some((l) => l.id === lineId)) setLineId(lines[0]?.id ?? "");
  }, [lines, lineId]);

  const summary = useAsync<ApiQualitySummary | null>(
    () => (lineId ? api.qualitySummary(lineId) : Promise.resolve(null)),
    [lineId],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      if (!lineId) {
        showToast("请先创建产品线");
        return;
      }
      setUploading(true);
      setProgress([`上传 ${file.name}…`]);
      try {
        for await (const ev of ingestStream(file, lineId)) {
          if (ev.type === "progress") {
            setProgress((prev) => [...prev, String(ev.text ?? "处理中…")].slice(-8));
          } else if (ev.type === "done") {
            setProgress((prev) => [
              ...prev,
              `【完成】入库 ${String(ev.rows_inserted ?? 0)} 行`,
            ].slice(-8));
            setReloadTick((t) => t + 1);
            summary.reload();
            onChanged?.();
          } else if (ev.type === "error") {
            setProgress((prev) => [...prev, `【错误】${String(ev.message ?? "")}`].slice(-8));
          }
        }
      } catch (err: unknown) {
        setProgress((prev) => [
          ...prev,
          `【错误】${err instanceof Error ? err.message : String(err)}`,
        ]);
      } finally {
        setUploading(false);
      }
    },
    [lineId, summary, onChanged, showToast],
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
            <select
              className="btn"
              aria-label="选择产品线"
              value={lineId}
              onChange={(e) => setLineId(e.target.value)}
            >
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="badge warning">无产品线</span>
          )}
          {activeLine && <span className="badge success">{totalRows} 行资料</span>}
        </div>
        <div className="pga">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.xlsx,.pptx"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void handleUpload(f);
            }}
          />
          <button
            className="btn"
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "解析入库中…" : "上传材料"}
          </button>
        </div>
      </div>

      {progress.length > 0 && (
        <div className="stale-banner" role="status">
          <span className="badge primary">入库进度</span>
          {progress[progress.length - 1]}
        </div>
      )}

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
