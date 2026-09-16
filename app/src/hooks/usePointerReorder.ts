import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag-to-reorder for a vertical list, built on Pointer Events.
 *
 * Pointer Events rather than HTML5 drag-and-drop because HTML5 DnD does not
 * fire on touch devices at all — the reader is used on a phone, so a
 * mouse-only implementation would only solve half the problem. Pointer Events
 * cover mouse, touch and pen through one code path.
 *
 * The list reorders live as you drag: `onMove` is called each time the pointer
 * crosses into a neighbour's band, so the dragged row ends up under the pointer
 * and the gesture is self-stabilising (no separate placeholder to render).
 * `onCommit` fires once at the end, when the list is already in its final
 * order, as the cue to persist.
 *
 * Usage:
 *   const sort = usePointerReorder({ count, onMove, onCommit, onCancel });
 *   <nav ref={sort.containerRef}>
 *     {items.map((it, i) => (
 *       <div key={it.id} data-sortable>
 *         <button {...sort.handleProps(i)}>grip</button>
 *         …
 *       </div>
 *     ))}
 *   </nav>
 *
 * Rows must carry `data-sortable`; anything in the container without it (a
 * pinned header row, for example) is ignored, so handle indices stay aligned
 * with the backing array.
 *
 * Accessibility: the grip is a real button. Arrow Up/Down move the row one
 * position and commit immediately, so reordering never requires a pointer.
 */
export interface PointerReorderOptions {
  /** Number of sortable rows. Used for bounds checks. */
  count: number;
  /** Move the row at `from` to `to`. Called repeatedly while dragging. */
  onMove: (from: number, to: number) => void;
  /**
   * The gesture finished and the position changed. The list is already in its
   * final order; `from`/`to` are the start and end indices.
   */
  onCommit: (from: number, to: number) => void;
  /**
   * The gesture was abandoned (Escape). Undo by moving `to` back to `from`.
   */
  onCancel?: (from: number, to: number) => void;
  /** Travel required before a drag starts, so a tap still reads as a tap. */
  threshold?: number;
}

interface DragState {
  pointerId: number;
  startY: number;
  startIndex: number;
  index: number;
  active: boolean;
  el: HTMLElement;
}

/** Distance from a scroll edge at which dragging starts scrolling. */
const EDGE = 40;
const EDGE_STEP = 14;

export function usePointerReorder<T extends HTMLElement = HTMLElement>({
  count,
  onMove,
  onCommit,
  onCancel,
  threshold = 5,
}: PointerReorderOptions) {
  // Generic so the returned ref can be attached to whatever element holds the
  // rows (a <nav>, a <div>, …) without casting at the call site.
  const containerRef = useRef<T | null>(null);
  const drag = useRef<DragState | null>(null);
  /** Index being dragged, or null. State (not a ref) so rows can restyle. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const rows = useCallback(
    () => Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-sortable]') ?? []),
    [],
  );

  /**
   * Nearest scrollable ancestor, so a long list can be dragged past its edge.
   * Falls back to the document, which is what scrolls when the list is simply
   * part of a long page rather than inside its own scroll box.
   */
  const scroller = useCallback((): HTMLElement | null => {
    let el = containerRef.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    const doc = document.scrollingElement as HTMLElement | null;
    return doc && doc.scrollHeight > doc.clientHeight ? doc : null;
  }, []);

  // Listeners are attached for the life of a gesture only. Kept in a ref so
  // detach() can remove the exact same function objects.
  const handlers = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: (e: PointerEvent) => void;
    key: (e: KeyboardEvent) => void;
  } | null>(null);

  const detach = useCallback(() => {
    const h = handlers.current;
    if (!h) return;
    window.removeEventListener('pointermove', h.move);
    window.removeEventListener('pointerup', h.up);
    window.removeEventListener('pointercancel', h.cancel);
    window.removeEventListener('keydown', h.key);
    handlers.current = null;
  }, []);

  const end = useCallback(
    (commit: boolean) => {
      const d = drag.current;
      drag.current = null;
      setDragIndex(null);
      detach();
      if (!d) return;
      // Releasing capture throws if the pointer is already gone.
      try { d.el.releasePointerCapture(d.pointerId); } catch { /* already released */ }
      if (!d.active || d.index === d.startIndex) return;
      if (commit) onCommit(d.startIndex, d.index);
      else onCancel?.(d.startIndex, d.index);
    },
    [detach, onCommit, onCancel],
  );

  const handlePointerDown = (index: number) => (e: React.PointerEvent<HTMLElement>) => {
    // Left button only for mice; any contact for touch/pen.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (drag.current) return;

    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startIndex: index, index, active: false, el };

    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.pointerId) return;

      if (!d.active) {
        if (Math.abs(ev.clientY - d.startY) < threshold) return;
        d.active = true;
        setDragIndex(d.index);
      }
      // Stops text selection / native scroll from fighting the drag.
      ev.preventDefault();

      const els = rows();
      let target = d.index;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (ev.clientY < r.top) { target = i === 0 ? 0 : i; break; }
        if (ev.clientY <= r.bottom) { target = i; break; }
        if (i === els.length - 1) target = i;      // below the last row
      }
      if (target !== d.index && target >= 0 && target < count) {
        onMove(d.index, target);
        d.index = target;
        setDragIndex(target);
      }

      // Nudge a scrollable container when dragging near its edge. This only
      // advances while the pointer is moving; holding still at the edge does
      // not keep scrolling, which is a deliberate simplification.
      const sc = scroller();
      if (sc) {
        // For the document, the element's box is the whole page, not the part
        // you can see, so the edges to test against are the viewport's.
        const box = sc === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : sc.getBoundingClientRect();
        if (ev.clientY < box.top + EDGE) sc.scrollTop -= EDGE_STEP;
        else if (ev.clientY > box.bottom - EDGE) sc.scrollTop += EDGE_STEP;
      }
    };

    const up = (ev: PointerEvent) => {
      if (drag.current && ev.pointerId !== drag.current.pointerId) return;
      end(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (drag.current && ev.pointerId !== drag.current.pointerId) return;
      end(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); end(false); }
    };

    handlers.current = { move, up, cancel, key };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  };

  /** Keyboard equivalent: move one position per Arrow press and persist. */
  const handleKeyDown = (index: number) => (e: React.KeyboardEvent<HTMLElement>) => {
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (dir === 0) return;
    const to = index + dir;
    if (to < 0 || to >= count) return;
    e.preventDefault();
    onMove(index, to);
    onCommit(index, to);
  };

  // A row can unmount mid-gesture (a refresh replacing the list); don't leak.
  useEffect(() => detach, [detach]);

  return {
    containerRef,
    dragIndex,
    isDragging: dragIndex !== null,
    handleProps: (index: number) => ({
      onPointerDown: handlePointerDown(index),
      onKeyDown: handleKeyDown(index),
    }),
  };
}
