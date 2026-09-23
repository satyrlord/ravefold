import { useState } from "react";
import type { EntryResult } from "../domain/entry.ts";
import { MaterialSurface } from "../skins/MaterialRoot.tsx";
import { Button, Icon } from "./controls.tsx";
import { TrackerIcon } from "./tracker-icons.tsx";

const playbackTip =
  "Arrangement playback is unavailable. Use source preview to hear a sample.";
export function Transport() {
  return (
    <MaterialSurface
      as="section"
      className="tracker-transport"
      aria-label="Transport"
    >
      <div className="transport-actions">
        {(["start", "play", "pause", "stop"] as const).map((name) => (
          <Button
            key={name}
            className={`tracker-button icon-button ${name === "play" ? "primary" : ""}`}
            aria-label={`Arrangement ${name}`}
            aria-disabled="true"
            tip={playbackTip}
          >
            <TrackerIcon name={name} />
          </Button>
        ))}
      </div>
      <output className="position-display" aria-label="Arrangement position">
        001 : 01 : 000
      </output>
      <div className="tracker-timing">
        <b>
          180 <span>BPM</span>
        </b>
        <b>
          C <span>minor</span>
        </b>
      </div>
      <Button className="tracker-button" aria-disabled="true" tip={playbackTip}>
        <TrackerIcon name="loop" />
        Loop
      </Button>
      <span className="snap-display">Snap: 1 bar</span>
      <div className="transport-history">
        <Button
          className="tracker-button"
          aria-disabled="true"
          tip="No arrangement edits are available to undo."
        >
          <TrackerIcon name="undo" />
          Undo
        </Button>
        <Button
          className="tracker-button"
          aria-disabled="true"
          tip="No arrangement edits are available to redo."
        >
          <TrackerIcon name="redo" />
          Redo
        </Button>
      </div>
    </MaterialSurface>
  );
}

