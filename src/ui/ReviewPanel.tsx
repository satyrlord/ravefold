import { useEffect, useId, useState } from "react";
import type { AudioAnalysis } from "../audio/analyze.ts";
import { ACTIVE_PHASES, type PreparationJob } from "../domain/preparation.ts";
import {
  KEY_NAMES,
  parseKeyName,
  regionLabel,
  type SourceRegion,
  type TonalClass,
} from "../domain/review.ts";
import type { CatalogRow } from "../library/catalog.ts";
import type {
  LibraryController,
  LibraryState,
  SourceAnalysisState,
} from "../library/controller.ts";
import type { SourcePreview } from "../library/preview.ts";
import { EMPTY_REVIEW, type ReviewInput } from "../library/review.ts";
import { Button } from "./controls.tsx";
import { JobStatus, PHASE_LABELS, PlanSummary } from "./PreparationPanel.tsx";

export const PITCH_NAMES = [
  "C",
  "C sharp",
  "D",
  "E flat",
  "E",
  "F",
  "F sharp",
  "G",
  "A flat",
  "A",
  "B flat",
  "B",
] as const;

/** Form values. Empty text means that the user supplies no value. */
export interface ReviewDraft {
  bpm: string;
  key: string;
  tonalClass: "" | TonalClass;
  start: string;
  end: string;
}

export const EMPTY_DRAFT: ReviewDraft = {
  bpm: "",
  key: "",
  tonalClass: "",
  start: "",
  end: "",
};

const STATUS_LABELS = {
  checking: "Checking",
  ready: "Ready",
  "needs-conversion": "Needs conversion",
  "needs-review": "Needs review",
  invalid: "Input not sent",
  error: "Validation unavailable",
} as const;

const ONE_SHOTS = new Set(["unpitched-one-shot", "source-backed-one-shot"]);
const KEY_NEUTRAL = new Set(["unpitched-one-shot", "key-neutral-loop"]);

/** Six decimals give the same frame again at supported sample rates. */
function seconds(frame: number, sampleRate: number): string {
  return String(Number((frame / sampleRate).toFixed(6)));
}

export function draftFor(input: ReviewInput, sampleRate: number): ReviewDraft {
  return {
    bpm: input.bpm === null ? "" : String(input.bpm),
    key: input.key ?? "",
    tonalClass: input.tonalClass ?? "",
    start: input.region ? seconds(input.region.startFrame, sampleRate) : "",
    end: input.region
      ? seconds(input.region.endFrameExclusive, sampleRate)
      : "",
  };
}

/** Give the draft region in frames, or a reason that it is not complete. */
export function draftRegion(
  draft: ReviewDraft,
  sampleRate: number,
): { region: SourceRegion | null } | { problem: string } {
  const start = draft.start.trim();
  const end = draft.end.trim();
  if (!start && !end) return { region: null };
  if (!start || !end)
    return { problem: "Enter the start and the end of the region." };
  const startSeconds = Number(start);
  const endSeconds = Number(end);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds))
    return { problem: "Region times must be numbers of seconds." };
  return {
    region: {
      startFrame: Math.round(startSeconds * sampleRate),
      endFrameExclusive: Math.round(endSeconds * sampleRate),
    },
  };
}

function keyLabel(key: string): string {
  const choice = parseKeyName(key);
  return choice ? `${PITCH_NAMES[choice.root]} ${choice.mode}` : key;
}

/** A readable list of the corrected values in one input. */
export function inputSummary(input: ReviewInput, sampleRate: number): string {
  const parts = [
    input.bpm !== null ? `${input.bpm} BPM` : "",
    input.tonalClass === "key-neutral"
      ? "key-neutral"
      : input.tonalClass === "tonal"
        ? "tonal"
        : "",
    input.key ? keyLabel(input.key) : "",
    input.region
      ? `section ${regionLabel(input.region, sampleRate)}`
      : "whole source",
  ].filter(Boolean);
  return parts.join(", ");
}

function score(value: number): string {
  return value.toFixed(2);
}

function MeasuredEvidence({ analysis }: { analysis: AudioAnalysis }) {
  const measured = analysis.measured;
  return (
    <>
      <dl className="sample-metadata review-evidence">
        {measured.estimatedBpm !== undefined && (
          <>
            <dt>Attack tempo estimate</dt>
            <dd>{measured.estimatedBpm} BPM</dd>
          </>
        )}
        <dt>Rhythm score</dt>
        <dd>{score(measured.detectorScores.rhythm)} of 1</dd>
        <dt>Pitch score</dt>
        <dd>{score(measured.detectorScores.pitch)} of 1</dd>
      </dl>
      <p className="muted">
        Scores show detector agreement. They are not probabilities.
      </p>
    </>
  );
}

