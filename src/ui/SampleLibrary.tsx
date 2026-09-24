import { useEffect, useMemo, useState } from "react";
import { filterCatalog, type CatalogRow } from "../library/catalog.ts";
import type { LibraryController, LibraryState } from "../library/controller.ts";
import type { PreviewState } from "../library/preview.ts";
import { MaterialSurface } from "../skins/MaterialRoot.tsx";
import { Button, Icon } from "./controls.tsx";
import { ACTIVE_PHASES } from "../domain/preparation.ts";
import { PHASE_LABELS } from "./PreparationPanel.tsx";
import { TrackerIcon } from "./tracker-icons.tsx";

export function SampleLibrary({
  state,
  controller,
  preview,
  onPlay,
  onStop,
  onSelect,
}: {
  state: LibraryState;
  controller: LibraryController;
  preview: PreviewState;
  onPlay: (sample: CatalogRow) => void;
  onStop: () => void;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(0);
  const rows = useMemo(
    () =>
      filterCatalog(state.catalog.rows, { query, folder, tag }, state.manifest),
    [state.catalog.rows, state.manifest, query, folder, tag],
  );
  const tags = useMemo(
    () =>
      [
        ...new Set(
          Object.values(state.manifest?.samples ?? {}).flatMap(
            (sample) => sample.tags,
          ),
        ),
      ].sort(),
    [state.manifest],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / 100));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => setPage(0), [query, folder, tag]);
  const clear = () => {
    setQuery("");
    setFolder("");
    setTag("");
  };
  return (
    <MaterialSurface
      as="section"
      className="library-panel"
      aria-label="Sample library"
    >
      <header className="tracker-panel-heading">
        <h2>Samples</h2>
        <span className="muted">{state.catalog.rows.length}</span>
      </header>
      <div className="library-filters">
        <label className="library-search">
          <TrackerIcon name="search" />
          <input
            aria-label="Search files or tags"
            placeholder="Search files or tags"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            type="search"
          />
        </label>
        <div className="folder-heading">Folders</div>
        <nav className="library-folders" aria-label="Sample folders">
          {state.catalog.folders.map((path) => (
            <button
              key={path}
              className={folder === path ? "selected" : ""}
              aria-label={path ? `Folder: ${path}` : "All samples"}
              aria-pressed={folder === path}
              onClick={() => setFolder(path)}
            >
              <Icon name="folder" />
              <span>{path || "All samples"}</span>
            </button>
          ))}
        </nav>
        <label className="tag-filter-label">
          Tags
          <select
            aria-label="Tag filter"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="">All tags</option>
            {tags.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <div className="library-result-count" role="status">
          {rows.length} files{state.loading ? " · Reading folders" : ""}
          {(query || folder || tag) && (
            <Button className="text-button" onClick={clear}>
              Reset filters
            </Button>
          )}
        </div>
      </div>
      <div className="sample-rows-scroll">
        <table className="sample-table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">File / tags</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice(currentPage * 100, (currentPage + 1) * 100)
              .map((sample) => {
                const preparation = controller.preparationFor(sample.path);
                const stopped =
                  state.preparation.recoveryRequired &&
                  preparation &&
                  (preparation.phase === "queued" ||
                    ACTIVE_PHASES.includes(preparation.phase));
                return (
                  <tr
                    key={sample.path}
                    data-state={
                      state.selected === sample.path ? "selected" : undefined
                    }
                  >
                    <td>
                      <Button
                        className="row-preview"
                        aria-label={`Preview source: ${sample.path}`}
                        tip="Play this source. Stop the previous preview."
                        onClick={() => onPlay(sample)}
                      >
                        <TrackerIcon name="play" />
                      </Button>
                    </td>
                    <td>
                      <button
                        className="sample-select"
                        aria-label={sample.path}
                        aria-pressed={state.selected === sample.path}
                        onClick={() => onSelect(sample.path)}
                      >
                        <span className="sample-name">{sample.name}</span>
                        <span className="sample-path">
                          {sample.folder || "Samples"} · {sample.format}
                        </span>
                        <span className="sample-tags">
                          {controller.tags(sample.path).join(" · ")}
                          {state.drafts[sample.path] ? " · Unsaved" : ""}
                        </span>
                      </button>
                    </td>
                    <td>
                      {preparation ? (
                        <span
                          className="preparation-state"
                          data-status={stopped ? "failed" : preparation.phase}
                        >
                          {stopped
                            ? "Preparation stopped"
                            : preparation.phase === "ready"
                              ? "Prepared"
                              : `Preparation: ${PHASE_LABELS[preparation.phase].toLowerCase()}`}
                        </span>
                      ) : (
                        <span
                          className="preparation-state"
                          data-status={
                            state.analysis?.path === sample.path
                              ? state.analysis.status
                              : undefined
                          }
                        >
                          {state.analysis?.path !== sample.path
                            ? "Not checked"
                            : state.analysis.status === "ready"
                              ? "Ready"
                              : state.analysis.status === "needs-conversion"
                                ? "Needs conversion"
                                : state.analysis.status === "needs-review"
                                  ? "Needs review"
                                  : state.analysis.status === "unusable"
                                    ? "Unusable"
                                    : state.analysis.status === "error"
                                      ? "Analysis unavailable"
                                      : "Analyzing"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="tracker-empty">
            {state.loading
              ? "Reading sample folders."
              : "No files match these filters."}
          </p>
        )}
      </div>
      {pageCount > 1 && (
        <nav className="library-pages" aria-label="Sample pages">
          <Button
            className="tracker-button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            className="tracker-button"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </nav>
      )}
      <div className="source-preview-status">
        <span>Source preview</span>
        <Button
          className="tracker-button icon-button"
          aria-label="Stop preview"
          tip="Stop source preview."
          disabled={
            preview.status !== "playing" && preview.status !== "loading"
          }
          onClick={onStop}
        >
          <TrackerIcon name="stop" />
        </Button>
        <span className="preview-file">
          {preview.path?.split("/").at(-1) ?? "Stopped"}
        </span>
      </div>
    </MaterialSurface>
  );
}
