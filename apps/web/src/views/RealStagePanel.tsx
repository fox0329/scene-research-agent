import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  advanceStageStream,
  type ApiStagePanel,
  type ApiStageRow,
  type AdviceLevelApi,
} from "../api";
import { useAsync } from "../hooks/useAsync";
import { SceneTable, type ColumnDef } from "../components/SceneTable";
import { AdviceCard } from "../components/AdviceCard";
import { useToast } from "../components/Toast";
import type { DecisionSnapshot } from "../components/decision-snapshot";

/**
 * 联真阶段面板（M5-T5.3）
 * - 数据源：GET /projects/:id/stages/:stage（rows/gates/advice）
 * - 覆盖 §4.3 三态：加载 / 空态（可发起阶段分析）/ 降级（错误+重试）
 * - 单元格编辑落库：PATCH stage-data（行 JSON 合并，source_type → 用户确认）
 * - 阶段分析：POST advance SSE，进度事件实时上屏，完成后自动刷新
 * - 决策快照（T5.6）：rows/gates/advice 聚合后冒泡给右栏 DecisionPanel
 */

interface RealStagePanelProps {
  projectId: string;
  stage: number;
  stageLabel: string;
  /** 数据变化后通知父级（刷新项目列表/失效横幅） */
  onChanged?: () => void;
  /** 右栏决策支撑快照变化（null=加载中/不可用） */
  onDecisionSnapshot?: (snap: DecisionSnapshot | null) => void;
}

/** 表编号 → 中文说明（面板小标题） */
const TABLE_HINTS: Record<string, string> = {
  M1: "产品型号清单",
  M2: "规格参数",
  M3: "能力清单",
  M4: "边界声明（不做什么）",
  M5: "已知限制",
  M6: "成本单价",
};

function tableTitle(code: string): string {
  return TABLE_HINTS[code] ?? "阶段分析表";
}

/** 行对象键序合并（按首次出现顺序取并集） */
function unionKeys(rows: ApiStageRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.row)) {
      if (!seen.has(k)) seen.add(k);
    }
  }
  return [...seen];
}

const LEVEL_MAP: Record<AdviceLevelApi, AdviceLevelApi> = {
  建议通过: "建议通过",
  建议有条件通过: "建议有条件通过",
  建议不通过: "建议不通过",
};

