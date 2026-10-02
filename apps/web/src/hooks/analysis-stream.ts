/**
 * @scene/web — 本步分析的进度流消费（带续连与看门狗）
 *
 * 为什么单独成模块：用户实测「点重新生成，一直显示在分析中，刷新页面才发现早就生成完了」——
 * 服务端把结果写完、HTTP 连接也正常结束，但**前端没收到终局事件**（连接被中途掐断、
 * 或终局回执丢失），于是运行态永远停在「分析中」。这类问题只能靠**连接层自己兜**：
 *
 *  1. 流正常结束但没等到 `done`/`error` ⇒ 连接断过 ⇒ 带 `Last-Event-ID` **续连**
 *     （服务端 SSE 中枢本就缓存事件并支持从某个 id 之后重放）；
 *  2. 长时间没有任何事件（默认 75 秒）⇒ 连接已经死了但读端还挂着 ⇒ **主动中止并续连**；
 *  3. 续连次数用尽仍未拿到终局事件 ⇒ 明确告诉调用方 `terminal=false`，
 *     由调用方对账（刷新本步数据），绝不把界面永远钉在「分析中」。
 *
 * 这里不碰 React：`open`/回调都是注入的，可以在单测里用假事件流与假定时器完整覆盖。
 */

import type { FollowEvent } from "../api";

/** 一次连接：事件流 + 主动中止（看门狗判定连接已死时用） */
export interface StreamConnection {
  events: AsyncIterable<FollowEvent>;
  abort: () => void;
}

/**
 * 没有事件多久算「连接死了」（毫秒）
 *
 * 服务端在模型不吐字时也会每 15 秒补一条「仍在思考」心跳，且模型流空闲 120 秒会被
 * 服务端自己判超时——所以静默超过 130 秒基本只可能是连接断了。
 */
export const DEFAULT_STALL_MS = 130_000;
/** 最多续连几次（两次还接不回来就不是连接问题了） */
export const DEFAULT_MAX_RECONNECTS = 2;

export interface ConsumeOptions {
  /** 建立连接；`lastEventId` 非空时要求服务端从该 id 之后开始推 */
  open: (lastEventId: string | null) => StreamConnection;
  /** 每条事件（含续连后重放的事件） */
  onEvent: (event: FollowEvent) => void;
  /** 判定终局事件：收到它就不再续连 */
  isTerminal?: (event: FollowEvent) => boolean;
  stallMs?: number;
  maxReconnects?: number;
  /** 发生续连（原因：静默太久 / 流结束但没终局事件 / 连接报错） */
  onReconnect?: (reason: "stall" | "ended" | "error") => void;
}

export interface ConsumeResult {
  /** 是否收到了终局事件（done / error） */
  terminal: boolean;
  /** 续连次数 */
  reconnects: number;
  /** 最后一条事件的 id（续连定位用；没有则 null） */
  lastEventId: string | null;
}

const defaultIsTerminal = (event: FollowEvent): boolean =>
  event.type === "done" || event.type === "error";

/** 事件 id 取最大者：id 是递增数字字符串（契约 §四） */
function maxEventId(prev: string | null, id: string | null): string | null {
  if (id === null) return prev;
  if (prev === null) return id;
  const a = Number(prev);
  const b = Number(id);
  if (Number.isFinite(a) && Number.isFinite(b)) return b > a ? id : prev;
  return id;
}

/**
 * 消费一次分析进度流，直到拿到终局事件或续连次数用尽
 *
 * 返回后调用方**必须**对账（刷新本步数据与流程状态）：不管有没有拿到终局事件，
 * 服务端都可能已经写完结果了。
 */
export async function consumeAnalysisStream(opts: ConsumeOptions): Promise<ConsumeResult> {
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const isTerminal = opts.isTerminal ?? defaultIsTerminal;

  let lastEventId: string | null = null;
  let reconnects = 0;

  for (;;) {
    const conn = opts.open(lastEventId);
    const iterator = conn.events[Symbol.asyncIterator]();
    /** 看门狗信号：与"下一次读取"赛跑，连接死了才不会把读端一直挂着 */
    const STALL = Symbol("stall");
    let fireStall: () => void = () => {};
    const stallSignal = new Promise<typeof STALL>((resolve) => {
      fireStall = () => resolve(STALL);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    /** 每次读到东西就把看门狗往后推：静默超过 stallMs 即判定连接已死 */
    const armWatchdog = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        conn.abort();
        fireStall();
      }, stallMs);
    };

    let terminalEvent: FollowEvent | null = null;
    let failed = false;
    try {
      armWatchdog();
      for (;;) {
        let step: IteratorResult<FollowEvent> | typeof STALL;
        try {
          step = await Promise.race([iterator.next(), stallSignal]);
        } catch {
          failed = true; // 连接报错 = 断线，交给下面的续连逻辑
          break;
        }
        if (step === STALL) break;
        if (step.done) break;
        const event = step.value;
        if (typeof event.id === "string") lastEventId = maxEventId(lastEventId, event.id);
        opts.onEvent(event);
        if (isTerminal(event)) {
          terminalEvent = event;
          break;
        }
        armWatchdog();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // 释放迭代器：fetch 该 abort 的已经 abort 了，这里只是让读端收尾（不 await，避免再挂住）
      void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
    }

    if (terminalEvent) return { terminal: true, reconnects, lastEventId };
    if (reconnects >= maxReconnects) return { terminal: false, reconnects, lastEventId };

    reconnects += 1;
    opts.onReconnect?.(stalled ? "stall" : failed ? "error" : "ended");
  }
}
