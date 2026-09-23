import { useEffect, useRef, useState } from "react";
import type { CatalogRow } from "../library/catalog.ts";
import type { LibraryController, LibraryState } from "../library/controller.ts";
import { SourcePreview, type SourceWaveform } from "../library/preview.ts";
import { normalizeTags } from "../library/tags.ts";
import { MaterialSurface } from "../skins/MaterialRoot.tsx";
import { Button, Icon } from "./controls.tsx";
import { TrackerIcon } from "./tracker-icons.tsx";

const PITCH_NAMES = [
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

export function SampleInspector({
  state,
  controller,
  preview,
  onClose,
}: {
  state: LibraryState;
  controller: LibraryController;
  preview: SourcePreview;
  onClose: () => void;
}) {
  const sample = state.catalog.rows.find((row) => row.path === state.selected);
  const analysis =
    state.analysis?.path === sample?.path ? state.analysis : undefined;
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const [waveform, setWaveform] = useState<SourceWaveform | null>(null);
  const [waveMessage, setWaveMessage] = useState("");
  const [waveBusy, setWaveBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    preview.cancelWaveform();
    setTag("");
    setError("");
    setWaveform(null);
    setWaveMessage("");
    setWaveBusy(false);
    return () => {
      generation.current++;
      preview.cancelWaveform();
    };
  }, [state.selected, preview]);
  const loadWaveform = async (row: CatalogRow) => {
    const sequence = ++generation.current;
    setWaveBusy(true);
    setWaveMessage("Reading waveform.");
    try {
      const result = await preview.waveform(row);
      if (sequence !== generation.current) return;
      setWaveform(result);
      setWaveMessage(result ? "Source waveform." : "Waveform request stopped.");
    } catch (failure) {
      if (sequence === generation.current)
        setWaveMessage(
          failure instanceof Error
            ? failure.message
            : "The waveform could not be read. Try again.",
        );
    } finally {
      if (sequence === generation.current) setWaveBusy(false);
    }
  };
  const tags = sample ? controller.tags(sample.path) : [];
  const tagStatus = sample ? state.tagStatus[sample.path] : undefined;
  const addTag = () => {
    if (!sample) return;
    try {
      controller.editTags(sample.path, normalizeTags([...tags, tag]));
      setTag("");
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The tag is not valid.",
      );
    }
  };
  return (
    <MaterialSurface
      as="section"
      className="inspector-panel"
      aria-label="Sample inspector"
    >
      <header className="tracker-panel-heading">
        <h2>Sample</h2>
        <Button
          className="tracker-button icon-button"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      {!sample ? (
        <p className="tracker-empty">
          Select a sample to inspect its source and tags.
        </p>
      ) : (
        <div className="inspector-body">
          <h3 className="inspector-filename">{sample.name}</h3>
          <p className="relative-path">{sample.path}</p>
          <p
            className="sample-readiness"
            data-status={analysis?.status}
            role="status"
          >
            {analysis?.status === "ready"
              ? "Ready"
              : analysis?.status === "needs-conversion"
                ? "Needs conversion"
                : analysis?.status === "needs-review"
                  ? "Needs review"
                  : analysis?.status === "unusable"
                    ? "Unusable"
                    : analysis?.status === "error"
                      ? "Analysis unavailable"
                      : "Analyzing source"}
          </p>
          <div className="waveform-panel">
            {waveform ? (
              <svg
                viewBox="0 0 256 100"
                role="img"
                aria-label={`Source waveform: ${sample.path}`}
                preserveAspectRatio="none"
              >
                <path d="M0 50H256" className="waveform-baseline" />
                {waveform.peaks.map((peak, i) => (
                  <path
                    key={i}
                    d={`M${i} ${50 - Math.min(1, peak) * 46}v${Math.max(1, Math.min(1, peak) * 92)}`}
                  />
                ))}
              </svg>
            ) : (
              <Button
                className="tracker-button"
                disabled={waveBusy}
                onClick={() => void loadWaveform(sample)}
              >
                {waveBusy ? "Reading waveform…" : "Show waveform"}
              </Button>
            )}
          </div>
          <p className="waveform-message" role="status">
            {waveMessage}
          </p>
          <div className="inspector-preview">
            <Button
              className="tracker-button primary"
              onClick={() => void preview.play(sample)}
              tip="Play the unchanged source audio."
            >
              <TrackerIcon name="play" />
              Play source
            </Button>
            {analysis?.status === "ready" ? (
              <Button
                className="tracker-button"
                onClick={() => void preview.play(sample)}
                tip="Play the analyzed source without a change to its audio."
              >
                Play ready source
              </Button>
            ) : (
              <Button
                className="tracker-button"
                aria-disabled="true"
                tip="This sample has no ready audio."
              >
                Play prepared
              </Button>
            )}
          </div>
          {state.metadata ? (
            <dl className="sample-metadata">
              <dt>Format</dt>
              <dd>WAV</dd>
              <dt>Encoding</dt>
              <dd>
                {state.metadata.encoding === "float32"
                  ? "32-bit float"
                  : state.metadata.encoding === "pcm24"
                    ? "24-bit PCM"
                    : "16-bit PCM"}
              </dd>
              <dt>Channels</dt>
              <dd>{state.metadata.channels === 1 ? "Mono" : "Stereo"}</dd>
              <dt>Rate</dt>
              <dd>{state.metadata.sampleRate / 1000} kHz</dd>
              <dt>Duration</dt>
              <dd>{state.metadata.duration.toFixed(2)} s</dd>
            </dl>
          ) : (
            <p className="inspector-message" role="status">
              {state.metadataMessage}
            </p>
          )}
          <section className="inspector-section" aria-label="Audio analysis">
            <h3>Analysis</h3>
            <p className="inspector-message" role="status">
              {analysis?.message ?? "Select a source to start analysis."}
            </p>
            {analysis?.status === "error" && (
              <Button
                className="tracker-button"
                onClick={() => void controller.select(sample.path)}
                tip="Read and analyze this source again."
              >
                Check again
              </Button>
            )}
            {analysis?.result && (
              <dl className="sample-metadata">
                <dt>Sound class</dt>
                <dd>
                  {analysis.result.analysis.measured.sampleKind.replaceAll(
                    "-",
                    " ",
                  )}
                </dd>
                {analysis.result.analysis.measured.bpm !== undefined && (
                  <>
                    <dt>
                      {analysis.result.analysis.measured.sampleKind.startsWith(
                        "source-backed-",
                      )
                        ? "Validated source tempo"
                        : "Measured tempo"}
                    </dt>
                    <dd>{analysis.result.analysis.measured.bpm} BPM</dd>
                  </>
                )}
                {analysis.result.analysis.measured.key && (
                  <>
                    <dt>Measured key</dt>
                    <dd>
                      {analysis.result.analysis.measured.key}{" "}
                      {analysis.result.analysis.measured.minorForm} minor
                    </dd>
                  </>
                )}
                {analysis.result.analysis.measured.compatiblePitchClasses && (
                  <>
                    <dt>Compatible notes</dt>
                    <dd>
                      {analysis.result.analysis.measured.compatiblePitchClasses
                        .map((pitch) => PITCH_NAMES[pitch])
                        .join(", ")}
                    </dd>
                  </>
                )}
                {analysis.result.analysis.measured.compatibleMinorForms && (
                  <>
                    <dt>Compatible forms</dt>
                    <dd>
                      {analysis.result.analysis.measured.compatibleMinorForms.join(
                        ", ",
                      )}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {analysis?.result?.analysis.measured.sampleKind.startsWith(
              "source-backed-",
            ) && (
              <p className="muted">
                Audio checks passed. The source record supplies the declared
                musical values; no source key was detected from this file.
              </p>
            )}
            <p className="muted">
              Declared source values:{" "}
              {analysis?.result?.declared
                ? `${analysis.result.declared.bpm} BPM, ${analysis.result.declared.key} from OG.`
                : "Not recorded."}
            </p>
            <p className="muted">User corrections: Not recorded.</p>
          </section>
          <section className="inspector-section">
            <h3>Prepared</h3>
            <p className="muted">
              {analysis?.status === "ready"
                ? "Uses unchanged source audio."
                : "No ready audio."}
            </p>
          </section>
          <section className="inspector-section" aria-label="Split stereo pair">
            <h3>Split stereo pair</h3>
            <p className="muted">
              Select two mono files. Assign their left and right channels.
            </p>
            <div className="pair-select-row">
              <Button
                className="tracker-button"
                disabled={state.metadata?.channels !== 1}
                aria-pressed={state.pairDraft.leftPath === sample.path}
                onClick={() => controller.setPairSide("left", sample.path)}
                tip="Use this mono file as the left source channel."
              >
                Use as left
              </Button>
              <Button
                className="tracker-button"
                disabled={state.metadata?.channels !== 1}
                aria-pressed={state.pairDraft.rightPath === sample.path}
                onClick={() => controller.setPairSide("right", sample.path)}
                tip="Use this mono file as the right source channel."
              >
                Use as right
              </Button>
            </div>
            <dl className="sample-metadata pair-paths">
              <dt>Left</dt>
              <dd>{state.pairDraft.leftPath ?? "Not selected"}</dd>
              <dt>Right</dt>
              <dd>{state.pairDraft.rightPath ?? "Not selected"}</dd>
            </dl>
            <div className="pair-select-row">
              <Button
                className="tracker-button"
                disabled={
                  !state.pairDraft.leftPath ||
                  !state.pairDraft.rightPath ||
                  state.pair?.status === "checking"
                }
                onClick={() => void controller.checkPair()}
                tip="Confirm these files share a source. Check channel alignment and musical compatibility."
              >
                Confirm and check pair
              </Button>
              <Button
                className="tracker-button"
                disabled={
                  !state.pairDraft.leftPath && !state.pairDraft.rightPath
                }
                onClick={() => controller.clearPair()}
              >
                Clear pair
              </Button>
            </div>
            <p
              className="pair-status"
              data-status={state.pair?.status}
              role="status"
            >
              {state.pair?.status === "ready"
                ? "Pair ready. Both channels passed analysis."
                : (state.pair?.message ?? "No pair check is recorded.")}
            </p>
          </section>
          <section className="inspector-section">
            <h3>Tags</h3>
            <div className="editable-tags">
              {tags.map((value) => (
                <Button
                  key={value}
                  className="tag-chip"
                  aria-label={`Remove tag: ${value}`}
                  disabled={!state.tagsReadable || tagStatus === "saving"}
                  onClick={() =>
                    controller.editTags(
                      sample.path,
                      tags.filter((item) => item !== value),
                    )
                  }
                >
                  {value}
                  <Icon name="close" />
                </Button>
              ))}
            </div>
            <form
              className="new-tag-form"
              onSubmit={(event) => {
                event.preventDefault();
                addTag();
              }}
            >
              <input
                aria-label="New tag"
                placeholder="New tag"
                value={tag}
                disabled={!state.tagsReadable || tagStatus === "saving"}
                maxLength={40}
                onChange={(event) => setTag(event.target.value)}
              />
              <Button
                className="tracker-button"
                aria-label="Add tag"
                disabled={
                  !state.tagsReadable || !tag.trim() || tagStatus === "saving"
                }
                onClick={addTag}
              >
                <Icon name="plus" />
              </Button>
            </form>
            {error && (
              <p className="tracker-error" role="alert">
                {error}
              </p>
            )}
            <div className="tag-save-row">
              <Button
                className="tracker-button"
                disabled={
                  !state.tagsReadable ||
                  !state.drafts[sample.path] ||
                  tagStatus === "saving"
                }
                onClick={() => void controller.saveTags(sample.path)}
              >
                {tagStatus === "error" ? "Retry tag save" : "Save tags"}
              </Button>
              <span
                role="status"
                className={tagStatus === "error" ? "tracker-error" : "muted"}
              >
                {!state.tagsReadable
                  ? "Tags unavailable."
                  : tagStatus === "saving"
                    ? "Saving tags."
                    : tagStatus === "error" || tagStatus === "unsaved"
                      ? "Tags not saved."
                      : "Tags saved."}
              </span>
            </div>
            {state.tagErrors[sample.path] && (
              <p className="tracker-error" role="alert">
                {state.tagErrors[sample.path]}
              </p>
            )}
            {(tagStatus === "error" || !state.tagsReadable) && (
              <Button
                className="tracker-button"
                disabled={tagStatus === "saving"}
                onClick={() => void controller.reloadSavedTags(sample.path)}
                tip="Discard this sample's tag changes and read its saved tags."
              >
                Reload saved tags
              </Button>
            )}
          </section>
          <section className="inspector-section">
            <h3>Source category</h3>
            <p className="muted">Not recorded</p>
          </section>
          <details className="source-history">
            <summary>Source history</summary>
            <p>No source history is recorded for this file.</p>
            <p className="relative-path">{sample.path}</p>
          </details>
        </div>
      )}
    </MaterialSurface>
  );
}
