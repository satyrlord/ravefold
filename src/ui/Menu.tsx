import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import maskLogoUrl from "../assets/ravefold-mask.svg?url";
import type { EntryResult } from "../domain/entry.ts";
import type { Appearance, Effects, ThemeMode } from "../domain/settings.ts";
import type { FolderKind } from "../storage/handles.ts";
import { MaterialRoot, MaterialSurface } from "../skins/MaterialRoot.tsx";
import type { RendererState } from "../skins/MaterialRoot.tsx";
import { SKINS } from "../skins/registry.ts";
import { MenuController } from "./menu-controller.ts";
import type { FolderState } from "./menu-controller.ts";
import { Button, Icon, Modal } from "./controls.tsx";
import "./menu.css";

export function Menu({ onEntry }: { onEntry: (entry: EntryResult) => void }) {
  const [controller] = useState(
    () =>
      new MenuController(
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        onEntry,
      ),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [modal, setModal] = useState<"folders" | "recovery" | null>(null);
  const [recovery, setRecovery] = useState<number>(0);
  const [renderer, setRenderer] = useState<RendererState>("static");
  const projectInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void controller.start();
    const refresh = () => {
      if (!document.hidden) void controller.refreshPermissions();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("ravefold:native-revoked", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("ravefold:native-revoked", refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
      controller.dispose();
    };
  }, [controller]);
  const allReady =
    state.samples.status === "ready" && state.settings.status === "ready";
  const folderSummary = (folder: FolderState) =>
    folder.handle?.name ?? "Not selected";
  const setAppearance = <K extends keyof Appearance>(
    field: K,
    value: Appearance[K],
  ) => controller.setAppearance(field, value);
  const closeModal = () => setModal(null);

  return (
    <MaterialRoot appearance={state.appearance} onRendererChange={setRenderer}>
      <div className="app-shell">
        <header className="masthead">
          <div className="wordmark">
            <img className="brand-symbol" src={maskLogoUrl} alt="" />
            <span>RaveFold</span>
          </div>
          <div className="music-settings" aria-label="Project timing">
            <b>
              180 <span>BPM</span>
            </b>
            <b>
              C <span>minor</span>
            </b>
          </div>
        </header>
        <main className="menu-layout">
          <div className="session-column">
            <MaterialSurface
              as="section"
              className="session-panel"
              aria-labelledby="session-heading"
            >
              <h1 id="session-heading">Make your next track.</h1>
              <div className="project-actions">
                <Button
                  className="project-action primary"
                  onClick={() => controller.newProject()}
                  disabled={state.entering}
                  tip="Prepare an empty project at 180 BPM in C minor."
                >
                  <Icon name="plus" />
                  <span className="project-action-label">
                    New project
                    <Icon name="arrow" />
                  </span>
                </Button>
                <Button
                  className="project-action"
                  onClick={() => projectInput.current?.click()}
                  disabled={state.entering}
                  tip="Open a RaveFold project file."
                >
                  <Icon name="folder" />
                  <span className="project-action-label">
                    Open project
                    <Icon name="arrow" />
                  </span>
                </Button>
                <input
                  ref={projectInput}
                  type="file"
                  accept=".json,.ravefold.json,application/json"
                  aria-label="Project file"
                  hidden
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void controller.openProject(file);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              {state.recoveries.length > 0 && (
                <div className="recovery-action">
                  <Button
                    className="text-button"
                    onClick={() => {
                      setRecovery(0);
                      setModal("recovery");
                    }}
                    tip="Select saved recovery work without changing its files."
                  >
                    Recovery copies ({state.recoveries.length})
                  </Button>
                </div>
              )}
              {state.pending && (
                <div className="pending" aria-label="Selected project">
                  <div className="pending-heading">
                    <p className="pending-name">{state.pending.project.name}</p>
                    <Button
                      className="icon-button"
                      aria-label="Cancel project selection"
                      onClick={() => controller.cancelProject()}
                      disabled={state.entering}
                      tip="Keep the menu open without a selected project."
                    >
                      <Icon name="close" />
                    </Button>
                  </div>
                  <p className="small">
                    {state.pending.mode === "new"
                      ? "New project"
                      : state.pending.mode === "recover"
                        ? "Recovery copy"
                        : "Saved project"}{" "}
                    · {state.pending.project.tracks.length} tracks
                  </p>
                  <div className="entry-row">
                    <Button
                      className="button primary"
                      onClick={() => void controller.enter()}
                      disabled={
                        !allReady ||
                        state.entering ||
                        state.projectBusy ||
                        Boolean(state.entry)
                      }
                      tip="Check folder access and open the selected project."
                    >
                      {state.entering ? "Checking access…" : "Enter tracker"}
                      <Icon name="arrow" />
                    </Button>
                    <p className="small">
                      {allReady
                        ? "Both folders are ready."
                        : "Select both folders to continue."}
                    </p>
                  </div>
                </div>
              )}
              {!state.supported && (
                <p className="message" role="status">
                  Folder access is unavailable. Use a supported Chromium desktop
                  browser to enter the tracker.
                </p>
              )}
              <p className="message" role="status" aria-live="polite">
                {state.message}
              </p>
              {state.projectBusy && (
                <Button
                  className="text-button"
                  onClick={() => controller.cancelProjectCheck()}
                >
                  Cancel project check
                </Button>
              )}
              {state.entering && (
                <Button
                  className="text-button"
                  onClick={() => controller.cancelEntry()}
                >
                  Cancel entry check
                </Button>
              )}
              {state.recoveryMessage && (
                <p className="message">{state.recoveryMessage}</p>
              )}
            </MaterialSurface>
            {state.entry && (
              <MaterialSurface
                as="section"
                className="handoff"
                aria-labelledby="entry-heading"
              >
                <h2 id="entry-heading">Project ready</h2>
                <p className="small">
                  {state.entry.project.name} is ready for the tracker. Tracker
                  editing is not available in this build.
                </p>
                {state.entry.missingSamples.length > 0 && (
                  <p className="small">
                    {state.entry.missingSamples.length} missing sample
                    references were kept.
                  </p>
                )}
                <Button
                  className="button"
                  onClick={() => controller.returnToMenu()}
                >
                  Return to menu
                </Button>
              </MaterialSurface>
            )}
            <MaterialSurface
              as="section"
              className="folder-panel"
              aria-labelledby="folders-heading"
            >
              <div className="panel-heading">
                <h2 id="folders-heading">Your folders</h2>
                <Button
                  className="text-button"
                  onClick={() => setModal("folders")}
                  tip="Select sample and settings folders, or restore access."
                >
                  Folder settings
                </Button>
              </div>
              {(["samples", "settings"] as const).map((kind) => (
                <div className="folder-line" key={kind}>
                  <span
                    className={`state-dot ${state[kind].status}`}
                    aria-hidden="true"
                  />
                  <div>
                    <p className="folder-name">
                      {kind === "samples" ? "Samples" : "Settings"}{" "}
                      <span className="small">
                        / {folderSummary(state[kind])}
                      </span>
                    </p>
                    <p className="small">{state[kind].message}</p>
                  </div>
                  {state[kind].status === "ready" && <Icon name="check" />}
                </div>
              ))}
              {state.persistenceMessage && (
                <p className="message">{state.persistenceMessage}</p>
              )}
            </MaterialSurface>
          </div>
          <MaterialSurface
            as="aside"
            className="appearance-panel"
            aria-labelledby="appearance-heading"
          >
            <h2 id="appearance-heading">Appearance</h2>
            <div className="skin-grid" role="radiogroup" aria-label="Skin">
              {SKINS.map((skin, index) => (
                <button
                  key={skin.id}
                  type="button"
                  className="skin-option"
                  role="radio"
                  aria-label={skin.label}
                  aria-checked={state.appearance.skin === skin.id}
                  tabIndex={state.appearance.skin === skin.id ? 0 : -1}
                  onClick={() => setAppearance("skin", skin.id)}
                  onKeyDown={(event) => {
                    const offset =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? -1
                          : 0;
                    if (offset) {
                      event.preventDefault();
                      const next =
                        (index + offset + SKINS.length) % SKINS.length;
                      setAppearance("skin", SKINS[next]!.id);
                      const elements =
                        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                          '[role="radio"]',
                        );
                      elements?.[next]?.focus();
                    }
                  }}
                >
                  <span
                    className="skin-preview"
                    style={{ background: skin.swatch }}
                  />
                  <span className="skin-option-label">
                    {skin.label}
                    {state.appearance.skin === skin.id && <Icon name="check" />}
                  </span>
                </button>
              ))}
            </div>
            <div className="select-row">
              <label className="select-field">
                Color mode
                <select
                  aria-label="Color mode"
                  value={state.appearance.mode}
                  onChange={(event) =>
                    setAppearance("mode", event.target.value as ThemeMode)
                  }
                >
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label className="select-field">
                Effects
                <select
                  aria-label="Effects"
                  value={state.appearance.effects}
                  onChange={(event) =>
                    setAppearance("effects", event.target.value as Effects)
                  }
                >
                  <option value="full">Full</option>
                  <option value="reduced">Reduced</option>
                  <option value="static">Static</option>
                </select>
              </label>
            </div>
            <p className="small appearance-status" role="status">
              {state.settingsMessage}
            </p>
            {renderer === "unavailable" && (
              <p className="small">
                Material effects are unavailable. Static appearance is active.
              </p>
            )}
          </MaterialSurface>
        </main>
        <footer className="site-footer">
          <span className="footer-state">
            <span
              className={`state-dot ${allReady ? "ready" : ""}`}
              aria-hidden="true"
            />
            {allReady ? "Folders ready" : "Folder access needed"}
          </span>
          <span>Desktop · Chromium browsers</span>
        </footer>
      </div>
      {modal === "folders" && (
        <Modal title="Folder settings" onClose={closeModal}>
          <FolderSetup
            kind="samples"
            label="Sample folder"
            detail="WAV · PCM 16/24-bit or float 32-bit · mono or stereo"
            folder={state.samples}
            controller={controller}
            supported={state.supported}
          />
          <FolderSetup
            kind="settings"
            label="Settings folder"
            detail="Select a separate RaveFold folder inside Documents."
            folder={state.settings}
            controller={controller}
            supported={state.supported}
          />
          <p className="message" role="status">
            {state.message}
          </p>
          <div className="modal-actions">
            <Button className="button primary" onClick={closeModal}>
              Done
            </Button>
          </div>
        </Modal>
      )}
      {modal === "recovery" && (
        <Modal title="Recovery copies" onClose={closeModal}>
          <div className="recovery-list">
            {state.recoveries.map((item, index) => (
              <label className="recovery-choice" key={item.name}>
                <input
                  type="radio"
                  name="recovery"
                  value={index}
                  checked={index === recovery}
                  onChange={() => setRecovery(index)}
                />
                <span>
                  {item.project.name}
                  <br />
                  <span className="small">{item.name}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <Button className="button" onClick={closeModal}>
              Cancel
            </Button>
            <Button
              className="button primary"
              disabled={!state.recoveries[recovery]}
              onClick={() => {
                controller.selectRecovery(recovery);
                closeModal();
              }}
            >
              Use recovery
            </Button>
          </div>
        </Modal>
      )}
    </MaterialRoot>
  );
}

function FolderSetup({
  kind,
  label,
  detail,
  folder,
  controller,
  supported,
}: {
  kind: FolderKind;
  label: string;
  detail: string;
  folder: FolderState;
  controller: MenuController;
  supported: boolean;
}) {
  return (
    <section className="folder-section" aria-label={label}>
      <h3>{label}</h3>
      <p className="small">{detail}</p>
      <div className="folder-selection">
        <strong>{folder.handle?.name ?? "No folder selected"}</strong>
        <p className="small" role="status">
          {folder.message}
        </p>
        {folder.discovery?.inaccessible.length ? (
          <p className="small">
            Incomplete results: {folder.discovery.inaccessible.length} items
            could not be read.
          </p>
        ) : null}
      </div>
      <div className="folder-buttons">
        <Button
          className="button"
          onClick={() => void controller.selectFolder(kind)}
          disabled={!supported}
          tip={
            kind === "samples"
              ? "Select your WAV folder. Existing audio stays unchanged."
              : "Store settings in a dedicated folder inside Documents."
          }
        >
          Select {kind === "samples" ? "sample" : "settings"} folder
        </Button>
        {folder.handle && (
          <Button
            className="button"
            onClick={() => void controller.retry(kind)}
            disabled={folder.scanning}
            tip="Check the current folder and request access if required."
          >
            Retry {kind === "samples" ? "samples" : "settings"}
          </Button>
        )}
        {folder.scanning && (
          <Button
            className="text-button"
            onClick={() => controller.cancelDiscovery(kind)}
          >
            Stop check
          </Button>
        )}
      </div>
    </section>
  );
}
