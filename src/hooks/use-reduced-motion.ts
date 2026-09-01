import { useEffect, useState } from "react";

/**
 * Tracks the user's reduced-motion preference, and keeps tracking it — the
 * setting can change while the page is open.
 *
 * Mirrors the shape of use-mobile.tsx so the two read the same way.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
