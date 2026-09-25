import { validateWav } from "../domain/wav.ts";
import type { SampleFile } from "../storage/folders.ts";

export type PreviewSample = Pick<SampleFile, "path" | "handle">;

// Initial per-file recommendations from the delivery plan.
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_SOURCE_SECONDS = 5 * 60;

export interface PreviewState {
  status: "idle" | "loading" | "playing" | "error";
  path: string | null;
  message: string;
}

export interface SourceWaveform {
  path: string;
  duration: number;
  peaks: number[];
}

export interface PreviewPlayback {
  stop(): void;
}

/** A part of the source to play, in seconds. */
export interface PreviewSpan {
  offset: number;
  duration: number;
}

export interface PreviewBuffer {
  duration: number;
  channels: readonly Float32Array<ArrayBufferLike>[];
  start(onEnded: () => void, span?: PreviewSpan): PreviewPlayback;
}

export interface PreviewAudio {
  readonly state: string;
  resume(): Promise<void>;
  decode(bytes: ArrayBuffer): Promise<PreviewBuffer>;
  close(): Promise<void>;
}

function browserAudio(): PreviewAudio {
  if (typeof globalThis.AudioContext !== "function") {
    throw new Error("Source preview is unavailable in this browser.");
  }
  const context = new AudioContext();
  return {
    get state() {
      return context.state;
    },
    resume: () => context.resume(),
    close: () => context.close(),
    async decode(bytes) {
      const buffer = await context.decodeAudioData(bytes);
      return {
        duration: buffer.duration,
        channels: Array.from({ length: buffer.numberOfChannels }, (_, index) =>
          buffer.getChannelData(index),
        ),
        start(onEnded, span) {
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.onended = () => {
            source.disconnect();
            onEnded();
          };
          source.connect(context.destination);
          try {
            if (span) source.start(0, span.offset, span.duration);
            else source.start();
          } catch (error) {
            source.disconnect();
            throw error;
          }
          return {
            stop() {
              source.onended = null;
              source.stop();
              source.disconnect();
            },
          };
        },
      };
    },
  };
}

/** Source audition owns no manifest, readiness state or persistent audio. */
export class SourcePreview {
  private state: PreviewState = {
    status: "idle",
    path: null,
    message: "Source preview stopped.",
  };
  private audio: PreviewAudio | undefined;
  private playback: PreviewPlayback | undefined;
  private playCommand = 0;
  private waveformCommand = 0;
  private playAbort: AbortController | undefined;
  private waveformAbort: AbortController | undefined;
  private disposed = false;
  private decodeQueue: Promise<void> = Promise.resolve();
  private readonly createAudio: () => PreviewAudio;
  private readonly onChange: ((state: PreviewState) => void) | undefined;

  constructor(
    options: {
      createAudio?: () => PreviewAudio;
      onChange?: (state: PreviewState) => void;
    } = {},
  ) {
    this.createAudio = options.createAudio ?? browserAudio;
    this.onChange = options.onChange;
  }

  getState(): PreviewState {
    return this.state;
  }

  private publish(state: PreviewState): void {
    this.state = state;
    if (!this.disposed) this.onChange?.(state);
  }

  private getAudio(): PreviewAudio {
    this.audio ??= this.createAudio();
    return this.audio;
  }

  private stopPlayback(): void {
    this.playback?.stop();
    this.playback = undefined;
  }

