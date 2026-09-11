import { useEffect } from "react";
import { CATALOGUE, PALETTE_ORDER } from "@/lib/sandbox/catalogue";
import { useSandboxStore } from "@/lib/sandbox/store";

/**
 * Keyboard shortcuts for a layout editor: 1-5 arm a palette entry, Escape
 * disarms, and Delete removes the selected equipment, disconnects the selected
 * connection, or removes the selected zone once it is empty.
 *
 * Ignored while a text field or slider has focus, so typing is never hijacked.
 * The store is read at event time, so the listener is registered once and can
 * never act on a stale selection.
 */
export function useSandboxShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const state = useSandboxStore.getState();
      if (event.key === "Escape") {
        state.setMode({ type: "idle" });
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        // Backspace would otherwise navigate back in some browsers.
        if (state.selectedId) {
          event.preventDefault();
          state.remove(state.selectedId);
        } else if (state.selectedConnectionId) {
          event.preventDefault();
          state.disconnect(state.selectedConnectionId);
        } else if (state.selectedZoneId) {
          event.preventDefault();
          state.removeZone(state.selectedZoneId);
        }
        return;
      }
      const index = PALETTE_ORDER.findIndex((kind) => CATALOGUE[kind].shortcut === event.key);
      if (index >= 0) {
        event.preventDefault();
        state.beginPlacing(PALETTE_ORDER[index]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
