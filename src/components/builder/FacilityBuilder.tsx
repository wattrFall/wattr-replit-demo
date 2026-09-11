import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, History, RotateCcw, Save, Upload } from "lucide-react";
import { FACILITY_TEMPLATES } from "@/lib/facility/templates";
import { validateFacilityLayout, type FacilityLayout } from "@/lib/facility/layout";
import type { Finding } from "@/lib/sandbox/validate";
import { useSandboxStore } from "@/lib/sandbox/store";
import { Inspector } from "@/components/sandbox/panels/Inspector";
import { Palette } from "@/components/sandbox/panels/Palette";
import { Telemetry } from "@/components/sandbox/panels/Telemetry";
import { Zones } from "@/components/sandbox/panels/Zones";
import { SandboxStage } from "@/components/sandbox/SandboxStage";
import { useSandboxShortcuts } from "@/components/sandbox/useSandboxShortcuts";
import { useSandboxSimulation } from "@/components/sandbox/useSandboxSimulation";
import { useSceneDescription } from "@/components/sandbox/useSceneDescription";

export type BuildStatus = "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";

export type BuildSummary = {
  id: string;
  status: BuildStatus;
  name: string | null;
  hasLayout: boolean;
  counts: { zones: number; items: number; connections: number } | null;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
};

type BuildsResponse = {
  published: { id: string; layout: FacilityLayout; reference: boolean };
  versions: BuildSummary[];
};

type BuildDetail = BuildSummary & { layout: FacilityLayout; reference: boolean };

/** The cockpit's authenticated request helper. */
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type PendingOpen = { layout: FacilityLayout; label: string; presetId: string | null };

const STATUS_TONE: Record<BuildStatus, "good" | "warn" | "bad"> = {
  DRAFT: "warn",
  VALIDATED: "good",
  PUBLISHED: "good",
  ARCHIVED: "warn",
};

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The layout currently in the editor, as a comparable string. */
function editorFingerprint() {
  const { zones, items, connections } = useSandboxStore.getState();
  return JSON.stringify({ zones, items, connections });
}

/**
 * The facility Builder: construct the data centre Operations runs.
 *
 * It opens on what Operations currently runs, or starts from a template, and
 * uses the same editor as the public sandbox at facility scale: zones,
 * equipment, port-to-port connections, and live design checks. Work is saved
 * as a draft version, validated on the server, and published deliberately;
 * any earlier version can be restored.
 */
