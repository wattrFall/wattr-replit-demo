/**
 * Two-state segmented control. Used for baseline vs Wattr control, which is the
 * one switch the whole page is built around, so it is a real radiogroup rather
 * than a checkbox: both options stay visible and labelled.
 */
export function SToggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-[8px] border border-[var(--sbx-border)] bg-[var(--sbx-surface-0)] p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={
              "rounded-[6px] px-3 py-1.5 text-[11px] font-medium transition-colors " +
              "duration-[var(--sbx-motion)] ease-[var(--sbx-ease)] focus-visible:outline-none " +
              "focus-visible:ring-2 focus-visible:ring-[var(--sbx-focus)] focus-visible:ring-offset-1 " +
              "focus-visible:ring-offset-[var(--sbx-surface-0)] " +
              (active
                ? "bg-[var(--sbx-primary)]/18 text-[var(--sbx-primary-bright)]"
                : "text-[var(--sbx-text-faint)] hover:text-[var(--sbx-text-muted)]")
            }
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
