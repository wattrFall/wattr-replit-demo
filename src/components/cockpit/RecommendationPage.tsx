/** The decision page: an advisory, its what-if comparison, the Safety Shield and the operator's disposition. */
import { useEffect, useRef, useState } from "react";
import { Check, Clock3, Layers3, RotateCcw, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { recordLearningEvent } from "@/lib/cockpit/learning";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import { ApiError, post } from "./api";
import { useGuidance } from "./Guidance";
import { ReplayBar, Shell } from "./Shell";
import type { Audit, Facility, SafetyEvaluation, SessionData, WhatIfComparison } from "./types";
import { ContextualHelp, DisclosureSection, Metric, PageHead, Status } from "./ui";

type Disposition = "APPROVE" | "REJECT" | "DEFER" | "REQUEST_ALTERNATIVE" | "ACKNOWLEDGE";
type CurrentDisposition = { id: string; decision: Disposition; outcome: string; simulatedAt: number; recordedAt: string; recordedBy: string };
const DISPOSITION_LABELS: Record<Disposition, string> = {
  APPROVE: "Approve",
  REJECT: "Reject",
  DEFER: "Defer",
  REQUEST_ALTERNATIVE: "Request alternative",
  ACKNOWLEDGE: "Acknowledge warning",
};
const DISPOSITION_PAST: Record<Disposition, string> = {
  APPROVE: "approved it",
  REJECT: "rejected it",
  DEFER: "deferred it",
  REQUEST_ALTERNATIVE: "requested an alternative",
  ACKNOWLEDGE: "acknowledged the warning",
};

export function Recommendation({ data, facility }: { data: SessionData; facility: Facility }) {
  const guidance = useGuidance();
  const snapshot = useScenarioSession((state) => state.simulation.snapshot);
  const [flowPercent, setFlowPercent] = useState(snapshot.recommendation.flowPercent);
  const [durationMinutes, setDurationMinutes] = useState(snapshot.recommendation.durationMinutes);
  const [comparison, setComparison] = useState<WhatIfComparison | null>(null);
  const [evaluation, setEvaluation] = useState<SafetyEvaluation | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pendingReplacement, setPendingReplacement] = useState<{ decision: Disposition; current: CurrentDisposition | null } | null>(null);
  const replacementRef = useRef<HTMLDivElement>(null);
  // The advisory commands the unit the published build advises, such as CDU-03.
  const command = { assetId: snapshot.recommendation.command.assetId, flowPercent, durationMinutes };
  const unitLabel = command.assetId.toUpperCase();

  useEffect(() => {
    void recordLearningEvent("RECOMMENDATION_INSPECTED", {
      facilityId: facility.id,
      simulatedAt: snapshot.simulatedAt,
    });
  }, [facility.id]);

  useEffect(() => {
    setComparison(null);
    setEvaluation(null);
    setMessage("");
    setPendingReplacement(null);
  }, [snapshot.simulatedAt, flowPercent, durationMinutes]);

  useEffect(() => {
    if (pendingReplacement) replacementRef.current?.focus();
  }, [pendingReplacement]);

  const compare = async () => {
    setError("");
    try {
      setComparison(await post<WhatIfComparison>(
        `/api/facilities/${facility.id}/recommendations/rec-17/what-if`,
        { simulatedAt: snapshot.simulatedAt, command },
      ));
      guidance.emit("what-if");
    } catch (cause) { setError(String(cause)); }
  };
  const evaluate = async () => {
    setError("");
    try {
      setEvaluation(await post<SafetyEvaluation>(
        `/api/facilities/${facility.id}/recommendations/rec-17/evaluate`,
        { simulatedAt: snapshot.simulatedAt, command },
      ));
      guidance.emit("safety-run");
    } catch (cause) { setError(String(cause)); }
  };
  // A later disposition replaces the current one only after the operator
  // confirms it; the server rejects a replacement that has gone stale.
  const decide = async (decision: Disposition, replacesDecisionId?: string) => {
    setError("");
    setPendingReplacement(null);
    try {
      const record = await post<Audit>(
        `/api/facilities/${facility.id}/recommendations/rec-17/decisions`,
        {
          decision,
          simulatedAt: snapshot.simulatedAt,
          safetyEvaluationId: evaluation?.id,
          command,
          note,
          replacesDecisionId,
        },
      );
      setMessage(`${decision.replace(/_/g, " ")} recorded as immutable decision #${record.id}.${replacesDecisionId ? " It replaces the earlier disposition, which stays in the audit history." : ""}`);
      guidance.emit("decision-record");
      setEvaluation(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.body.code === "DISPOSITION_REPLACEMENT_REQUIRED") {
        setPendingReplacement({ decision, current: cause.body.currentDecision ?? null });
        return;
      }
      setError(String(cause));
    }
  };
  const evaluationTone = evaluation?.outcome === "PASS" ? "text-teal-300" : evaluation?.outcome === "WARNING" ? "text-amber-300" : "text-red-300";

  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="RECOMMENDATION / REC-17" title={`Pre-emptive ${unitLabel} flow adjustment`} detail={`Bound to ${formatSimulatedAt(snapshot.simulatedAt)}, GPU Training Ramp, and ${facility.model_version}.`}/>
    <ReplayBar/>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(330px,.75fr)]">
      <div className="space-y-4">
        <section className="panel p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><Status tone="warn">ADVISORY · SYNTHETIC</Status><h2 className="mt-3 text-xl font-semibold">{snapshot.recommendation.what}</h2></div><ShieldCheck className="text-cyan-300"/></div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {[
              ["WHY", snapshot.recommendation.why],
              ["WHERE", snapshot.recommendation.where],
              ["EXPECTED EFFECT", snapshot.recommendation.expectedEffect],
              ["CONFIDENCE", `${Math.round(snapshot.recommendation.confidence * 100)}% at the ${snapshot.forecast.horizonS / 60}-minute horizon; quality GOOD inside the disclosed domain.`],
            ].map(([label, value]) => <div key={label} className="subpanel"><span className="eyebrow">{label}</span><p className="text-sm leading-6 text-slate-300">{value}</p></div>)}
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Metric label="Inaction peak" value={snapshot.recommendation.baselinePeakC.toFixed(1)} unit="°C" sub="same initial state" warn/>
            <Metric label="Recommended peak" value={snapshot.recommendation.advisoryPeakC.toFixed(1)} unit="°C" sub={`${snapshot.recommendation.reductionC.toFixed(1)}°C modeled reduction`}/>
            <Metric label="Constraint avoided" value={String(snapshot.recommendation.constraintMinutesAvoided)} unit="min" sub="same events and model"/>
          </div>
          <div className="mt-5 grid gap-2">
            <DisclosureSection label="Advanced: confidence and limitations"><p>Confidence is scoped to this replay state, horizon, and model domain; it is not a probability that an operator decision is correct.</p><ul className="mt-2 list-disc space-y-1 pl-5">{snapshot.recommendation.limitations.map((item) => <li key={item}>{item}</li>)}</ul></DisclosureSection>
            <DisclosureSection label="Engineering: provenance and model binding" engineering><p>{snapshot.recommendation.provenance} · deterministic reduced-order model · {facility.model_version}. The recommendation, Safety Shield result, and recorded decision remain bound to this exact model version and replay instant.</p></DisclosureSection>
          </div>
        </section>

        <DisclosureSection label="Advanced: compare a permitted alternative">
        <section className="p-5" data-guide="what-if">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="eyebrow">WHAT-IF COMPARISON</div><h2 className="mt-2 text-lg font-semibold">Adjust a permitted advisory</h2><p className="copy">Only the advisory parameters change. Initial state, event stream, replay instant, and model version stay fixed.</p></div><SlidersHorizontal className="text-cyan-300"/></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="field">{unitLabel} flow: <b>{flowPercent}%</b><input aria-label={`Alternative ${unitLabel.split("-")[0]} flow percent`} type="range" min="60" max="85" step="1" value={flowPercent} onChange={(event) => setFlowPercent(Number(event.target.value))}/></label>
            <label className="field">Duration: <b>{durationMinutes} minutes</b><input aria-label="Alternative duration minutes" type="range" min="1" max="30" step="1" value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}/></label>
          </div>
          <button className="button secondary mt-5" onClick={compare}><Layers3 size={15}/>Compare identical-input outcomes</button>
          {comparison && <div className="mt-5 grid gap-3 md:grid-cols-3">{comparison.options.map((option) => <article key={option.id} className={`subpanel ${option.id === "alternative" ? "border-cyan-500/60" : ""}`}><div className="flex items-center justify-between gap-2"><b>{option.label}</b>{option.id === "alternative" && <Status>EDITED</Status>}</div><span className="text-2xl font-semibold">{option.peakC.toFixed(1)}<small className="ml-1 text-xs text-slate-500">°C peak</small></span><small>{option.constraintMinutes.toFixed(1)} modeled constraint minutes</small><small>{option.command ? `${option.command.flowPercent}% · ${option.command.durationMinutes} min` : "No advisory action"}</small></article>)}</div>}
        </section>
        </DisclosureSection>
      </div>

      <aside className="space-y-4">
        <section className="panel p-6" data-guide="safety">
          <div className="eyebrow">SAFETY SHIELD · SERVER VERIFIED</div>
          {evaluation ? <>
            <div className="mt-2 flex items-center justify-between"><h2 className={`text-2xl font-semibold ${evaluationTone}`}>{evaluation.outcome}</h2><Status tone={evaluation.outcome === "PASS" ? "good" : evaluation.outcome === "WARNING" ? "warn" : "bad"}>{evaluation.modelVersionId}</Status></div>
            <p className="mt-2 text-xs text-slate-500">Bound to recommendation v{evaluation.recommendationVersion}, this command, user, model, and replay instant.</p>
            <ul className="mt-5 space-y-3">{evaluation.checks.map((check) => <li key={check.id} className="flex gap-3 text-sm"><span className={check.status === "PASS" ? "text-teal-300" : check.status === "WARNING" ? "text-amber-300" : "text-red-300"}>{check.status === "PASS" ? <Check size={16}/> : <X size={16}/>}</span><span><span className="flex items-center gap-2"><b>{check.id.replace(/_/g, " ")}</b><Status tone={check.status === "PASS" ? "good" : check.status === "WARNING" ? "warn" : "bad"}>{check.status}</Status></span><small className="mt-1 block leading-5 text-slate-500">{check.detail}</small></span></li>)}</ul>
          </> : <p className="copy">Run the server-side evaluation after choosing the command. A changed parameter, replay instant, model, or reused result invalidates approval.</p>}
          <ContextualHelp title="Who has decision authority?"><p>The Safety Shield verifies constraints but does not approve the advisory. Only an authorized operator can record a disposition, and approval never sends an equipment command.</p></ContextualHelp>
          {facility.can_assistant && <button className="button primary mt-5 w-full justify-center" onClick={evaluate}><ShieldCheck size={15}/>Run Safety Shield</button>}
          {!facility.can_operate && <p className="mt-3 text-xs leading-5 text-slate-500">You can run the Safety Shield to preview whether this command passes. Only an operator can use a PASS to approve.</p>}
        </section>
        {facility.can_operate ? <section className="panel p-6" data-guide="disposition">
          <div className="eyebrow">OPERATOR DISPOSITION</div>
          <label className="field">Decision note (optional)<textarea className="textarea mt-2 min-h-[76px] w-full" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Record operational context"/></label>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="button primary justify-center" disabled={evaluation?.outcome !== "PASS"} onClick={() => decide("APPROVE")}><Check size={14}/>Approve</button>
            <button className="button secondary justify-center" onClick={() => decide("REJECT")}><X size={14}/>Reject</button>
            <button className="button secondary justify-center" onClick={() => decide("DEFER")}><Clock3 size={14}/>Defer</button>
            <button className="button secondary justify-center" onClick={() => decide("REQUEST_ALTERNATIVE")}><RotateCcw size={14}/>Request alternative</button>
          </div>
          {evaluation?.outcome === "WARNING" && <button className="button secondary mt-2 w-full justify-center" onClick={() => decide("ACKNOWLEDGE")}>Acknowledge warning without approval</button>}
          {pendingReplacement && <div ref={replacementRef} tabIndex={-1} role="alertdialog" aria-labelledby="replace-disposition-title" aria-describedby="replace-disposition-body" className="subpanel mt-4 border-amber-400/60">
            <b id="replace-disposition-title">{pendingReplacement.current ? "Replace the current disposition?" : "The disposition has changed"}</b>
            <p id="replace-disposition-body" className="text-xs leading-5 text-slate-400">{pendingReplacement.current
              ? `${pendingReplacement.current.recordedBy} ${DISPOSITION_PAST[pendingReplacement.current.decision]} at scenario time ${formatSimulatedAt(pendingReplacement.current.simulatedAt).slice(11)}. Recording "${DISPOSITION_LABELS[pendingReplacement.decision]}" makes it the current disposition. The earlier decision stays in the audit history.`
              : "The disposition you were replacing is no longer current. Review the recommendation, then record your decision again."}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {pendingReplacement.current && <button className="button primary" onClick={() => decide(pendingReplacement.decision, pendingReplacement.current!.id)}>Replace with {DISPOSITION_LABELS[pendingReplacement.decision]}</button>}
              <button className="button secondary" onClick={() => setPendingReplacement(null)}>{pendingReplacement.current ? "Keep current disposition" : "Dismiss"}</button>
            </div>
          </div>}
          <p className="mt-3 text-[11px] leading-5 text-slate-500">Approval is available only for an unused, unexpired PASS. This records an advisory disposition; it never sends an equipment command.</p>
        </section> : <section className="panel p-6 text-sm leading-6 text-slate-500">View-only for your role. You can compare outcomes and preview the Safety Shield, but only an operator can approve, reject, defer, or request an alternative.</section>}
        {error && <p role="alert" className="panel p-4 text-sm text-red-300">{error}</p>}
        {message && <p role="status" className="panel p-4 text-sm text-teal-300">{message}</p>}
      </aside>
    </div>
  </Shell>;
}
