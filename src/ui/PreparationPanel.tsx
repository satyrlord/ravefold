import type { CatalogRow } from "../library/catalog.ts";
import type {
  LibraryController,
  LibraryState,
  SourceAnalysisState,
} from "../library/controller.ts";
import {
  ACTIVE_PHASES,
  type PreparationJob,
  type PreparationPhase,
  type PreparationPlan,
} from "../domain/preparation.ts";
import { regionLabel } from "../domain/review.ts";
import { Button } from "./controls.tsx";

export const PHASE_LABELS: Record<PreparationPhase, string> = {
  queued: "Queued",
  analysis: "Analysis",
  conversion: "Conversion",
  validation: "Validation",
  ready: "Ready",
  review: "Review",
  failed: "Failed",
  cancelled: "Cancelled",
};

function pitchChange(semitones: number): string {
  if (!semitones) return "None";
  const size = Math.abs(semitones);
  return `${semitones > 0 ? "Up" : "Down"} ${size} semitone${size === 1 ? "" : "s"}`;
}

export function PlanSummary({ plan }: { plan: PreparationPlan }) {
  return (
    <dl className="sample-metadata preparation-plan">
      <dt>Source tempo</dt>
      <dd>{plan.sourceBpm} BPM</dd>
      <dt>Target tempo</dt>
      <dd>{plan.targetBpm} BPM</dd>
      <dt>Beats</dt>
      <dd>{plan.beatCount}</dd>
      <dt>Pitch change</dt>
      <dd>{pitchChange(plan.semitones)}</dd>
      <dt>Input</dt>
      <dd>
        {plan.region
          ? `Section ${regionLabel(plan.region, plan.sampleRate)}`
          : "Whole source"}
      </dd>
    </dl>
  );
}

export function JobStatus({
  job,
  progress,
  session,
}: {
  job: PreparationJob;
  progress: number | undefined;
  session: string;
}) {
  const active = ACTIVE_PHASES.includes(job.phase);
  const percent = Math.round((progress ?? 0) * 100);
  return (
    <>
      <p
        className="preparation-status"
        data-phase={job.phase}
        role={job.phase === "failed" ? "alert" : "status"}
      >
        {PHASE_LABELS[job.phase]}. {job.message}
      </p>
      {active && job.lease?.session !== session && (
        <p className="muted">
          Another session holds this job. It restarts here if that session
          stops.
        </p>
      )}
      {active && (
        <div
          className="preparation-progress"
          role="progressbar"
          aria-label={`${PHASE_LABELS[job.phase]} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
    </>
  );
}

/** Show the preparation plan, job phase and controls for one source. */
export function PreparationPanel({
  sample,
  analysis,
  state,
  controller,
}: {
  sample: CatalogRow;
  analysis: SourceAnalysisState | undefined;
  state: LibraryState;
  controller: LibraryController;
}) {
  const job = controller.wholePreparation(
    sample.path,
    analysis?.result?.sourceSha256,
  );
  const plan = analysis?.plan;
  const busy =
    job && (job.phase === "queued" || ACTIVE_PHASES.includes(job.phase));
  return (
    <section className="inspector-section" aria-label="Preparation">
      <h3>Prepared</h3>
      {job ? (
        <>
          <PlanSummary plan={job.plan} />
          {state.preparation.recoveryRequired && busy ? (
            <p className="preparation-status" data-phase="failed" role="status">
              Preparation stopped. Restore access to the preparation record.
            </p>
          ) : (
            <JobStatus
              job={job}
              progress={state.preparation.progress[job.id]}
              session={state.preparation.session}
            />
          )}
          {job.outputPath && <p className="relative-path">{job.outputPath}</p>}
          <div className="pair-select-row">
            {busy && !state.preparation.recoveryRequired && (
              <Button
                className="tracker-button"
                onClick={() => void controller.cancelPreparation(job.id)}
                tip="Stop this preparation. Existing and partial audio stay unchanged."
              >
                Cancel preparation
              </Button>
            )}
            {!state.preparation.recoveryRequired &&
              (job.phase === "failed" || job.phase === "cancelled") && (
                <Button
                  className="tracker-button"
                  onClick={() => void controller.retryPreparation(job.id)}
                  tip="Prepare again at a new output path."
                >
                  Retry preparation
                </Button>
              )}
          </div>
        </>
      ) : analysis?.status === "ready" ? (
        <p className="muted">Uses unchanged source audio.</p>
      ) : plan?.valid ? (
        <>
          <PlanSummary plan={plan.plan} />
          <Button
            className="tracker-button primary"
            disabled={!state.preparation.readable}
            onClick={() => void controller.prepare()}
            tip="Make a new file in the sample folder. Preparation stops if this tab closes."
          >
            Prepare sample
          </Button>
        </>
      ) : (
        <p className="muted">
          {plan && !plan.valid && analysis?.status === "needs-conversion"
            ? plan.reason
            : "No ready audio."}
        </p>
      )}
      {state.preparationError && (
        <p className="tracker-error" role="alert">
          {state.preparationError}
        </p>
      )}
      {state.preparation.message && (
        <p className="tracker-error" role="alert">
          {state.preparation.message}
        </p>
      )}
      {state.preparation.recoveryRequired && (
        <Button
          className="tracker-button"
          onClick={() => void controller.recoverPreparation()}
          tip="Read the saved preparation record and restart incomplete work at a new path."
        >
          Recover preparation
        </Button>
      )}
    </section>
  );
}
