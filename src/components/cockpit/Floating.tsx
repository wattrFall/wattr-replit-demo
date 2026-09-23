/**
 * Floating content anchored to a control: help tooltips and small menus.
 *
 * It renders into one layer on document.body, above every panel on the
 * z-index scale, so no panel's overflow can clip it. The layer carries the
 * cockpit's theme, and each piece of floating content stays inside the
 * viewport by flipping to the other side of its control and shifting along it.
 */
import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type Side = "top" | "bottom";
export type Align = "start" | "center" | "end";

/** The closest floating content comes to the viewport's edge. */
const EDGE = 8;

type Placement = { top: number; left: number; side: Side; arrowX: number };

let layer: HTMLElement | null = null;

/** The body-level layer floating content renders into, created on first use. */
function floatingLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement("div");
  layer.className = "cockpit floating-root";
  document.body.appendChild(layer);
  return layer;
}

function place(anchor: DOMRect, width: number, height: number, side: Side, align: Align, gap: number): Placement {
  const room = { top: anchor.top - EDGE, bottom: innerHeight - anchor.bottom - EDGE };
  const other: Side = side === "top" ? "bottom" : "top";
  // The preferred side when it fits, otherwise whichever side has more room.
  const chosen = room[side] >= height + gap || room[side] >= room[other] ? side : other;
  const top = chosen === "top" ? anchor.top - gap - height : anchor.bottom + gap;
  const preferred = align === "start" ? anchor.left
    : align === "end" ? anchor.right - width
      : anchor.left + anchor.width / 2 - width / 2;
  const left = Math.min(Math.max(EDGE, preferred), innerWidth - width - EDGE);
  const arrowX = Math.min(Math.max(12, anchor.left + anchor.width / 2 - left), width - 12);
  return { top: Math.max(EDGE, top), left, side: chosen, arrowX };
}

/** Where floating content sits beside its anchor, kept current as the page scrolls or resizes. */
function useAnchoredPlacement(open: boolean, anchorRef: RefObject<HTMLElement>, floatingRef: RefObject<HTMLElement>, side: Side, align: Align, gap: number) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return;
    setPlacement(place(anchor.getBoundingClientRect(), floating.offsetWidth, floating.offsetHeight, side, align, gap));
  }, [anchorRef, floatingRef, side, align, gap]);
  useLayoutEffect(() => {
    if (open) update();
  }, [open, update]);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    addEventListener("scroll", schedule, true);
    addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (floatingRef.current) observer?.observe(floatingRef.current);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("scroll", schedule, true);
      removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [open, update, floatingRef]);
  return placement;
}

type FloatingProps = {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  floatingRef: RefObject<HTMLDivElement>;
  side?: Side;
  align?: Align;
  gap?: number;
  className: string;
  children: ReactNode;
  /** Keep the content in the document while closed, for a tooltip an aria-describedby points at. */
  keepMounted?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">;

/** Content floating beside its anchor, on the body-level layer. */
export function Floating({ open, anchorRef, floatingRef, side = "bottom", align = "end", gap = 8, className, children, keepMounted = false, style, ...rest }: FloatingProps) {
  const placement = useAnchoredPlacement(open, anchorRef, floatingRef, side, align, gap);
  if (!open && !keepMounted) return null;
  const placed = open && placement !== null;
  return createPortal(<div
    {...rest}
    ref={floatingRef}
    className={`floating ${className}${placed ? " open" : ""}`}
    data-side={placement?.side ?? side}
    style={{
      ...style,
      ...(placement ? { top: placement.top, left: placement.left } : {}),
      "--arrow-x": `${placement?.arrowX ?? 12}px`,
    } as CSSProperties}
  >{children}</div>, floatingLayer());
}

/** The keyboard-reachable controls inside an element, in order. */
function tabbables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
    .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && element.offsetParent !== null);
}

/**
 * Close a floating menu the ways people expect: Escape, a press outside it,
 * or tabbing past either end. Its content sits at the end of the document,
 * so tabbing out continues from its trigger, as if it were still beside it.
 */
export function useDismiss(open: boolean, close: () => void, triggerRef: RefObject<HTMLElement>, floatingRef: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    // After the layer has placed and shown the content: hidden content cannot take focus.
    const focusFrame = requestAnimationFrame(() => {
      if (floatingRef.current) tabbables(floatingRef.current)[0]?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !floatingRef.current?.contains(document.activeElement)) return;
      const inside = tabbables(floatingRef.current);
      const leavingStart = event.shiftKey && document.activeElement === inside[0];
      const leavingEnd = !event.shiftKey && document.activeElement === inside[inside.length - 1];
      if (!leavingStart && !leavingEnd) return;
      event.preventDefault();
      close();
      if (leavingStart) {
        triggerRef.current?.focus();
        return;
      }
      const page = tabbables(document).filter((element) => !floatingRef.current?.contains(element));
      const trigger = triggerRef.current;
      const next = trigger ? page[page.indexOf(trigger) + 1] : undefined;
      (next ?? trigger)?.focus();
    };
    const onPress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!floatingRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    addEventListener("keydown", onKey);
    addEventListener("mousedown", onPress);
    return () => {
      cancelAnimationFrame(focusFrame);
      removeEventListener("keydown", onKey);
      removeEventListener("mousedown", onPress);
    };
  }, [open]);
}
