import type { CockpitSnapshot } from "./simulation";

type IncidentRecord = { id: string; status: string; severity: string; simulated_at: number | string };

export type IncidentReplayState = {
  status: "OPEN" | "CLEAR";
  severity: "WATCH" | "HIGH" | null;
  /** Scenario time at which the stored incident record was raised. */
  recordedAt: number;
};

/**
 * Resolves the incident a route names. An unknown id is reported as not found
 * rather than silently showing a different incident.
 */
export function selectIncident<T extends { id: string }>(
  items: readonly T[],
  incidentId?: string,
): { incident?: T; notFound: boolean } {
  if (!incidentId) return { incident: items[0], notFound: false };
  const incident = items.find((item) => item.id === incidentId);
  return { incident, notFound: !incident };
}

/**
 * Status of an incident at the replay instant. The scenario incident follows
 * the replayed model, so the Incident page agrees with Portfolio, Operations
 * and Ask Wattr. Any other record keeps its stored status.
 */
export function incidentStateAt(
  incident: IncidentRecord,
  snapshot: Pick<CockpitSnapshot, "incident">,
): IncidentReplayState {
  const recordedAt = Number(incident.simulated_at);
  if (incident.id !== snapshot.incident.id) {
    const open = incident.status === "OPEN";
    const severity = incident.severity === "WATCH" || incident.severity === "HIGH" ? incident.severity : null;
    return { status: open ? "OPEN" : "CLEAR", severity: open ? severity : null, recordedAt };
  }
  return {
    status: snapshot.incident.open ? "OPEN" : "CLEAR",
    severity: snapshot.incident.open ? snapshot.incident.severity : null,
    recordedAt,
  };
}