function SectionJob({
  job,
  state,
  controller,
  preview,
  sample,
}: {
  job: PreparationJob;
  state: LibraryState;
  controller: LibraryController;
  preview: SourcePreview;
  sample: CatalogRow;
}) {
  const busy = job.phase === "queued" || ACTIVE_PHASES.includes(job.phase);
  const stopped = state.preparation.recoveryRequired;
  const output =
    job.phase === "ready" && job.output
      ? state.catalog.rows.find((row) => row.path === job.output!.path)
      : undefined;
  return (
    <>
      <JobStatus
        job={job}
        progress={state.preparation.progress[job.id]}
        session={state.preparation.session}
      />
      {job.outputPath && <p className="relative-path">{job.outputPath}</p>}
      <div className="pair-select-row">
        {busy && !stopped && (
          <Button
            className="tracker-button"
            onClick={() => void controller.cancelPreparation(job.id)}
            tip="Stop this preparation. Existing and partial audio stay unchanged."
          >
            Cancel preparation
          </Button>
        )}
        {!stopped && (job.phase === "failed" || job.phase === "cancelled") && (
          <Button
            className="tracker-button"
            onClick={() => void controller.retryPreparation(job.id)}
            tip="Prepare this section again at a new output path."
          >
            Retry preparation
          </Button>
        )}
        {output && (
          <Button
            className="tracker-button"
            onClick={() => void preview.play(output)}
            tip={`Play the validated file from ${sample.name}.`}
          >
            Play prepared section
          </Button>
        )}
      </div>
    </>
  );
}

