import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Icon({
  name,
}: {
  name: "plus" | "folder" | "arrow" | "close" | "check" | "refresh";
}) {
  const paths = {
    plus: "M12 5v14M5 12h14",
    folder: "M3 7h7l2 2h9v11H3zM3 7V4h6l3 3h8v2",
    arrow: "M4 12h16m-6-6 6 6-6 6",
    close: "m6 6 12 12M18 6 6 18",
    check: "m5 12 4 4L19 6",
    refresh:
      "M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 7M4 12l2 7a8 8 0 0 0 13-3",
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

let dismissActiveTooltip: (() => void) | undefined;

export function Button({
  tip,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tip?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const keyboardHelp = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const clearCloseTimer = useCallback(
    () => clearTimeout(closeTimer.current),
    [],
  );
  const hide = useCallback(() => {
    clearCloseTimer();
    keyboardHelp.current = false;
    setOpen(false);
    if (dismissActiveTooltip === hide) dismissActiveTooltip = undefined;
  }, [clearCloseTimer]);
  const show = () => {
    if (!tip) return;
    clearCloseTimer();
    if (dismissActiveTooltip !== hide) dismissActiveTooltip?.();
    dismissActiveTooltip = hide;
    setOpen(true);
  };
  const leave = () => {
    clearCloseTimer();
    if (!keyboardHelp.current) closeTimer.current = setTimeout(hide, 120);
  };

  useEffect(
    () => () => {
      clearCloseTimer();
      if (dismissActiveTooltip === hide) dismissActiveTooltip = undefined;
    },
    [clearCloseTimer, hide],
  );

  useLayoutEffect(() => {
    const node = tooltip.current;
    const anchor = button.current;
    if (!open || !node || !anchor) return;
    // The top layer keeps the tooltip outside modal and panel clipping.
    const nativePopover = typeof node.showPopover === "function";
    if (nativePopover) node.showPopover();
    const bounds = anchor.getBoundingClientRect();
    const view = window.visualViewport;
    const leftEdge = (view?.offsetLeft ?? 0) + 8;
    const topEdge = (view?.offsetTop ?? 0) + 8;
    const rightEdge = leftEdge + (view?.width ?? innerWidth) - 16;
    const bottomEdge = topEdge + (view?.height ?? innerHeight) - 16;
    const { width, height } = node.getBoundingClientRect();
    const x = Math.max(
      leftEdge,
      Math.min(bounds.left + (bounds.width - width) / 2, rightEdge - width),
    );
    const above = bounds.top - height - 8;
    const y =
      above >= topEdge
        ? above
        : Math.min(bounds.bottom + 8, bottomEdge - height);
    node.style.left = `${x}px`;
    node.style.top = `${Math.max(topEdge, y)}px`;

    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    view?.addEventListener("resize", hide);
    return () => {
      if (nativePopover && node.matches(":popover-open")) node.hidePopover();
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      view?.removeEventListener("resize", hide);
    };
  }, [open, hide, tip]);

  return (
    <span
      className="control-with-tip"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") show();
      }}
      onPointerLeave={leave}
    >
      <button
        type="button"
        {...props}
        ref={button}
        aria-describedby={
          [props["aria-describedby"], tip ? id : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onFocus={(event) => {
          props.onFocus?.(event);
          if (event.currentTarget.matches(":focus-visible")) {
            keyboardHelp.current = true;
            show();
          }
        }}
        onBlur={(event) => {
          props.onBlur?.(event);
          hide();
        }}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          hide();
        }}
      >
        {children}
      </button>
      {tip && (
        <span
          id={id}
          ref={tooltip}
          role="tooltip"
          popover="manual"
          hidden={!open}
          className="tooltip"
          onPointerEnter={clearCloseTimer}
          onPointerLeave={leave}
        >
          {tip}
        </span>
      )}
    </span>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const openingControl = document.activeElement;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (openingControl instanceof HTMLElement) openingControl.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((control) => control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <Button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
          tip="Close this window."
        >
          <Icon name="close" />
        </Button>
      </header>
      {children}
    </dialog>
  );
}
