/**
 * @scene/web — 异步数据 hook（§4.3 三态：加载/空/降级）
 *
 * 只做三件事：跟着 deps 重新拉取、区分加载中/成功/失败、提供 reload。
 * 组件按 status 渲染 加载骨架 / 数据 / 空态 / 错误+重试。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  /**
   * 上一次拉取对应的 deps 签名
   *
   * 用来区分两种重取：**换了查询**（换步骤/换表/换场景 → 该回加载态、该出骨架）与
   * **同一份数据重取**（`reload()`，如长跑期间每 15 秒对账 → 必须静默）。旧写法不分这两种、
   * 一律 `status: "loading"`，于是对账一到就把整块面板换成加载条、数据回来再重建表格——
   * 用户看到的就是"表格内容一闪一闪"（故障清单 #48）。
   */
  const lastQueryRef = useRef<string | null>(null);
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
    const query = JSON.stringify(deps);
    // 同一份查询重取 = 静默刷新：保留屏上内容，拿到新数据再替换，中间不闪
    const silent = lastQueryRef.current === query;
    lastQueryRef.current = query;
    setState((prev) =>
      silent && prev.data !== undefined
        ? { ...prev, error: undefined }
        : { ...prev, status: "loading", error: undefined },
    );
    fetcherRef
      .current()
      .then((data) => {
        if (!cancelled && mountedRef.current) {
          setState({ status: "ok", data, error: undefined });
        }
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        // 静默刷新失败不把已有内容打掉：表格继续显示旧数据，下一个对账周期再试；
        // 首次加载失败仍走错误态（带重试按钮）
        setState((prev) =>
          silent && prev.data !== undefined
            ? { ...prev, error: message }
            : { status: "error", data: undefined, error: message },
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  /**
   * 返回值必须**保持身份稳定**（变更表 #181）
   *
   * 调用方普遍把这个对象写进 `useCallback`/`useMemo` 的依赖（`ProjectView` 的
   * `handleDataChanged` 依赖 `stale` 对象、`RealStagePanel` 的 `handleCellChange`
   * 依赖 `onChanged`、快照 memo 又依赖 `handleCellChange`）。原来每次渲染都
   * `return { ...state, reload }` 新建对象，依赖链整体失效 → 快照 effect 每次渲染都
   * 回报父级 `setStageSnapshot` → 父级重渲染 → 再回报……实测点「理解商业」刷出
   * 68 条 `Maximum update depth exceeded`（真死循环，白烧 CPU 并制造抖动）。
   */
  return useMemo(() => ({ ...state, reload }), [state, reload]);
}
