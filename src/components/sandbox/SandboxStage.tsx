import { Component, Suspense, lazy, type ReactNode } from "react";
import { Crosshair } from "lucide-react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useSandboxStore } from "@/lib/sandbox/store";
import { SButton } from "./primitives/SButton";

/**
 * The 3D bundle is fetched only once a stage has mounted, so three.js never
 * sits on the critical path for first paint.
 */
const SandboxCanvas = lazy(() => import("./SandboxCanvas"));

type CanvasErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
};

type CanvasErrorBoundaryState = {
  hasError: boolean;
};

class CanvasErrorBoundary extends Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
  state: CanvasErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CanvasErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/**
 * The 3D editing surface shared by the public sandbox and the facility Builder:
 * the lazily loaded canvas, a text fallback when WebGL is unavailable, and the
 * navigation hint and Recentre control.
 *
 * `summaryId` names the element holding the scene's text equivalent, which the
 * page renders where it can be read on demand.
 */
export function SandboxStage({ sceneSummary, summaryId }: { sceneSummary: string; summaryId: string }) {
  const reducedMotion = useReducedMotion();
  const resetView = useSandboxStore((s) => s.resetView);

  return (
    <div
      className="relative min-h-[340px] flex-1 overflow-hidden rounded-[10px] border border-[var(--sbx-border)] sm:min-h-[440px] lg:min-h-[520px]"
      role="group"
      aria-label="Data centre floor plan"
      aria-describedby={summaryId}
    >
      <CanvasErrorBoundary
        fallback={
          <div
            role="img"
            aria-label={sceneSummary}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--sbx-surface-0)] px-6 text-center"
          >
            <p className="font-[family-name:var(--sbx-font-mono)] text-[11px] tracking-[0.14em] text-[var(--sbx-primary)]">
              3D SCENE UNAVAILABLE
            </p>
            <p className="max-w-[340px] text-[12px] leading-[1.6] text-[var(--sbx-text-muted)]">
              This preview does not provide WebGL. The cooling model, controls, and inspector are still active.
            </p>
            <p className="max-w-[420px] font-[family-name:var(--sbx-font-mono)] text-[11px] leading-[1.6] text-[var(--sbx-text-faint)]">
              {sceneSummary}
            </p>
          </div>
        }
      >
        <Suspense
          fallback={
            <div className="absolute inset-0 grid place-items-center bg-[var(--sbx-surface-0)]">
              <p className="text-[11px] tracking-[0.14em] text-[var(--sbx-text-faint)]">LOADING SCENE</p>
            </div>
          }
        >
          <SandboxCanvas reducedMotion={reducedMotion} />
        </Suspense>
      </CanvasErrorBoundary>

      <div className="pointer-events-none absolute bottom-2.5 right-2.5 flex items-center gap-2">
        <span className="hidden rounded-[6px] bg-[var(--sbx-surface-0)]/80 px-2 py-1 text-[10px] leading-none text-[var(--sbx-text-faint)] sm:inline">
          Drag to orbit · right-drag to pan · scroll to zoom
        </span>
        <SButton
          size="sm"
          variant="ghost"
          className="pointer-events-auto bg-[var(--sbx-surface-0)]/80"
          onClick={resetView}
          aria-label="Recentre the view"
        >
          <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
          Recentre
        </SButton>
      </div>
    </div>
  );
}
