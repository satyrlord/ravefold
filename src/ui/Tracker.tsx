import { useEffect, useState, useSyncExternalStore } from "react";
import maskLogoUrl from "../assets/ravefold-mask.svg?url";
import type { EntryResult } from "../domain/entry.ts";
import type { Appearance } from "../domain/settings.ts";
import type { LibraryController } from "../library/controller.ts";
import { SourcePreview, type PreviewState } from "../library/preview.ts";
import { MaterialRoot, type RendererState } from "../skins/MaterialRoot.tsx";
import { SKINS } from "../skins/registry.ts";
import { Button, Modal } from "./controls.tsx";
import { Arrangement, Mixer, Transport } from "./ProjectOverview.tsx";
import { SampleInspector } from "./SampleInspector.tsx";
import { SampleLibrary } from "./SampleLibrary.tsx";
import { TrackerIcon } from "./tracker-icons.tsx";
import "./tracker.css";

export function Tracker({
  entry,
  controller,
  appearance,
  settingsMessage,
  onAppearance,
  onBack,
}: {
  entry: EntryResult;
  controller: LibraryController;
  appearance: Appearance;
  settingsMessage: string;
  onAppearance: <K extends keyof Appearance>(
    field: K,
    value: Appearance[K],
  ) => void;
  onBack: () => void;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [previewState, setPreviewState] = useState<PreviewState>({
    status: "idle",
    path: null,
    message: "Source preview stopped.",
  });
  const [preview] = useState(
    () => new SourcePreview({ onChange: setPreviewState }),
  );
  const [inspector, setInspector] = useState(() => innerWidth > 1280);
  const [dialog, setDialog] = useState<"appearance" | "leave" | null>(null);
  const [renderer, setRenderer] = useState<RendererState>("static");
  const [view, setView] = useState<"library" | "arrangement" | "mixer">(
    "library",
  );
  useEffect(() => {
    void controller.start();
    return () => {
      preview.dispose();
    };
  }, [controller, preview]);
  useEffect(() => {
    const query = matchMedia("(max-width: 1280px)");
    const close = () => {
      if (query.matches) setInspector(false);
    };
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, []);
  useEffect(() => {
    controller.setPlaybackActive(
      previewState.status === "playing" || previewState.status === "loading",
    );
  }, [controller, previewState.status]);
  const select = (path: string) => {
    void controller.select(path);
    setInspector(true);
  };
  return (
    <MaterialRoot
      className="tracker-root"
      appearance={appearance}
      onRendererChange={setRenderer}
    >
      <main
        className={`tracker-shell ${inspector ? "inspector-open" : ""}`}
        aria-label="Tracker workspace"
        data-view={view}
      >
        <header className="tracker-header">
          <div className="tracker-brand">
            <img src={maskLogoUrl} alt="" />
            <span>RaveFold</span>
          </div>
          <div className="tracker-project">
            <h1>{entry.project.name}</h1>
            <span>
              {entry.mode === "new"
                ? "New project"
                : entry.mode === "recover"
                  ? "Recovery copy"
                  : "Opened project"}
            </span>
          </div>
          <nav aria-label="Project actions">
            <Button
              className="tracker-button"
              onClick={() =>
                Object.keys(state.drafts).length ? setDialog("leave") : onBack()
              }
            >
              Back to menu
            </Button>
            <Button
              className="tracker-button"
              aria-disabled="true"
              tip="Project save is unavailable. Sample tags have their own save control."
            >
              Save
            </Button>
            <Button
              className="tracker-button"
              aria-disabled="true"
              tip="Song export is unavailable in this version."
            >
              Export
            </Button>
          </nav>
          <Button
            className="tracker-button appearance-button"
            onClick={() => setDialog("appearance")}
          >
            <TrackerIcon name="settings" />
            Appearance
          </Button>
        </header>
        <Transport />
        <nav className="compact-views" aria-label="Workspace views">
          {(["library", "arrangement", "mixer"] as const).map((item) => (
            <Button
              key={item}
              className="tracker-button"
              aria-pressed={view === item}
              onClick={() => setView(item)}
            >
              {item === "library"
                ? "Samples"
                : item === "arrangement"
                  ? "Arrangement"
                  : "Mixer"}
            </Button>
          ))}
        </nav>
        <div className="tracker-workspace">
          <SampleLibrary
            state={state}
            controller={controller}
            preview={previewState}
            onPlay={(sample) => void preview.play(sample)}
            onStop={() => preview.stop()}
            onSelect={select}
          />
          <Arrangement entry={entry} />
          {inspector && (
            <SampleInspector
              state={state}
              controller={controller}
              preview={preview}
              onClose={() => setInspector(false)}
            />
          )}
        </div>
        <Mixer entry={entry} />
        <footer className="tracker-status">
          <span role={previewState.status === "error" ? "alert" : "status"}>
            {previewState.message}
          </span>
          <span>
            {state.loading
              ? `Reading folders · ${state.catalog.examined} files`
              : `${state.catalog.rows.length} source files`}
          </span>
          <Button
            className="text-button"
            onClick={() => setInspector((value) => !value)}
            aria-expanded={inspector}
          >
            {inspector ? "Hide inspector" : "Show inspector"}
          </Button>
          {renderer === "unavailable" && <span>Static appearance active.</span>}
        </footer>
        {state.message && (
          <p className="tracker-error tracker-notice" role="alert">
            {state.message}
          </p>
        )}
        {state.catalog.inaccessible.length > 0 && (
          <p className="tracker-error tracker-notice" role="status">
            {state.catalog.inaccessible.length} files or folders could not be
            read.
          </p>
        )}
      </main>
      {dialog === "appearance" && (
        <Modal title="Appearance" onClose={() => setDialog(null)}>
          <div className="tracker-appearance">
            <label>
              Skin
              <select
                aria-label="Skin"
                value={appearance.skin}
                onChange={(event) =>
                  onAppearance("skin", event.target.value as Appearance["skin"])
                }
              >
                {SKINS.map((skin) => (
                  <option value={skin.id} key={skin.id}>
                    {skin.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Color mode
              <select
                aria-label="Color mode"
                value={appearance.mode}
                onChange={(event) =>
                  onAppearance("mode", event.target.value as Appearance["mode"])
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label>
              Effects
              <select
                aria-label="Effects"
                value={appearance.effects}
                onChange={(event) =>
                  onAppearance(
                    "effects",
                    event.target.value as Appearance["effects"],
                  )
                }
              >
                <option value="full">Full</option>
                <option value="reduced">Reduced</option>
                <option value="static">Static</option>
              </select>
            </label>
            <p role="status">{settingsMessage}</p>
          </div>
        </Modal>
      )}
      {dialog === "leave" && (
        <Modal title="Unsaved tags" onClose={() => setDialog(null)}>
          <p>Some tags are not saved. Stay in the tracker to save them.</p>
          <div className="dialog-actions">
            <Button className="button" onClick={() => setDialog(null)}>
              Keep editing
            </Button>
            <Button className="button" onClick={onBack}>
              Discard tag changes
            </Button>
          </div>
        </Modal>
      )}
    </MaterialRoot>
  );
}
