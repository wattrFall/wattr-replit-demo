/** Shared cockpit building blocks: theme, headings, status, metrics and help. */
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowRight, CircleHelp, Monitor, Moon, Sun } from "lucide-react";
import { navigate, patch } from "./api";
import { Floating, type Align } from "./Floating";
import type { ThemePreference } from "./types";

export const mono = "font-[family-name:var(--font-mono)]";

/** Where this browser remembers the appearance, so signed-out screens open in it too. */
export const THEME_STORAGE_KEY = "wattr-theme";

/** Apply an appearance to the page; "system" follows the device setting. */
export function applyTheme(theme: ThemePreference) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "system" ? "light dark" : theme;
}

/** The appearance remembered in this browser, or "system". */
export function storedTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Whether the page currently shows the light appearance. */
export function showsLightTheme(): boolean {
  const theme = document.documentElement.dataset.theme ?? storedTheme();
  if (theme === "light") return true;
  if (theme === "dark") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
}

const ThemeContext = createContext<{
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}>({ theme: "system", setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ initialTheme, children }: { initialTheme: string; children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(
    initialTheme === "light" || initialTheme === "dark" ? initialTheme : "system",
  );
  const [notice, setNotice] = useState("");
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable; the account preference still applies here.
    }
  }, [theme]);
  const setTheme = (next: ThemePreference) => {
    setThemeState(next);
    setNotice(`Appearance set to ${next}.`);
    patch("/api/me/preferences", { theme: next }).catch(() => {
      setNotice("Appearance changed locally; it could not be saved.");
    });
  };
  return <ThemeContext.Provider value={{ theme, setTheme }}>
    {children}
    <span className="sr-only" role="status" aria-live="polite">{notice}</span>
  </ThemeContext.Provider>;
}

/**
 * A "?" that explains the control beside it. The explanation opens on hover,
 * keyboard focus or a tap, stays while the pointer moves onto it, and closes
 * with Escape. It floats on the body-level layer, so no panel can clip it.
 */
export function ContextualHelp({ title, children, align = "end" }: { title: string; children: ReactNode; align?: Align }) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const leaveTimer = useRef(0);
  const open = (hovered || focused || pinned) && !dismissed;
  const enter = () => { clearTimeout(leaveTimer.current); setHovered(true); };
  // A short grace period lets the pointer cross the gap onto the explanation.
  const leave = () => { leaveTimer.current = window.setTimeout(() => { setHovered(false); setDismissed(false); }, 120); };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setDismissed(true); setPinned(false); } };
    const onPress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !tooltipRef.current?.contains(target)) setPinned(false);
    };
    addEventListener("keydown", onKey);
    addEventListener("mousedown", onPress);
    return () => { removeEventListener("keydown", onKey); removeEventListener("mousedown", onPress); };
  }, [open]);
  return <span className="context-help">
    <button
      ref={triggerRef}
      type="button"
      className="context-help-trigger"
      aria-label={title}
      aria-describedby={tooltipId}
      aria-expanded={open}
      onPointerEnter={enter}
      onPointerLeave={leave}
      // Keyboard focus opens it; a click toggles it instead, so a second click closes it.
      onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
      onBlur={() => { setFocused(false); setDismissed(false); }}
      onClick={() => { setDismissed(false); setPinned(!pinned); }}
    >
      <CircleHelp size={14} aria-hidden="true"/>
    </button>
    <Floating
      open={open}
      keepMounted
      anchorRef={triggerRef}
      floatingRef={tooltipRef}
      side="top"
      align={align}
      gap={9}
      id={tooltipId}
      role="tooltip"
      className="context-help-content"
      onPointerEnter={enter}
      onPointerLeave={leave}
    >
      <strong>{title}</strong>
      {children}
    </Floating>
  </span>;
}

export function DisclosureSection({ label, children, engineering = false }: { label: string; children: ReactNode; engineering?: boolean }) {
  return <details className={`disclosure ${engineering ? "engineering" : ""}`}>
    <summary>{label}<ArrowRight size={13} aria-hidden="true"/></summary>
    <div className="disclosure-content">{children}</div>
  </details>;
}

export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  return <fieldset className="theme-control">
    <legend>Appearance</legend>
    {([
      ["system", "System", Monitor],
      ["light", "Light", Sun],
      ["dark", "Dark", Moon],
    ] as const).map(([value, label, Icon]) => <button
      key={value}
      type="button"
      className={theme === value ? "selected" : ""}
      aria-pressed={theme === value}
      aria-label={`${label} appearance`}
      onClick={() => setTheme(value)}
    ><Icon size={13} aria-hidden="true"/><span>{label}</span></button>)}
  </fieldset>;
}

export function Brand() {
  return <button onClick={() => navigate("/")} className="flex items-center gap-2.5 text-left"><span className="grid h-8 w-8 place-items-center rounded-md bg-cyan-400 text-slate-950"><Activity size={18}/></span><span><b className="block text-sm tracking-[.18em]">WATTR</b><small className="block text-[9px] tracking-[.2em] text-slate-500">OPERATOR COCKPIT</small></span></button>;
}
export function Status({ children, tone = "good" }: { children: ReactNode; tone?: "good" | "warn" | "bad" }) { return <span className={`status ${tone}`}>{children}</span>; }
export function Metric({ label, value, unit, sub, warn, help, onClick }: { label: string; value: string; unit?: string; sub: string; warn?: boolean; help?: string; onClick?: () => void }) {
  return <article className="panel metric" aria-label={`${label}: ${value}${unit ? ` ${unit}` : ""}. ${sub}`}><div className="metric-header"><div className="metric-label">{label}</div>{help && <ContextualHelp title={`About ${label}`}><p>{help}</p></ContextualHelp>}</div><div className={`metric-value ${warn ? "warn" : ""}`}>{value}<small>{unit}</small></div><div className="metric-sub">{sub}</div>{onClick && <button type="button" className="mt-3 flex items-center gap-2 text-left text-sm font-semibold text-cyan-400 hover:underline" onClick={onClick} aria-label={`Investigate ${label}`}>Inspect sources <ArrowRight size={14}/></button>}</article>;
}
export function PageHead({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className={`${mono} mb-2 text-[10px] tracking-[.2em] text-cyan-400`}>{eyebrow}</div><h1 className="text-2xl font-semibold tracking-tight text-slate-100 md:text-3xl">{title}</h1><p className="mt-1 text-sm text-slate-500">{detail}</p></div>{action}</div>;
}