export function Arrangement({ entry }: { entry: EntryResult }) {
  const [zoom, setZoom] = useState(1);
  const tracks = [...entry.project.tracks].sort((a, b) => a.order - b.order);
  const missing = new Set(entry.missingSamples.map((clip) => clip.clipId));
  const barTicks = entry.project.ticksPerBeat * entry.project.beatsPerBar;
  const lastBar = entry.project.clips.reduce(
    (end, clip) =>
      Math.max(
        end,
        Math.ceil((clip.startTick + clip.durationTicks) / barTicks),
      ),
    32,
  );
  // Keep long projects within browser layout bounds without omitting clips.
  const barWidth = Math.min(48 * zoom, 16_000_000 / lastBar);
  const width = lastBar * barWidth;
  const rulerStep = Math.max(4, Math.ceil(lastBar / 128 / 4) * 4);
  return (
    <MaterialSurface
      as="section"
      className="arrangement-panel"
      aria-labelledby="arrangement-heading"
    >
      <header className="tracker-panel-heading">
        <h2 id="arrangement-heading">Arrangement</h2>
        <Button
          className="tracker-button"
          aria-disabled="true"
          tip="Track edits are unavailable in this version."
        >
          <Icon name="plus" />
          Track
        </Button>
        <div className="timeline-zoom">
          <Button
            className="tracker-button"
            aria-label="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => z / 2)}
          >
            −
          </Button>
          <output>{Math.round(zoom * 100)}%</output>
          <Button
            className="tracker-button"
            aria-label="Zoom in"
            disabled={zoom >= 4}
            onClick={() => setZoom((z) => z * 2)}
          >
            +
          </Button>
        </div>
      </header>
      <div
        className="arrangement-scroll"
        tabIndex={0}
        aria-label="Arrangement tracks"
      >
        <div
          className="timeline-content"
          style={
            {
              width: width + 150,
              "--bar-width": `${barWidth}px`,
            } as React.CSSProperties
          }
        >
          <div className="timeline-ruler">
            <div className="track-corner">Tracks</div>
            <div className="bar-ruler">
              {Array.from(
                { length: Math.ceil(lastBar / rulerStep) },
                (_, i) => (
                  <span key={i} style={{ left: i * rulerStep * barWidth }}>
                    {i * rulerStep + 1}
                  </span>
                ),
              )}
            </div>
          </div>
          {tracks.map((track, i) => (
            <div className="timeline-track" key={track.id}>
              <div className="track-header">
                <span className="track-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{track.name}</span>
                <span className="track-switches">
                  <span
                    className={track.mute ? "on" : ""}
                    aria-label={track.mute ? "Muted" : "Not muted"}
                  >
                    M
                  </span>
                  <span
                    className={track.solo ? "on" : ""}
                    aria-label={track.solo ? "Solo" : "Not solo"}
                  >
                    S
                  </span>
                </span>
              </div>
              <div className="track-grid">
                {entry.project.clips
                  .filter((clip) => clip.trackId === track.id)
                  .map((clip) => (
                    <div
                      key={clip.id}
                      className={`overview-clip ${missing.has(clip.id) ? "missing" : ""}`}
                      style={{
                        left: (clip.startTick / barTicks) * barWidth,
                        width: Math.max(
                          8,
                          Math.min(
                            (clip.durationTicks / barTicks) * barWidth,
                            width - (clip.startTick / barTicks) * barWidth,
                          ),
                        ),
                      }}
                      title={clip.samplePath}
                    >
                      {missing.has(clip.id) && <TrackerIcon name="warning" />}
                      <span>
                        {missing.has(clip.id) ? "Missing: " : ""}
                        {clip.samplePath.split("/").at(-1)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))}
          {tracks.length === 0 && (
            <p className="tracker-empty">This project has no tracks.</p>
          )}
        </div>
      </div>
      <footer className="arrangement-note">
        {entry.project.clips.length === 0
          ? "No clips in this project."
          : `${entry.project.clips.length} clips in this project.`}{" "}
        <span>Arrangement edits and playback are unavailable.</span>
      </footer>
    </MaterialSurface>
  );
}

function gainLabel(gain: number) {
  return gain === 0 ? "−∞ dB" : `${(20 * Math.log10(gain)).toFixed(1)} dB`;
}
export function Mixer({ entry }: { entry: EntryResult }) {
  const tracks = [...entry.project.tracks].sort((a, b) => a.order - b.order);
  return (
    <MaterialSurface
      as="section"
      className="mixer-panel"
      aria-labelledby="mixer-heading"
    >
      <header className="tracker-panel-heading">
        <h2 id="mixer-heading">Mixer</h2>
        <span className="muted">Saved project values</span>
      </header>
      <div className="mixer-channels">
        {tracks.map((track, i) => (
          <div className="mixer-channel" key={track.id}>
            <h3>
              {String(i + 1).padStart(2, "0")} {track.name}
            </h3>
            <div className="channel-controls">
              <div>
                <span className="pan-readout">
                  {track.pan === 0
                    ? "C"
                    : `${Math.round(Math.abs(track.pan) * 100)}${track.pan < 0 ? "L" : "R"}`}
                </span>
                <span className="muted">Pan</span>
              </div>
              <div className="fader-readout" aria-hidden="true">
                <span
                  style={{ bottom: `${Math.min(100, track.gain * 65)}%` }}
                />
              </div>
              <div className="silent-meter" aria-hidden="true" />
            </div>
            <span>{gainLabel(track.gain)}</span>
            <div className="mix-state">
              {track.mute ? "Muted" : "Mute off"} ·{" "}
              {track.solo ? "Solo" : "Solo off"}
            </div>
          </div>
        ))}
        <div className="mixer-channel master-channel">
          <h3>Master</h3>
          <div className="channel-controls">
            <div className="fader-readout" aria-hidden="true">
              <span
                style={{
                  bottom: `${Math.min(100, entry.project.masterGain * 65)}%`,
                }}
              />
            </div>
            <div className="silent-meter" aria-hidden="true" />
            <div className="silent-meter" aria-hidden="true" />
          </div>
          <span>{gainLabel(entry.project.masterGain)}</span>
          <div className="mix-state">No playback</div>
        </div>
      </div>
    </MaterialSurface>
  );
}
