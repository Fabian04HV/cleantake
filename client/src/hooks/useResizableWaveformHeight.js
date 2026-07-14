import { useCallback, useEffect, useRef, useState } from "react";

// Versioned so a future change to the stored shape/semantics can't collide
// with an old value left over in a returning user's browser.
const STORAGE_KEY = "cleantake:waveform-panel-height:v1";

// Large enough that the compact toolbar row, a usable sliver of waveform,
// the timeline, and panel padding all stay legible - see the flex layout in
// index.css (`.waveform-editor`/`.waveform-editor__surface`) that this floor
// is protecting.
const MIN_PANEL_HEIGHT_PX = 260;

// Matches the panel's previous *intrinsic* (content-driven) height fairly
// closely, so switching to an explicit, resizable height doesn't visibly
// jump the layout for existing users.
const DEFAULT_PANEL_HEIGHT_PX = 320;

// "No more than approximately 70-75% of the viewport height."
const MAX_PANEL_HEIGHT_RATIO = 0.72;

function getMaxPanelHeight() {
  if (typeof window === "undefined") return DEFAULT_PANEL_HEIGHT_PX;
  return Math.max(MIN_PANEL_HEIGHT_PX, Math.floor(window.innerHeight * MAX_PANEL_HEIGHT_RATIO));
}

function clampPanelHeight(value, maxHeight) {
  if (!Number.isFinite(value)) return DEFAULT_PANEL_HEIGHT_PX;
  return Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT_PX, value));
}

function readStoredHeight() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // Storage may be unavailable (privacy mode, disabled, quota) - fall back
    // to the default rather than breaking the editor over a persistence nicety.
    return null;
  }
}

function writeStoredHeight(value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
  } catch {
    // Ignore write failures for the same reason as above.
  }
}

// Manages the single shared height (in px) for the fixed WaveformEditor
// dock. The *displayed* height is always the user's last deliberately
// chosen size (`preferredHeightRef`), clamped to whatever the viewport
// currently allows - so shrinking the window never forgets a larger
// preference, it just temporarily can't honor all of it (see the resize
// handler below).
function getInitialHeight() {
  return clampPanelHeight(readStoredHeight() ?? DEFAULT_PANEL_HEIGHT_PX, getMaxPanelHeight());
}

export function useResizableWaveformHeight() {
  // Deliberately two independent calls rather than seeding one from the
  // other's ref: reading a ref's `.current` during render (even inside a
  // lazy useState initializer) trips React's rules-of-hooks "refs" lint
  // rule, and this is cheap/idempotent enough to just compute twice.
  const preferredHeightRef = useRef(getInitialHeight());
  const [height, setHeight] = useState(() => getInitialHeight());
  const [isResizing, setIsResizing] = useState(false);

  const dragRef = useRef(null);
  const rafRef = useRef(null);
  const pendingHeightRef = useRef(null);

  // The fixed dock's height, the page's bottom spacer, and the available
  // waveform drawing area (via the flex layout in index.css) all read this
  // one variable - see the `.App` / `.waveform-section` rules there.
  useEffect(() => {
    document.documentElement.style.setProperty("--waveform-dock-height", `${height}px`);
  }, [height]);

  const scheduleHeightUpdate = useCallback((nextHeight) => {
    pendingHeightRef.current = nextHeight;
    if (rafRef.current != null) return;

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (pendingHeightRef.current != null) {
        setHeight(pendingHeightRef.current);
      }
    });
  }, []);

  const endDrag = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const finalHeight = clampPanelHeight(pendingHeightRef.current ?? drag.startHeight, getMaxPanelHeight());
    pendingHeightRef.current = null;
    preferredHeightRef.current = finalHeight;
    setHeight(finalHeight);
    writeStoredHeight(finalHeight);

    if (event.currentTarget?.releasePointerCapture) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Capture may already have been released; safe to ignore.
      }
    }

    document.body.classList.remove("waveform-resizing");
    setIsResizing(false);
  }, []);

  const handlePointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    // Upward pointer movement (smaller clientY) must increase height.
    const deltaY = drag.startClientY - event.clientY;
    const nextHeight = clampPanelHeight(drag.startHeight + deltaY, getMaxPanelHeight());
    scheduleHeightUpdate(nextHeight);
  }, [scheduleHeightUpdate]);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0) return;

    // This is a pure resize gesture: never let it fall through to a
    // waveform selection/seek or start a native text-selection/drag under
    // the handle.
    event.preventDefault();

    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startHeight: height,
    };

    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("waveform-resizing");
    setIsResizing(true);
  }, [height]);

  const handlePointerCancel = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingHeightRef.current = null;

    // A cancelled gesture (e.g. browser-initiated) discards the in-progress
    // drag and keeps whatever height was last actually committed.
    setHeight(clampPanelHeight(preferredHeightRef.current, getMaxPanelHeight()));

    document.body.classList.remove("waveform-resizing");
    setIsResizing(false);
  }, []);

  // Window shrinking must clamp the *displayed* height down immediately;
  // window growing again should restore as much of the user's original
  // preference as now fits, never silently reset to the default.
  useEffect(() => {
    let resizeRafId = null;

    const handleWindowResize = () => {
      if (resizeRafId != null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        setHeight(clampPanelHeight(preferredHeightRef.current, getMaxPanelHeight()));
      });
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      if (resizeRafId != null) cancelAnimationFrame(resizeRafId);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      document.body.classList.remove("waveform-resizing");
    };
  }, []);

  return {
    height,
    isResizing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp: endDrag,
    handlePointerCancel,
  };
}
