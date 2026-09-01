import { useId } from "react";

/**
 * Labelled range input for a single equipment parameter.
 *
 * Native <input type="range"> on purpose: it is keyboard-operable (arrows,
 * Home/End, PageUp/Down) and screen-reader-labelled for free, which a div-based
 * slider would have to rebuild. Only the visual track is restyled.
 */
export function SSlider({
  label,
  unit,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  unit: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[12px] text-[var(--sbx-text-muted)]">
          {label}
        </label>
        <output htmlFor={id} className="font-[family-name:var(--sbx-font-mono)] text-[12px] text-[var(--sbx-text)]">
          {Number.isInteger(step) ? value.toFixed(0) : value.toFixed(1)}
          <span className="ml-1 text-[var(--sbx-text-faint)]">{unit}</span>
        </output>
      </div>

      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
        className="sbx-range mt-2 w-full"
        style={{ ["--sbx-range-pct" as string]: `${pct}%` }}
      />

      {hint && (
        <p id={hintId} className="mt-1.5 text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]">
          {hint}
        </p>
      )}
    </div>
  );
}
