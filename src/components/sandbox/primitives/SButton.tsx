import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger";

const BASE =
  "relative inline-flex select-none items-center justify-center gap-2 rounded-[7px] border " +
  "font-medium transition-colors duration-[var(--sbx-motion)] ease-[var(--sbx-ease)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sbx-focus)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sbx-surface-1)] " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS: Record<Variant, string> = {
  primary:
    "border-[var(--sbx-border-strong)] bg-[var(--sbx-primary)]/12 text-[var(--sbx-primary-bright)] " +
    "hover:bg-[var(--sbx-primary)]/20 active:bg-[var(--sbx-primary)]/28",
  ghost:
    "border-[var(--sbx-border)] bg-transparent text-[var(--sbx-text-muted)] " +
    "hover:bg-[var(--sbx-surface-3)] hover:text-[var(--sbx-text)] active:bg-[var(--sbx-surface-0)]",
  danger:
    "border-[var(--sbx-heat)]/30 bg-[var(--sbx-heat)]/10 text-[var(--sbx-heat)] " +
    "hover:bg-[var(--sbx-heat)]/18 active:bg-[var(--sbx-heat)]/25",
};

export function SButton({
  variant = "ghost",
  size = "md",
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  children: ReactNode;
}) {
  const sizing = size === "sm" ? "h-7 px-2.5 text-[11px]" : "h-8 px-3 text-xs";
  return (
    <button type="button" className={`${BASE} ${VARIANTS[variant]} ${sizing} ${className}`} {...rest}>
      {children}
    </button>
  );
}
