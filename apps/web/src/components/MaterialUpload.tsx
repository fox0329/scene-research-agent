import React, { useCallback, useRef, useState } from "react";
import { api, ingestStream } from "../api";
import { pickSupportedFiles, describeSkipped, splitOversizeFiles, describeOversize, describeLargeFiles } from "../constants";
import { FILE_UPLOAD_LIMIT_MB } from "@scene/contract";
import { useToast } from "./Toast";

/**
 * 材料上传组件（v1.10 抽公共）：文件多选 + 整个文件夹 → 逐个解析入库 SSE 进度。
 * 资料库视图与项目工作台（场景专属资料）共用。
 */
export const MaterialUpload: React.FC<{
  /** 目标产品线（资料库）id */
  lineId: string;
  /** 入库完成后回调（刷新计数/汇总） */
  onDone?: () => void;
}> = ({ lineId, onDone }) => {
  const { showToast } = useToast();
  const [progress, setProgress] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [skipNotice, setSkipNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

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
      setProgress([`共 ${files.length} 个文件，开始解析入库…`]);
      let totalRows = 0;
      let failed = 0;
      const tableCounts: Record<string, number> = {};
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          setProgress((prev) => [...prev, `（${i + 1}/${files.length}）${file.name}`].slice(-8));
          try {
            for await (const ev of ingestStream(file, lineId)) {
              if (ev.type === "progress") {
                setProgress((prev) => [...prev, `　${String(ev.text ?? "处理中…")}`].slice(-8));
              } else if (ev.type === "done") {
                totalRows += Number(ev.rows_inserted ?? 0);
                const counts = ev.table_counts as Record<string, number> | undefined;
                for (const [t, n] of Object.entries(counts ?? {})) {
                  tableCounts[t] = (tableCounts[t] ?? 0) + Number(n);
                }
              } else if (ev.type === "error") {
                failed++;
                setProgress((prev) =>
                  [...prev, `【错误】${file.name}：${String(ev.message ?? "")}`].slice(-8),
                );
              }
            }
          } catch (err: unknown) {
            failed++;
            setProgress((prev) =>
              [
                ...prev,
                `【错误】${file.name}：${err instanceof Error ? err.message : String(err)}`,
              ].slice(-8),
            );
          }
        }
        const countsStr = Object.entries(tableCounts)
          .map(([t, n]) => `${t}×${n}`)
          .join("、");
        setProgress((prev) =>
          [
            ...prev,
            `【完成】${files.length} 个文件 · 共入库 ${totalRows} 行${countsStr ? `（${countsStr}）` : ""}${failed ? ` · 失败 ${failed} 个` : ""}`,
          ].slice(-8),
        );
        showToast(`解析完成：入库 ${totalRows} 行${countsStr ? `（${countsStr}）` : ""}`);
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
      {skipNotice && (
        <div className="stale-banner" role="status">
          <span className="badge warning">跳过清单</span>
          {skipNotice}
        </div>
      )}
      {progress.length > 0 && (
        <div className="stale-banner" role="status">
          <span className="badge primary">入库进度</span>
          {progress[progress.length - 1]}
        </div>
      )}
    </div>
  );
};
