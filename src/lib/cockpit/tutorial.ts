const PAGE_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/portfolio/, "Portfolio"],
  [/^\/operations/, "Operations"],
  [/^\/incidents/, "Incidents"],
  [/^\/recommendations/, "Recommendation"],
  [/^\/audit/, "Audit history"],
  [/^\/topology/, "Thermal graph"],
  [/^\/model-lab/, "Model Lab"],
  [/^\/model/, "Model Studio"],
  [/^\/ask-wattr/, "Ask Wattr"],
];

/** Absolute path of the page a tutorial step lives on. */
export function tutorialRouteFor(route: string, facilityId?: string) {
  if (route === "/portfolio") return "/portfolio";
  return facilityId ? `/facilities/${facilityId}${route}` : "/portfolio";
}

/** Name of the page a tutorial step lives on, for its "Open <page>" button. */
export function tutorialPageLabel(route: string) {
  return PAGE_LABELS.find(([pattern]) => pattern.test(route))?.[1] ?? "workspace";
}