export function FacilityBuilder({
  facilityId,
  request,
  onPublished,
}: {
  facilityId: string;
  request: Request;
  onPublished: () => Promise<void> | void;
}) {
  useSandboxSimulation();
  useSandboxShortcuts();
  const { sceneSummary, announcement } = useSceneDescription();
  const zones = useSandboxStore((s) => s.zones);
  const items = useSandboxStore((s) => s.items);
  const connections = useSandboxStore((s) => s.connections);
  const activePresetId = useSandboxStore((s) => s.activePresetId);
  const select = useSandboxStore((s) => s.select);
  const loadLayout = useSandboxStore((s) => s.loadLayout);

  const [builds, setBuilds] = useState<BuildsResponse | null>(null);
  const [editing, setEditing] = useState("");
  const [pending, setPending] = useState<PendingOpen | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [serverFindings, setServerFindings] = useState<{ versionId: string; findings: Finding[] } | null>(null);
  const baseline = useRef("");

  const layout = useMemo<FacilityLayout>(() => ({ zones, items, connections }), [zones, items, connections]);
  const checks = useMemo(() => validateFacilityLayout(layout), [layout]);
  const dirty = baseline.current !== "" && JSON.stringify(layout) !== baseline.current;

  const open = useCallback(
    (next: FacilityLayout, label: string, presetId: string | null = null) => {
      loadLayout(next, presetId);
      baseline.current = editorFingerprint();
      setEditing(label);
      setPending(null);
      setServerFindings(null);
    },
    [loadLayout],
  );

  /** Open something else, asking first if it would discard unsaved work. */
  const requestOpen = (next: FacilityLayout, label: string, presetId: string | null = null) => {
    if (dirty) setPending({ layout: next, label, presetId });
    else open(next, label, presetId);
  };

  const refresh = useCallback(async () => {
    const next = await request<BuildsResponse>(`/api/facilities/${facilityId}/builds`);
    setBuilds(next);
    return next;
  }, [facilityId, request]);

  const publishedLabel = (next: BuildsResponse) =>
    next.published.reference
      ? `Published model ${next.published.id} (SFO-01 reference layout)`
      : `Published build ${next.published.id}`;

  // Open on what Operations runs, at facility scale. The store is shared with
  // the public sandbox, so the scale is set here rather than assumed.
  useEffect(() => {
    let cancelled = false;
    useSandboxStore.getState().setParamScale("facility");
    refresh()
      .then((next) => {
        if (!cancelled) open(next.published.layout, publishedLabel(next));
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, open]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = () =>
    run("save", async () => {
      const saved = await request<BuildSummary>(
        `/api/facilities/${facilityId}/builds`,
        jsonPost({ layout, name: name.trim() || undefined }),
      );
      baseline.current = editorFingerprint();
      setEditing(`Draft ${saved.id}${saved.name ? ` · ${saved.name}` : ""}`);
      setServerFindings(null);
      setMessage(`Saved ${saved.id} as a draft. Validate it next.`);
      await refresh();
    });

  const validate = (build: BuildSummary) =>
    run(`validate:${build.id}`, async () => {
      try {
        const result = await request<{ findings: Finding[] }>(
          `/api/facilities/${facilityId}/builds/${build.id}/validate`,
          { method: "POST" },
        );
        setServerFindings({ versionId: build.id, findings: result.findings });
        setMessage(`${build.id} passed validation and is ready to publish.`);
      } catch (cause) {
        const findings = (cause as { body?: { findings?: Finding[] } }).body?.findings;
        if (findings) setServerFindings({ versionId: build.id, findings });
        throw cause;
      }
      await refresh();
    });

  const publish = (build: BuildSummary) =>
    run(`publish:${build.id}`, async () => {
      await request(`/api/facilities/${facilityId}/builds/${build.id}/publish`, { method: "POST" });
      await onPublished();
      await refresh();
      setMessage(`Published ${build.id}. Operations now runs this build.`);
    });

  const restore = (build: BuildSummary) =>
    run(`restore:${build.id}`, async () => {
      await request(`/api/facilities/${facilityId}/builds/rollback`, jsonPost({ versionId: build.id }));
      await onPublished();
      await refresh();
      setMessage(`Restored ${build.id}. Operations now runs it again.`);
    });

  const loadVersion = (build: BuildSummary) =>
    run(`load:${build.id}`, async () => {
      const detail = await request<BuildDetail>(`/api/facilities/${facilityId}/builds/${build.id}`);
      requestOpen(
        detail.layout,
        detail.reference ? `${build.id} (SFO-01 reference layout)` : `${build.status === "DRAFT" ? "Draft" : "Version"} ${build.id}`,
      );
    });

  const shownFindings = serverFindings?.findings ?? checks.findings;

  return (
    <div className="space-y-4">
      <section className="panel p-5" aria-labelledby="builder-source">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="eyebrow">OPERATIONS RUNS</div>
            <p className="mt-1 text-sm font-medium">{builds ? publishedLabel(builds) : "Loading the published model…"}</p>
          </div>
          <div className="text-right">
            <div id="builder-source" className="eyebrow">EDITING</div>
            <p className="mt-1 text-sm text-slate-300">
              {editing || "—"}
              {dirty && <span className="ml-2 text-amber-300">· unsaved changes</span>}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="eyebrow mr-1">START FROM</span>
          {FACILITY_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className={`button ${activePresetId === template.id ? "primary" : "secondary"}`}
              aria-pressed={activePresetId === template.id}
              title={template.description}
              onClick={() => requestOpen(template.layout, `Template: ${template.name}`, template.id)}
            >
              {template.name}
            </button>
          ))}
          {builds && (
            <button type="button" className="button secondary" onClick={() => requestOpen(builds.published.layout, publishedLabel(builds))}>
              <History size={14} aria-hidden="true" />
              What Operations runs
            </button>
          )}
        </div>

        {pending && (
          <div role="alertdialog" aria-labelledby="builder-discard-title" className="subpanel mt-4 border-amber-400/60">
            <b id="builder-discard-title">Replace your unsaved changes?</b>
            <p className="text-xs leading-5 text-slate-400">
              Opening {pending.label} replaces the layout in the editor. Save a draft first to keep your changes.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="button primary" onClick={() => open(pending.layout, pending.label, pending.presetId)}>
                Replace
              </button>
              <button type="button" className="button secondary" onClick={() => setPending(null)}>
                Keep editing
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="overflow-hidden rounded-[14px] border border-[var(--sbx-border-strong)] bg-[var(--sbx-surface-1)] font-[family-name:var(--sbx-font-sans)]">
        <div className="flex flex-col gap-3 p-3 lg:flex-row">
          <div className="flex flex-col gap-3 lg:w-[230px]">
            <Palette />
            <Zones />
          </div>
          <SandboxStage sceneSummary={sceneSummary} summaryId="builder-scene-summary" />
          <div className="flex flex-col gap-3 lg:w-[280px]">
            <Telemetry />
            <Inspector />
          </div>
        </div>
        <footer className="border-t border-[var(--sbx-border)] px-4 py-2.5">
          <p className="font-[family-name:var(--sbx-font-mono)] text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]">
            <span role="status" aria-live="polite">
              {announcement}
            </span>{" "}
            <span id="builder-scene-summary">{sceneSummary}</span>
          </p>
        </footer>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="panel p-5" aria-labelledby="builder-checks-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="builder-checks-title" className="font-semibold">Design checks</h2>
            <span className={`status ${checks.ok ? (checks.warnings.length ? "warn" : "good") : "bad"}`}>
              {checks.ok
                ? checks.warnings.length
                  ? `${checks.warnings.length} WARNING${checks.warnings.length > 1 ? "S" : ""}`
                  : "READY TO VALIDATE"
                : `${checks.errors.length} TO FIX`}
            </span>
          </div>
          <p className="copy">
            {serverFindings
              ? `Server validation of ${serverFindings.versionId}.`
              : "Checked as you edit. Errors must be fixed before a build can be validated; warnings are allowed."}
          </p>
          {shownFindings.length === 0 ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-teal-300">
              <Check size={15} aria-hidden="true" /> Every rack is cooled, every cooling unit has a chiller, and capacity covers the load.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {shownFindings.map((finding, index) => (
                <li key={`${finding.message}:${index}`} className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2 text-xs">
                  <span className="flex items-start gap-2">
                    <span className={`status ${finding.severity === "error" ? "bad" : "warn"}`}>{finding.severity.toUpperCase()}</span>
                    <span className="leading-5 text-slate-300">{finding.message}</span>
                  </span>
                  {finding.itemIds[0] && items.some((item) => item.id === finding.itemIds[0]) && (
                    <button type="button" className="button secondary" onClick={() => select(finding.itemIds[0])}>
                      Show
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-5" aria-labelledby="builder-versions-title">
          <h2 id="builder-versions-title" className="font-semibold">Save and publish</h2>
          <p className="copy">
            Save the editor as a draft, validate it, then publish it to change what Operations runs. Restoring an earlier version puts it back.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="field m-0 flex-1">
              Draft name (optional)
              <input
                className="input mt-2 w-full"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Hall B with a second CDU"
              />
            </label>
            <button type="button" className="button primary" disabled={busy !== null} onClick={saveDraft}>
              <Save size={14} aria-hidden="true" />
              Save draft
            </button>
          </div>

          <ul className="mt-4 divide-y divide-slate-800" aria-label="Facility model versions">
            {(builds?.versions ?? []).map((build) => {
              const current = builds?.published.id === build.id;
              return (
                <li key={build.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-xs text-cyan-300">{build.id}</code>
                      <span className={`status ${STATUS_TONE[build.status]}`}>{current ? "IN OPERATIONS" : build.status}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {build.name ?? (build.hasLayout ? "Unnamed build" : "Model parameters only")}
                      {build.counts
                        ? ` · ${build.counts.zones} zones, ${build.counts.items} items, ${build.counts.connections} connections`
                        : " · SFO-01 reference layout"}
                      {` · ${new Date(build.createdAt).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="button secondary" disabled={busy !== null} onClick={() => loadVersion(build)}>
                      Open
                    </button>
                    {build.status === "DRAFT" && build.hasLayout && (
                      <button type="button" className="button secondary" disabled={busy !== null} onClick={() => validate(build)}>
                        <Check size={14} aria-hidden="true" />
                        Validate
                      </button>
                    )}
                    {build.status === "VALIDATED" && build.hasLayout && (
                      <button type="button" className="button primary" disabled={busy !== null} onClick={() => publish(build)}>
                        <Upload size={14} aria-hidden="true" />
                        Publish
                      </button>
                    )}
                    {!current && build.status !== "DRAFT" && (
                      <button type="button" className="button secondary" disabled={busy !== null} onClick={() => restore(build)}>
                        <RotateCcw size={14} aria-hidden="true" />
                        Restore
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {builds && builds.versions.length === 0 && <li className="py-3 text-sm text-slate-500">No versions yet.</li>}
          </ul>
        </section>
      </div>

      {message && <p role="status" className="panel p-4 text-sm text-teal-300">{message}</p>}
      {error && <p role="alert" className="panel p-4 text-sm text-red-300">{error}</p>}
    </div>
  );
}
