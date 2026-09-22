import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Plasma,
  PlasmaCanvas,
  PlasmaProvider,
  usePlasmaRuntime,
} from "@cruxgarden/plasma-ui";
import type { Appearance } from "../domain/settings.ts";
import { getMaterialProps, getSkinSettings } from "./registry.ts";
import "./skins.css";

export type RendererState = "material" | "static" | "unavailable";
type Surface = { id: string; element: HTMLDivElement };
type RegisterSurface = (surface: Surface) => () => void;
const SurfaceContext = createContext<RegisterSurface | null>(null);

function subscribeToMode(callback: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function systemMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

interface MaterialRootProps {
  appearance: Appearance;
  children: ReactNode;
  className?: string;
  onRendererChange?: (state: RendererState) => void;
}

export function MaterialRoot({
  appearance,
  children,
  className = "",
  onRendererChange,
}: MaterialRootProps) {
  const system = useSyncExternalStore(
    subscribeToMode,
    systemMode,
    (): "dark" => "dark",
  );
  const mode = appearance.mode === "system" ? system : appearance.mode;
  const [surfaces, setSurfaces] = useState<readonly Surface[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const previousEffects = useRef(appearance.effects);
  const markUnavailable = useCallback(() => setUnavailable(true), []);
  const register = useCallback<RegisterSurface>((surface) => {
    setSurfaces((current) => [...current, surface]);
    return () =>
      setSurfaces((current) => current.filter((s) => s.id !== surface.id));
  }, []);
  const renderer: RendererState =
    appearance.effects === "static"
      ? "static"
      : unavailable
        ? "unavailable"
        : "material";
  const settings = getSkinSettings(appearance.skin);
  const style = {
    "--material-radius": `${settings.radius}px`,
    "--material-tint": settings.tint,
    "--material-rim": settings.rimHex,
    "--material-frost": `${Math.round(settings.frost * 22)}px`,
    "--material-depth": `${Math.round(16 + settings.elevation * 44)}px`,
  } as CSSProperties;

  useEffect(() => {
    if (
      previousEffects.current === "static" &&
      appearance.effects !== "static"
    ) {
      setUnavailable(false);
    }
    previousEffects.current = appearance.effects;
  }, [appearance.effects]);

  useEffect(() => {
    onRendererChange?.(renderer);
  }, [renderer, onRendererChange]);

  useEffect(() => {
    const element = root.current;
    element?.addEventListener("webglcontextlost", markUnavailable, true);
    return () =>
      element?.removeEventListener("webglcontextlost", markUnavailable, true);
  }, [markUnavailable]);

  return (
    <SurfaceContext.Provider value={register}>
      <div
        ref={root}
        className={`material-root ${className}`}
        style={style}
        data-skin={appearance.skin}
        data-mode={mode}
        data-effects={appearance.effects}
        data-renderer={renderer}
      >
        {children}
        {renderer === "material" && (
          <RendererBoundary onUnavailable={markUnavailable}>
            <RendererLayer
              appearance={appearance}
              mode={mode}
              surfaces={surfaces}
              onUnavailable={markUnavailable}
            />
          </RendererBoundary>
        )}
      </div>
    </SurfaceContext.Provider>
  );
}

type MaterialSurfaceProps = HTMLAttributes<HTMLDivElement> & {
  as?: "div" | "section" | "article" | "aside" | "header" | "footer";
};

export function MaterialSurface({
  as: Tag = "div",
  className = "",
  children,
  ...props
}: MaterialSurfaceProps) {
  const id = useId();
  const register = useContext(SurfaceContext);
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (element.current && register)
      return register({ id, element: element.current });
  }, [id, register]);
  return (
    <Tag {...props} className={`material-surface ${className}`}>
      <div ref={element} className="material-slot" aria-hidden="true" />
      {children}
    </Tag>
  );
}

function RendererLayer({
  appearance,
  mode,
  surfaces,
  onUnavailable,
}: {
  appearance: Appearance;
  mode: "light" | "dark";
  surfaces: readonly Surface[];
  onUnavailable: () => void;
}) {
  const props = useMemo(
    () => getMaterialProps(appearance, mode),
    [appearance, mode],
  );
  return (
    <PlasmaProvider {...props} canvas={false}>
      <PlasmaCanvas className="material-canvas" zIndex={-1} />
      <RendererStatus onUnavailable={onUnavailable} />
      {surfaces.map(({ id, element }) =>
        createPortal(
          <Plasma
            className="material-proxy"
            lean={false}
            fuse={false}
            formIn={false}
            formOut={false}
            aria-hidden="true"
          />,
          element,
          id,
        ),
      )}
    </PlasmaProvider>
  );
}

function RendererStatus({ onUnavailable }: { onUnavailable: () => void }) {
  const { supported } = usePlasmaRuntime();
  useEffect(() => {
    if (!supported) onUnavailable();
  }, [supported, onUnavailable]);
  return null;
}

class RendererBoundary extends Component<
  { onUnavailable: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onUnavailable();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
