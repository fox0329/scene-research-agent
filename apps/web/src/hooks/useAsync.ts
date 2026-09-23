/**
 * @scene/web — 异步数据 hook（§4.3 三态：加载/空/降级）
 *
 * 只做三件事：跟着 deps 重新拉取、区分加载中/成功/失败、提供 reload。
 * 组件按 status 渲染 加载骨架 / 数据 / 空态 / 错误+重试。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncStatus = "loading" | "ok" | "error";

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | undefined;
  error: string | undefined;
}

export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    status: "loading",
    data: undefined,
    error: undefined,
  });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // 组件卸载后禁止 setState（React 18 不再警告但仍是无效写入）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, status: "loading", error: undefined }));
    fetcherRef
      .current()
      .then((data) => {
        if (!cancelled && mountedRef.current) {
          setState({ status: "ok", data, error: undefined });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && mountedRef.current) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ status: "error", data: undefined, error: message });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { ...state, reload };
}
