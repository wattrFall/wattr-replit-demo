import type { Config } from "tailwindcss";

/**
 * Trimmed to what the sandbox actually uses.
 *
 * The extracted config carried the full website theme — card, popover,
 * primary/secondary/muted/accent/destructive, chart and sidebar colour scales,
 * the radius overrides, the accordion keyframes, and the typography and animate
 * plugins. None of it was referenced: no shadcn components came across, and the
 * sandbox styles itself from the --sbx-* tokens in index.css using arbitrary
 * values.
 *
 * What remains is only what is reachable: the three colours and the font
 * families used by the @layer base rules in index.css.
 */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
} satisfies Config;
