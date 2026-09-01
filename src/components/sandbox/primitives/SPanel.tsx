import type { ReactNode } from "react";

/**
 * The surface every sandbox panel sits on.
 *
 * Elevation is a border plus a one-step-lighter background, never a shadow —
 * the site's shadow tokens are all zero-alpha, so shadows would be foreign here.
 */
export function SPanel({
  title,
  actions,
  children,
  className = "",
  as: Tag = "section",
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: "section" | "aside" | "div";
}) {
  return (
    <Tag
      className={`flex flex-col overflow-hidden rounded-[10px] border border-[var(--sbx-border)] bg-[var(--sbx-surface-2)] ${className}`}
    >
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--sbx-border-hairline)] px-3.5 py-2.5">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--sbx-text-faint)]">
            {title}
          </h2>
          {actions}
        </header>
      )}
      {children}
    </Tag>
  );
}

/** Monospace key hint, Linear-style — teaches the shortcut in place. */
export function SKbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--sbx-border)] bg-[var(--sbx-surface-0)] px-1.5 py-0.5 font-[family-name:var(--sbx-font-mono)] text-[10px] leading-none text-[var(--sbx-text-faint)]">
      {children}
    </kbd>
  );
}