export const RealStagePanel: React.FC<RealStagePanelProps> = ({
  projectId,
  stage,
  stageLabel,
  onChanged,
  onDecisionSnapshot,
}) => {
  const { status, data, error, reload } = useAsync<ApiStagePanel>(
    () => api.stagePanel(projectId, stage),
    [projectId, stage],
  );
  const { showToast } = useToast();

  /* 流式分析状态 */
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  /* 单元格编辑：本地即时更新 + 落库 */
  const [patched, setPatched] = useState<Record<string, ApiStageRow>>({});
  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows.map((r) => patched[r.id] ?? r);
  }, [data, patched]);

  const groups = useMemo(() => {
    const map = new Map<string, ApiStageRow[]>();
    for (const r of rows) {
      const list = map.get(r.table_code) ?? [];
      list.push(r);
      map.set(r.table_code, list);
    }
    return [...map.entries()];
  }, [rows]);

  /* 决策支撑快照：聚合真实 rows/gates/advice（hooks 须在条件 return 之前） */
  const snapshot = useMemo<DecisionSnapshot | null>(() => {
    if (!data) return null;
    const gates = data.gates;
    const tally = (pick: (r: ApiStageRow) => string | null | undefined) => {
      const dist: Record<string, number> = {};
      for (const r of rows) {
        const k = pick(r);
        if (k) dist[k] = (dist[k] ?? 0) + 1;
      }
      return dist;
    };
    return {
      stage,
      stageLabel,
      advice: data.advice,
      gateTotal: gates.length,
      gatePassed: gates.filter((g) => g.result === "通过").length,
      failedGates: gates
        .filter((g) => g.result !== "通过")
        .map((g) => ({ itemNo: g.item_no, title: g.title, detail: g.detail, result: g.result })),
      rowCount: rows.length,
      userConfirmed: rows.filter((r) => r.source_type === "用户确认").length,
      staleCount: rows.filter((r) => r.is_stale).length,
      evidenceDist: tally((r) => r.evidence_level),
      authorityDist: tally((r) => r.source_authority),
    };
  }, [data, rows, stage, stageLabel]);

  useEffect(() => {
    onDecisionSnapshot?.(snapshot);
    return () => onDecisionSnapshot?.(null);
  }, [snapshot, onDecisionSnapshot]);
  const handleCellChange = useCallback(
    async (row: ApiStageRow, key: string, value: string) => {
      if (String(row.row[key] ?? "") === value) return;
      try {
        const updated = await api.patchStageCell(projectId, row.id, key, value);
        setPatched((prev) => ({ ...prev, [row.id]: updated }));
        onChanged?.();
      } catch (err: unknown) {
        showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, onChanged, showToast],
  );

  const startAnalysis = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setStreamLines(["已发起阶段分析…"]);
    try {
      for await (const ev of advanceStageStream(projectId, stage)) {
        if (ev.type === "progress") {
          setStreamLines((prev) => [...prev, String(ev.text ?? "分析中…")].slice(-8));
        } else if (ev.type === "text") {
          setStreamLines((prev) => {
            const last = prev[prev.length - 1];
            if (last && !last.startsWith("【")) {
              return [...prev.slice(0, -1), last + String(ev.text ?? "")].slice(-8);
            }
            return [...prev, String(ev.text ?? "")].slice(-8);
          });
        } else if (ev.type === "error") {
          setStreamLines((prev) => [...prev, `【错误】${String(ev.message ?? "")}`].slice(-8));
        } else if (ev.type === "done") {
          setStreamLines((prev) => [...prev, "【完成】分析结果已落库"].slice(-8));
          reload();
          onChanged?.();
        }
      }
    } catch (err: unknown) {
      setStreamLines((prev) => [
        ...prev,
        `【错误】${err instanceof Error ? err.message : String(err)}`,
      ]);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [projectId, stage, reload, onChanged]);

  const decide = useCallback(
    async (action: "继续" | "补充" | "停止") => {
      try {
        const project = await api.decide(projectId, stage, action);
        showToast(
          action === "继续"
            ? `已确认继续，项目进入阶段 ${project.current_stage}`
            : action === "补充"
              ? "已记录：继续补充材料"
              : "已记录：本阶段停止推进",
        );
        onChanged?.();
      } catch (err: unknown) {
        showToast(`决定提交失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, stage, showToast, onChanged],
  );

  /* ── 三态渲染 ── */

  if (status === "loading") {
    return (
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>阶段 {stage} · {stageLabel}</h2>
            <p>正在加载分析结果…</p>
          </div>
        </div>
        <div className="pnl-b">
          <div className="loading-strip" role="status" aria-label="加载中" />
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="pnl">
        <div className="pnl-h">
          <div>
            <h2>阶段 {stage} · {stageLabel}</h2>
            <p>后端连接失败，本阶段数据不可用</p>
          </div>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
        <div className="pnl-b">
          <div className="empty-state">
            <div className="empty-state-title">加载失败</div>
            <div className="empty-state-desc">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  const gates = data?.gates ?? [];
  const passed = gates.filter((g) => g.result === "通过").length;
  const advice = data?.advice ?? null;
  const staleCount = rows.filter((r) => r.is_stale).length;

  return (
    <>
      {/* 分析进度流（仅运行/运行后本阶段有输出时显示） */}
      {streamLines.length > 0 && (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>阶段分析进度</h2>
              <p>{running ? "分析进行中，流式输出…" : "本阶段分析输出"}</p>
            </div>
          </div>
          <div className="pnl-b">
            <ul className="cl">
              {streamLines.map((line, i) => (
                <li key={i} className="cli">
                  <div>
                    <div className="cd">{line}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 表格组：按 table_code 分组，动态列，逐格可编辑落库 */}
      {groups.map(([code, groupRows]) => {
        const columns: ColumnDef<Record<string, unknown>>[] = unionKeys(groupRows).map(
          (key) => ({ key, label: key, editable: true }),
        );
        return (
          <div className="pnl" key={code}>
            <div className="pnl-h">
              <div>
                <h2>表 {code} · {tableTitle(code)}</h2>
                <p>{groupRows.length} 行（单元格点击即改，改后自动保存）</p>
              </div>
              {groupRows.some((r) => r.is_stale) && (
                <span className="badge warning">{groupRows.filter((r) => r.is_stale).length} 行待重算</span>
              )}
            </div>
            <div className="pnl-b flush">
              <SceneTable
                columns={columns}
                data={groupRows.map((r) => ({ ...r.row, __id: r.id }))}
                onCellChange={(rowIndex, key, value) => {
                  const row = groupRows[rowIndex];
                  if (row) void handleCellChange(row, key, value);
                }}
              />
            </div>
          </div>
        );
      })}

      {/* 质量关清单 */}
      {gates.length > 0 && (
        <div className="pnl">
          <div className="pnl-h">
            <div>
              <h2>质量关 · 阶段 {stage}</h2>
              <p>逐项检查结果（判定来自领域层，落库可审计）</p>
            </div>
            <span className={`badge ${passed === gates.length ? "success" : "warning"}`}>
              {passed}/{gates.length} 通过
            </span>
          </div>
          <div className="pnl-b">
            <ul className="cl">
              {gates.map((g) => (
                <li key={g.id} className="cli">
                  {g.result === "通过" ? (
                    <svg className="ci pass" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  ) : (
                    <svg className="ci fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  )}
                  <div>
                    <div className="ct">{g.item_no} {g.title}（{g.result}）</div>
                    {g.detail && <div className="cd">{g.detail}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 建议卡（领域层三档建议）或空态（可发起分析） */}
      {advice ? (
        <AdviceCard
          level={LEVEL_MAP[advice]}
          reason={`阶段 ${stage}「${stageLabel}」质量关 ${passed}/${gates.length} 通过${staleCount ? `，${staleCount} 行资料待重算` : ""}`}
          risks={gates.filter((g) => g.result !== "通过").map((g) => `${g.title}：${g.detail || g.result}`)}
          satisfied={passed}
          total={Math.max(gates.length, 1)}
          onNext={() => void decide("继续")}
          onSupplement={() => void decide("补充")}
          onStop={() => void decide("停止")}
        />
      ) : (
        <div className="pnl">
          <div className="pnl-b">
            <div className="empty-state">
              <div className="empty-state-title">本阶段还没有分析结果</div>
              <div className="empty-state-desc">
                上传资料后发起阶段分析，AI 产出将逐表落库并给出质量关建议
              </div>
              <button className="btn primary" type="button" onClick={() => void startAnalysis()} disabled={running}>
                {running ? "分析进行中…" : "开始本阶段分析"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 已有结果时可重算 */}
      {advice && !running && (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 var(--s4) var(--s4)" }}>
          <button className="btn" type="button" onClick={() => void startAnalysis()}>
            重算本阶段
          </button>
        </div>
      )}
    </>
  );
};
