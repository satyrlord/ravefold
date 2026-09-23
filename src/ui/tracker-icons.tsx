export function TrackerIcon({
  name,
}: {
  name:
    | "play"
    | "pause"
    | "stop"
    | "start"
    | "search"
    | "loop"
    | "undo"
    | "redo"
    | "settings"
    | "warning";
}) {
  const paths = {
    play: "m8 5 11 7-11 7z",
    pause: "M8 5v14M16 5v14",
    stop: "M6 6h12v12H6z",
    start: "M5 5v14M19 5 8 12l11 7z",
    search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    loop: "M4 8h14l-4-4M20 16H6l4 4M20 8v5M4 16v-5",
    undo: "M4 4v7h7M4 11a8 8 0 1 1 1 7",
    redo: "M20 4v7h-7M20 11a8 8 0 1 0-1 7",
    settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
    warning: "m12 3 10 18H2zM12 9v5m0 3v1",
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
