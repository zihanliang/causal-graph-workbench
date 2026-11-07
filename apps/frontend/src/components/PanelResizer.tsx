import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

const STORAGE_KEY = "causal-graph-workbench.panel-width";
const DEFAULT_WIDTH = 560;
const MIN_WIDTH = 380;
const MIN_CANVAS = 420;
const KEY_STEP = 24;

/** Where it was left last time. Only a convenience, so a browser that refuses storage just starts at the default. */
export function readPanelWidth(): number | null {
  try {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : null;
  } catch {
    return null;
  }
}

function savePanelWidth(width: number | null): void {
  try {
    if (width === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
    }
  } catch {
    // Nothing to do: the width still applies until the page is closed.
  }
}

interface PanelResizerProps {
  workspaceRef: RefObject<HTMLElement>;
  width: number | null;
  onChange: (width: number | null) => void;
}

/** The bar between the graph and the panel. Reading a result needs more room than drawing does. */
export function PanelResizer({ workspaceRef, width, onChange }: PanelResizerProps) {
  const barRef = useRef<HTMLDivElement>(null);
  /** Where the drag began, so that the panel moves by as much as the pointer does, with no jump at the start. */
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const clamp = (value: number) => Math.min(Math.max(MIN_WIDTH, (workspaceRef.current?.clientWidth ?? 0) - MIN_CANVAS), Math.max(MIN_WIDTH, value));
  const shownWidth = () => barRef.current?.nextElementSibling?.getBoundingClientRect().width ?? width ?? DEFAULT_WIDTH;

  useEffect(() => {
    if (width !== null) {
      savePanelWidth(width);
    }
  }, [width]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current) {
      onChange(clamp(dragStart.current.width + dragStart.current.x - event.clientX));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      onChange(clamp(shownWidth() + (event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP)));
    }
  };

  return (
    <div
      ref={barRef}
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Width of the panel. Use the left and right arrow keys."
      aria-valuemin={MIN_WIDTH}
      aria-valuenow={Math.round(width ?? DEFAULT_WIDTH)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        dragStart.current = { x: event.clientX, width: shownWidth() };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        dragStart.current = null;
      }}
      onPointerCancel={() => {
        dragStart.current = null;
      }}
      onDoubleClick={() => {
        savePanelWidth(null);
        onChange(null);
      }}
    />
  );
}