  /**
   * Call directly from the user's preview command to retain audio activation.
   * A span plays one section of the unchanged source.
   */
  async play(sample: PreviewSample, span?: PreviewSpan): Promise<void> {
    if (this.disposed) return;
    this.playAbort?.abort();
    const abort = new AbortController();
    this.playAbort = abort;
    const command = ++this.playCommand;
    const current = () => !this.disposed && command === this.playCommand;
    this.stopPlayback();
    this.publish({
      status: "loading",
      path: sample.path,
      message: "Source preview is loading.",
    });
    try {
      const audio = this.getAudio();
      if (audio.state !== "running") await audio.resume();
      if (!current()) return;
      if (audio.state !== "running") {
        throw new Error(
          "Audio access is suspended. Start source preview again.",
        );
      }
      const buffer = await this.decode(sample, current, abort.signal);
      if (!buffer || !current()) return;
      if (audio.state !== "running") {
        throw new Error(
          "Audio access is suspended. Start source preview again.",
        );
      }
      if (
        span &&
        (!(span.offset >= 0) ||
          !(span.duration > 0) ||
          span.offset + span.duration > buffer.duration + 1e-6)
      )
        throw new Error("The section is outside the source audio.");
      this.playback = buffer.start(() => {
        if (!current()) return;
        this.playback = undefined;
        this.publish({
          status: "idle",
          path: sample.path,
          message: span ? "Section preview ended." : "Source preview ended.",
        });
      }, span);
      this.publish({
        status: "playing",
        path: sample.path,
        message: span
          ? "Section preview is playing."
          : "Source preview is playing.",
      });
    } catch (error) {
      if (!current()) return;
      this.publish({
        status: "error",
        path: sample.path,
        message:
          error instanceof Error
            ? error.message
            : "Source preview could not start. Select the sample again.",
      });
    }
  }

  stop(): void {
    this.playCommand++;
    this.playAbort?.abort();
    this.stopPlayback();
    this.publish({
      status: "idle",
      path: null,
      message: "Source preview stopped.",
    });
  }

  /** Only one full source decode can operate at a time. No buffer is cached. */
  private decode(
    sample: PreviewSample,
    current: () => boolean,
    signal: AbortSignal,
  ): Promise<PreviewBuffer | null> {
    const result = this.decodeQueue.then(async () => {
      if (!current()) return null;
      const file = await sample.handle.getFile();
      if (!current()) return null;
      if (file.size > MAX_SOURCE_BYTES) {
        throw new Error(
          "Source preview and waveforms support files up to 100 MiB.",
        );
      }
      const validation = await validateWav(file, signal);
      if (!current()) return null;
      if (!validation.valid) throw new Error(validation.reason);
      if (validation.info.duration > MAX_SOURCE_SECONDS) {
        throw new Error(
          "Source preview and waveforms support up to five minutes.",
        );
      }
      const bytes = await file.arrayBuffer();
      if (!current()) return null;
      const buffer = await this.getAudio().decode(bytes);
      return current() ? buffer : null;
    });
    this.decodeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** A waveform command does not start, stop or resume audio playback. */
  async waveform(sample: PreviewSample): Promise<SourceWaveform | null> {
    if (this.disposed) return null;
    this.waveformAbort?.abort();
    const abort = new AbortController();
    this.waveformAbort = abort;
    const command = ++this.waveformCommand;
    const current = () => !this.disposed && command === this.waveformCommand;
    const buffer = await this.decode(sample, current, abort.signal).catch(
      (error: unknown) => {
        if (!current()) return null;
        throw error;
      },
    );
    if (!buffer || !current()) return null;
    const frames = buffer.channels[0]?.length ?? 0;
    const columns = Math.min(frames, 256);
    const peaks = Array<number>(columns).fill(0);
    for (let frame = 0; frame < frames; frame++) {
      if (frame > 0 && frame % 262144 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!current()) return null;
      }
      const column = Math.min(
        columns - 1,
        Math.floor((frame * columns) / frames),
      );
      for (const channel of buffer.channels) {
        peaks[column] = Math.max(peaks[column], Math.abs(channel[frame]));
      }
    }
    return { path: sample.path, duration: buffer.duration, peaks };
  }

  cancelWaveform(): void {
    this.waveformCommand++;
    this.waveformAbort?.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.cancelWaveform();
    void this.audio?.close().catch(() => undefined);
    this.audio = undefined;
  }
}
