/**
 * Phase 3: drag 直後の click 抑制用フラグ。
 *
 * 経緯: カード wrapper を click → DetailPane を開く動線にするとき、ドラッグ後の
 * pointerup タイミングで click が誤発火するケースを防ぐ。Board の onDragStart /
 * onDragEnd でフラグを建てて、Card 側の onClick が 200ms 以内ならスキップする。
 *
 * モジュールスコープの単純変数で良い (Plugin 内 1 ボード前提、SSR 無し)。
 */
let lastDragEndAt = 0;
let dragInProgress = false;

const CLICK_GUARD_MS = 200;

export const dndState = {
  onDragStart() {
    dragInProgress = true;
  },
  onDragEnd() {
    dragInProgress = false;
    lastDragEndAt = Date.now();
  },
  onDragCancel() {
    dragInProgress = false;
    lastDragEndAt = Date.now();
  },
  shouldSuppressClick(): boolean {
    if (dragInProgress) return true;
    return Date.now() - lastDragEndAt < CLICK_GUARD_MS;
  },
};
