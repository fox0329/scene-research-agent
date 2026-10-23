/**
 * @scene/web — 数据变更广播（#315）
 *
 * 右栏对话改表成功后，中栏/左栏必须立即重取，否则用户看到的是旧值，
 * 会以为“没写进去”。用 window 事件解耦：右栏只管喊一声，各视图自己重载。
 */
export const DATA_CHANGED = "scene:data-changed";

export function notifyDataChanged(): void {
  window.dispatchEvent(new CustomEvent(DATA_CHANGED));
}

export function onDataChanged(handler: () => void): () => void {
  window.addEventListener(DATA_CHANGED, handler);
  return () => window.removeEventListener(DATA_CHANGED, handler);
}