/** Correct source values or select a section, then validate them again. */
export function ReviewPanel({
  sample,
  analysis,
  state,
  controller,
  preview,
  draft,
  onDraft,
}: {
  sample: CatalogRow;
  analysis: SourceAnalysisState;
  state: LibraryState;
  controller: LibraryController;
  preview: SourcePreview;
  draft: ReviewDraft;
  onDraft: (draft: ReviewDraft) => void;
}) {
  const id = useId();
  const result = analysis.result!;
  const measured = result.analysis;
  const sampleRate = result.info.sampleRate;
  const review = state.review?.path === sample.path ? state.review : undefined;
  const [formError, setFormError] = useState("");
  useEffect(() => setFormError(""), [sample.path]);
  const kind = measured.measured.sampleKind;
  const tempoApplies = !ONE_SHOTS.has(kind);
  const keyApplies =
    draft.tonalClass === "tonal" ||
    (draft.tonalClass === "" && !KEY_NEUTRAL.has(kind));
  const set = (patch: Partial<ReviewDraft>) => {
    setFormError("");
    onDraft({ ...draft, ...patch });
  };
  const region = draftRegion(draft, sampleRate);
  const send = () => {
    if ("problem" in region) {
      setFormError(region.problem);
      return;
    }
    const bpm = draft.bpm.trim();
    const value = bpm ? Number(bpm) : null;
    if (value !== null && !Number.isFinite(value)) {
      setFormError("The source tempo must be a number.");
      return;
    }
    void controller.submitReview({
      bpm: tempoApplies ? value : null,
      key: keyApplies && draft.key ? draft.key : null,
      tonalClass: draft.tonalClass || null,
      region: region.region,
    });
  };
  const job = controller.reviewPreparation();
  const earlier = controller
    .sectionPreparations(sample.path, result.sourceSha256)
    .filter((item) => item.id !== job?.id);
  const playable =
    "region" in region &&
    region.region &&
    region.region.endFrameExclusive > region.region.startFrame &&
    region.region.startFrame >= 0 &&
    region.region.endFrameExclusive <= result.info.frames
      ? region.region
      : null;
  return (
    <section className="inspector-section" aria-label="Review">
      <h3>Review</h3>
      <p className="muted">Reason for review: {measured.reasons.join(" ")}</p>
      <MeasuredEvidence analysis={measured} />
      <form
        className="review-form"
        aria-label="Review input"
        // The application validates input and gives each problem as text.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="review-fields">
          <label htmlFor={`${id}-class`}>Tonal class</label>
          <select
            id={`${id}-class`}
            value={draft.tonalClass}
            onChange={(event) =>
              set({
                tonalClass: event.target.value as ReviewDraft["tonalClass"],
                ...(event.target.value === "key-neutral" ? { key: "" } : {}),
              })
            }
          >
            <option value="">Not corrected</option>
            <option value="tonal">Tonal</option>
            <option value="key-neutral">Key-neutral</option>
          </select>
          {tempoApplies && (
            <>
              <label htmlFor={`${id}-bpm`}>Source tempo (BPM)</label>
              <input
                id={`${id}-bpm`}
                type="number"
                inputMode="decimal"
                min={20}
                max={400}
                step="any"
                placeholder="Not corrected"
                value={draft.bpm}
                onChange={(event) => set({ bpm: event.target.value })}
              />
            </>
          )}
          {keyApplies && (
            <>
              <label htmlFor={`${id}-key`}>Source key</label>
              <select
                id={`${id}-key`}
                value={draft.key}
                onChange={(event) => set({ key: event.target.value })}
              >
                <option value="">Not corrected</option>
                <optgroup label="Minor">
                  {KEY_NAMES.map((name, root) => (
                    <option key={`${name} minor`} value={`${name} minor`}>
                      {PITCH_NAMES[root]} minor
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Major">
                  {KEY_NAMES.map((name, root) => (
                    <option key={`${name} major`} value={`${name} major`}>
                      {PITCH_NAMES[root]} major
                    </option>
                  ))}
                </optgroup>
              </select>
            </>
          )}
        </div>
        <fieldset className="review-region">
          <legend>Region of the source (seconds)</legend>
          <p className="muted">
            Leave both empty to use the whole source. Source length{" "}
            {result.info.duration.toFixed(3)} s.
          </p>
          <div className="review-fields">
            <label htmlFor={`${id}-start`}>Region start</label>
            <input
              id={`${id}-start`}
              type="number"
              inputMode="decimal"
              min={0}
              max={result.info.duration}
              step="any"
              value={draft.start}
              onChange={(event) => set({ start: event.target.value })}
            />
            <label htmlFor={`${id}-end`}>Region end</label>
            <input
              id={`${id}-end`}
              type="number"
              inputMode="decimal"
              min={0}
              max={result.info.duration}
              step="any"
              value={draft.end}
              onChange={(event) => set({ end: event.target.value })}
            />
          </div>
          <div className="pair-select-row">
            <Button
              type="button"
              className="tracker-button"
              disabled={!playable}
              onClick={() =>
                playable &&
                void preview.play(sample, {
                  offset: playable.startFrame / sampleRate,
                  duration:
                    (playable.endFrameExclusive - playable.startFrame) /
                    sampleRate,
                })
              }
              tip="Play this section of the unchanged source. Status does not change."
            >
              Play section
            </Button>
            <Button
              type="button"
              className="tracker-button"
              disabled={!draft.start && !draft.end}
              onClick={() => set({ start: "", end: "" })}
            >
              Use whole source
            </Button>
          </div>
        </fieldset>
        {formError && (
          <p className="tracker-error" role="alert">
            {formError}
          </p>
        )}
        <div className="pair-select-row">
          <Button
            type="submit"
            className="tracker-button primary"
            tip="Analyze the source or section again with these values. Corrections cannot bypass analysis."
          >
            Validate again
          </Button>
          <Button
            type="button"
            className="tracker-button"
            disabled={!review || review.status === "invalid"}
            onClick={() => {
              onDraft(EMPTY_DRAFT);
              void controller.submitReview(EMPTY_REVIEW);
            }}
            tip="Remove the saved corrections and region. Analyze the source again."
          >
            Clear corrections
          </Button>
        </div>
      </form>
      <div className="review-result">
        <p
          className="review-status"
          data-status={review?.status}
          role={
            review?.status === "invalid" || review?.status === "error"
              ? "alert"
              : "status"
          }
        >
          {review
            ? `${STATUS_LABELS[review.status]}. ${review.message}`
            : "No corrected input is recorded."}
        </p>
        {review && review.status !== "invalid" && (
          <p className="muted">
            Validated input: {inputSummary(review.input, sampleRate)}.
          </p>
        )}
        {review?.reviewed && !review.input.region && (
          <p className="muted">
            The source status uses this result. Source audio stays unchanged.
          </p>
        )}
        {review?.reviewed && review.input.region && (
          <>
            <p className="muted">
              A section result does not change the source status. Only a
              validated new file of the section can be ready.
            </p>
            {review.plan?.valid ? (
              <>
                <PlanSummary plan={review.plan.plan} />
                {job ? (
                  <SectionJob
                    job={job}
                    state={state}
                    controller={controller}
                    preview={preview}
                    sample={sample}
                  />
                ) : (
                  <Button
                    className="tracker-button primary"
                    disabled={!state.preparation.readable}
                    onClick={() => void controller.prepareReview()}
                    tip="Make a new file from this section in the sample folder. Earlier files stay unchanged."
                  >
                    Prepare section
                  </Button>
                )}
              </>
            ) : (
              <p className="muted">{review.plan?.reason}</p>
            )}
          </>
        )}
      </div>
      {earlier.length > 0 && (
        <details className="source-history review-history">
          <summary>Earlier section results ({earlier.length})</summary>
          <ul>
            {earlier.map((item) => (
              <li key={item.id}>
                <span>
                  Section{" "}
                  {item.plan.region &&
                    regionLabel(item.plan.region, item.plan.sampleRate)}
                  : {PHASE_LABELS[item.phase]}
                </span>
                {item.outputPath && (
                  <span className="relative-path">{item.outputPath}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
