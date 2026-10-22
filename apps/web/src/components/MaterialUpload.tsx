import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ingestStream } from "../api";
import { pickSupportedFiles, describeSkipped, splitOversizeFiles, describeOversize, describeLargeFiles } from "../constants";
import { FILE_UPLOAD_LIMIT_MB } from "@scene/contract";
import { useToast } from "./Toast";
import {
  buildIngestReceipt,
  fileResultLine,
  type FileIngestResult,
  type IngestConflict,
  type IngestEvidenceSummary,
  type IngestFlaggedRow,
  type IngestSkippedRow,
} from "./ingest-receipt";

/**
 * 材料上传组件（v1.10 抽公共）：文件多选 + 整个文件夹 → 逐个解析入库 SSE 进度。
 * 资料库视图与项目工作台（场景专属资料）共用。
 */
export const MaterialUpload: React.FC<{
  /** 目标产品线（资料库）id */
  lineId: string;
  /** 入库完成后回调（刷新计数/汇总） */
  onDone?: () => void;
  /**
   * 进度与提示的挂载目标（变更表 #157）。资料库中栏的头部是**固定 48px** 的一行，
   * 进度条/跳过清单一出现就把这一行撑破、上下溢出压到 Tab 栏上（真机实测 .pga
   * 26px→96px，溢出到 top −24 / bottom +72）。所以状态区不再留在头部，而是搬到
   * 内容区顶部（可滚动，多长都不挤）。不给这个 id 时保持原样就地渲染——
   * 项目工作台把本组件放在普通面板里，没有固定高度，不需要搬。
   */
  statusSlotId?: string;
}> = ({ lineId, onDone, statusSlotId }) => {
  const { showToast } = useToast();
  const [progress, setProgress] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [skipNotice, setSkipNotice] = useState("");
  /**
   * 完成态（变更表 #158）：进度条里的【完成】汇总原来是"发出去就不管"，只能靠刷新页面消失
   * （用户：「这个提示完成了，不应该消失吗？非得要页面刷新才能消失」）。这里给完成态加一个
   * 自动收起：留 8 秒给人读完每表行数，然后自己清掉；任何时候也能点「关闭」立刻收起。
   */
  const [finished, setFinished] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  /* 目标容器要等父级 DOM 提交后才存在，所以用 effect 解析一次，别在 render 里查 */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!statusSlotId) return;
    setSlot(document.getElementById(statusSlotId));
  }, [statusSlotId]);
  /* 完成汇总自动收起；出错时**不**自动收（错误要留给人看） */
  useEffect(() => {
    if (!finished || uploading) return;
    const timer = setTimeout(() => {
      setProgress([]);
      setFinished(false);
    }, 8000);
    return () => clearTimeout(timer);
  }, [finished, uploading]);

  const dismissStatus = useCallback(() => {
    setProgress([]);
    setSkipNotice("");
    setFinished(false);
  }, []);

  /** 批量上传：逐个解析入库，最后汇总每表行数 */
  const handleUploadFiles = useCallback(
    async (files: File[], skipNotice = "") => {
      setSkipNotice(skipNotice);
      if (!lineId) {
        showToast("目标资料库不存在");
        return;
      }
      if (files.length === 0) return;
      setUploading(true);
      setFinished(false);
      setProgress([`共 ${files.length} 个文件，开始解析入库…`]);
      let totalRows = 0;
      let failed = 0;
      const tableCounts: Record<string, number> = {};
      /* 质量三件套：done 事件逐文件累计，最后汇总成一条质量行 */
      const evidenceSummary: IngestEvidenceSummary = { A: 0, B: 0, C: 0, D: 0 };
      const flaggedRows: IngestFlaggedRow[] = [];
      const conflicts: IngestConflict[] = [];
      const skippedRows: IngestSkippedRow[] = [];
      /** 逐文件结果：只报总数的话，「哪个文件一行没落」是看不出来的 */
      const perFile: FileIngestResult[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          let fileRows = 0;
          let fileFailed = false;
          let fileNote = "";
          setProgress((prev) => [...prev, `（${i + 1}/${files.length}）${file.name}`].slice(-8));
          try {
            for await (const ev of ingestStream(file, lineId)) {
              if (ev.type === "progress") {
                setProgress((prev) => [...prev, `　${String(ev.text ?? "处理中…")}`].slice(-8));
              } else if (ev.type === "done") {
                const rows = Number(ev.rows_inserted ?? 0);
                fileRows += rows;
                totalRows += rows;
                const counts = ev.table_counts as Record<string, number> | undefined;
                for (const [t, n] of Object.entries(counts ?? {})) {
                  tableCounts[t] = (tableCounts[t] ?? 0) + Number(n);
                }
                const summary = ev.evidenceSummary as Partial<IngestEvidenceSummary> | undefined;
                for (const level of ["A", "B", "C", "D"] as const) {
                  evidenceSummary[level] += Number(summary?.[level] ?? 0);
                }
                flaggedRows.push(...((ev.flaggedRows as IngestFlaggedRow[] | undefined) ?? []));
                conflicts.push(...((ev.conflicts as IngestConflict[] | undefined) ?? []));
                skippedRows.push(...((ev.skipped_rows as IngestSkippedRow[] | undefined) ?? []));
                if (rows === 0) {
                  fileNote = String(ev.model_issue ?? "").trim();
                }
              } else if (ev.type === "error") {
                failed++;
                fileFailed = true;
                setProgress((prev) =>
                  [...prev, `【错误】${file.name}：${String(ev.message ?? "")}`].slice(-8),
                );
              }
            }
          } catch (err: unknown) {
            failed++;
            fileFailed = true;
            setProgress((prev) =>
              [
                ...prev,
                `【错误】${file.name}：${err instanceof Error ? err.message : String(err)}`,
              ].slice(-8),
            );
          }
          const result: FileIngestResult = {
            name: file.name,
            rows: fileRows,
            failed: fileFailed,
            ...(fileNote !== "" ? { note: fileNote } : {}),
          };
          perFile.push(result);
          const line = fileResultLine(result);
          if (line !== null) setProgress((prev) => [...prev, line].slice(-8));
        }
        const receipt = buildIngestReceipt(perFile, tableCounts, {
          evidenceSummary,
          flaggedRows,
          conflicts,
          skippedRows,
        });
        setProgress((prev) => [...prev, receipt.doneLine].slice(-8));
        // 0 行的文件单独点名：可能是这个格式没被真正读进去（如 pptx 的表格）
        if (receipt.emptyLine !== null) {
          setProgress((prev) => [...prev, receipt.emptyLine!].slice(-8));
        }
        // 质量行放最后：证据分布、夸大措辞、冲突、被挡行与"系统不保证内容真伪"的边界
        setProgress((prev) => [...prev, receipt.qualityLine].slice(-8));
        setFinished(true);
        showToast(receipt.toast);
        onDone?.();
      } finally {
        setUploading(false);
      }
    },
    [lineId, onDone, showToast],
  );

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    /* 先物化再清空 value：input.files 是活引用，清空后引用跟着变空 */
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) {
      const { files: supported, skippedNames } = pickSupportedFiles(files);
      // 体积预检放在发请求之前：超限文件当场说清"多大、上限多少、怎么办"，
      // 不让它走到服务端换回一句英文 413（变更表 #155）
      const { ok, oversize } = splitOversizeFiles(supported, FILE_UPLOAD_LIMIT_MB);
      // 放行的大文件（≥200 MB）先给一句预期：解析要几分钟，不是卡住了（变更表 #156）
      const notice = [
        describeSkipped(skippedNames),
        describeOversize(oversize, FILE_UPLOAD_LIMIT_MB),
        describeLargeFiles(ok),
      ]
        .filter(Boolean)
        .join("；");
      void handleUploadFiles(ok, notice);
    }
  };

  /* 失败行不能再被「只看最后两条」截掉：多文件上传时错误往往排在 done/quality 之前，
     用户最后只能看到「失败 1 个」却看不到失败原因（变更表 #279）。 */
  const errorLines = progress.filter((line) => line.startsWith("【错误】"));
  const nonErrorTail = progress.filter((line) => !errorLines.includes(line)).slice(-2);
  const resultLines = [...errorLines, ...nonErrorTail];

  /* 状态区（跳过清单 + 入库进度）——挂到指定容器就挂过去，否则就地显示 */
  const status = (
    <>
      {skipNotice && (
        <div className="stale-banner" role="status">
          <span className="badge warning">跳过清单</span>
          {skipNotice}
          <button className="btn btn-sm" type="button" onClick={dismissStatus}>
            关闭
          </button>
        </div>
      )}
      {progress.length > 0 && (
        <div
          className="stale-banner"
          role={!uploading && errorLines.length > 0 ? "alert" : "status"}
        >
          <span className="badge primary">{uploading ? "入库进度" : "入库结果"}</span>
          {/* 进度中只显示最后一条；收尾时保留全部错误 + 最后两条正常结果，错误不被截掉 */}
          <div>
            {(uploading ? progress.slice(-1) : resultLines).map((line, i) => (
              <div key={`${progress.length}-${i}`}>{line}</div>
            ))}
          </div>
          {!uploading && (
            <button className="btn btn-sm" type="button" onClick={dismissStatus}>
              关闭
            </button>
          )}
        </div>
      )}
    </>
  );
  const renderStatus = () => (slot ? createPortal(status, slot) : status);

  return (
    <div className="material-upload">
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".pdf,.docx,.xlsx,.pptx"
        style={{ display: "none" }}
        onChange={onChange}
      />
      <input
        ref={dirRef}
        type="file"
        multiple
        style={{ display: "none" }}
        {...({ webkitdirectory: "true", directory: "true" } as Record<string, string>)}
        onChange={onChange}
      />
      <div className="model-discover-row">
        <button
          className="btn"
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          上传文件
        </button>
        <button
          className="btn"
          type="button"
          disabled={uploading}
          onClick={() => dirRef.current?.click()}
        >
          {uploading ? "解析入库中…" : "上传文件夹"}
        </button>
      </div>
      {renderStatus()}
    </div>
  );
};
