import { useCallback, useEffect, useRef, useState } from "react";
import TransportControls from "./TransportControls.jsx";
import { useWaveSurfer } from "./hooks/useWaveSurfer.js";
import { formatTime } from "./utils/timelineMapping.js";

// Below this pointer movement (in pixels) a press-and-release is treated as
// a plain seek click rather than a range selection. This threshold is
// intentionally measured in raw viewport pixels (clientX movement), never in
// source-time distance, because how many seconds one pixel represents
// changes with zoom.
const CLICK_VS_DRAG_THRESHOLD_PX = 4;
const MIN_SELECTION_DURATION_SECONDS = 0.03;

// Mouse-wheel zoom bounds/step. The *effective* lower bound also respects
// whatever "fit the whole file to the viewport" currently resolves to (see
// fitZoomRef below), so users can never wheel-zoom out past the full-file
// overview.
const MIN_ZOOM = 10;
const MAX_ZOOM = 500;
const ZOOM_FACTOR = 1.15;

// Set to true only while debugging waveform-selection accuracy; logs the
// exact pointer/scroll/zoom math behind every committed selection. Must stay
// false by default (see section 11/14 of the accuracy-fix task).
const ENABLE_WAVEFORM_SELECTION_DEBUG = false;

// Mirrors the dark-green palette in index.css (`--color-disabled-region` /
// `--color-selection-region`) - WaveSurfer's Regions plugin needs an actual
// color string, it can't read CSS custom properties.
const EXCLUDED_REGION_COLOR = "rgba(74, 104, 88, 0.56)";
const TEMP_SELECTION_REGION_COLOR = "rgba(142, 240, 176, 0.22)";

// ---------------------------------------------------------------------------
// WaveSurfer element resolution
//
// WaveSurfer 7 renders into a shadow root it creates itself, with this fixed
// structure: <div class="scroll"><div class="wrapper">canvases, cursor...
// The ".scroll" element is the *actual* horizontally-scrolling viewport
// (its scrollLeft changes when the user scrolls); ".wrapper" is the
// complete rendered waveform content - its width equals the full
// post-zoom pixel width of the audio. `getWrapper()` is the one official,
// version-supported accessor for this structure, so both elements are
// resolved from it rather than by guessing at a broader/less stable
// selector (which could otherwise land on the timeline, a region overlay,
// or our own outer bordered card instead).
// ---------------------------------------------------------------------------
function getWaveformContentElement(wavesurfer) {
  return wavesurfer?.getWrapper() ?? null;
}

function getWaveformScrollViewport(wavesurfer) {
  return wavesurfer?.getWrapper()?.parentElement ?? null;
}

// The single authoritative pointer -> source-time conversion, used for
// selection start/move/end, click-to-seek, and zoom centering alike so none
// of them can ever drift apart. It reads the *real* rendered DOM dimensions
// (never `zoomRef * duration`, which could disagree with what actually got
// rendered) and explicitly folds in the viewport's own scrollLeft, rather
// than relying on a border/padding-sensitive outer element.
function pointerEventToSourceTime(event, viewportElement, contentElement, duration) {
  if (!viewportElement || !contentElement || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  const rect = viewportElement.getBoundingClientRect();
  const xInsideViewport = event.clientX - rect.left;
  const xInsideContent = viewportElement.scrollLeft + xInsideViewport;
  const contentWidth = contentElement.scrollWidth || contentElement.clientWidth || 0;

  if (contentWidth <= 0) return 0;

  const progress = xInsideContent / contentWidth;
  return Math.min(duration, Math.max(0, progress * duration));
}

// The inverse of the above - given a source time, where does it currently
// render in viewport/client coordinates. Used to position the selection
// toolbar and to keep the pointer's source time fixed under the cursor while
// wheel-zooming.
function sourceTimeToClientX(time, viewportElement, contentElement, duration) {
  const rect = viewportElement.getBoundingClientRect();
  const contentWidth = contentElement.scrollWidth || contentElement.clientWidth || 0;

  if (!Number.isFinite(duration) || duration <= 0 || contentWidth <= 0) {
    return rect.left;
  }

  const progress = Math.min(1, Math.max(0, time / duration));
  const xInsideContent = progress * contentWidth;
  const xInsideViewport = xInsideContent - viewportElement.scrollLeft;
  return rect.left + xInsideViewport;
}

// Anchors the toolbar's position vertically to the drawing surface's own
// midline rather than its full top/bottom edges. SelectionToolbar always
// prefers to render *above* whatever rect it's given when there's room -
// anchoring to the surface's full top edge meant that preferred position
// always landed in the fixed waveform-header row directly above the
// surface, exactly where the centered Play/Pause button lives, silently
// swallowing clicks meant for it whenever a selection happened to sit
// underneath that button. Anchoring to the midline instead keeps the
// toolbar inside the drawing surface, never over the header.
function computeSelectionRect(viewportElement, contentElement, containerEl, start, end, duration) {
  const containerRect = containerEl.getBoundingClientRect();
  const left = sourceTimeToClientX(start, viewportElement, contentElement, duration);
  const right = sourceTimeToClientX(end, viewportElement, contentElement, duration);
  const verticalCenter = containerRect.top + containerRect.height / 2;

  return {
    top: verticalCenter,
    bottom: verticalCenter,
    left,
    width: Math.max(1, right - left),
    height: 0,
  };
}

// Renders the complete-recording waveform (via WaveSurfer + its official
// Regions/Timeline plugins) and lets the user drag across it to
// remove/restore an arbitrary time range. WaveSurfer only draws the
// waveform, timeline and playback cursor; every excluded region it shows is
// re-rendered from `excludedSegments` whenever that prop changes, and
// dragging never mutates a region directly or renders its own toolbar - it
// only reports the resulting selection up through `onSelectionChange`, and
// App (the sole owner of the shared SelectionToolbar) turns an explicit
// Exclude/Restore action on it into an onExcludeRange/onIncludeRange call.
//
// Waveform selections are sample/time accurate and intentionally
// independent of the transcript: unlike transcript text selection, they are
// never snapped to Deepgram word boundaries, so a drag can start or end in
// the middle of a word (or of silence) and the exact pointer-derived times
// are what gets excluded/restored.
function WaveformEditor({
  audioRef,
  url,
  excludedSegments,
  activeSelection,
  onSelectionChange,
  onSeek,
  isPlaying,
  currentEditedTime,
  editedDuration,
  currentSourceTime,
  sourceDuration,
  onTogglePlayback,
  seekToStart,
  seekBy,
  seekToEnd,
  disabled,
}) {
  const containerRef = useRef(null);
  const timelineContainerRef = useRef(null);
  const dragRef = useRef(null);
  const tempRegionRef = useRef(null);

  // Zoom is deliberately kept in refs, not state: wheel events can fire many
  // times per second and every tick already imperatively calls
  // `wavesurfer.zoom()`, so mirroring the exact value into React state on
  // every tick would just cause redundant re-renders. Only the *rounded,
  // throttled* percentage shown to the user lives in state (zoomPercent).
  const zoomRef = useRef(MIN_ZOOM);
  const fitZoomRef = useRef(MIN_ZOOM);
  const hasZoomedRef = useRef(false);
  const zoomLabelFrameRef = useRef(null);

  // Only the in-progress/just-finished drag preview region lives locally;
  // the *committed* toolbar selection is reported up via onSelectionChange
  // and owned by App (see the module doc comment above), so this editor can
  // never end up rendering its own Remove/Restore toolbar alongside the
  // transcript's.
  const [tempSelection, setTempSelection] = useState(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  const { wavesurferRef, regionsRef, isReady, error } = useWaveSurfer({
    containerRef,
    timelineContainerRef,
    mediaRef: audioRef,
    url,
  });

  // React state -> visual regions, one-way only. Regions are recreated
  // wholesale from `excludedSegments`; nothing here ever reads a region back
  // into state, which is what keeps this from becoming a feedback loop.
  // Regions always use the exact start/end from state - no padding, no
  // rounding - so the dark overlay lines up pixel-for-pixel with whatever
  // was committed.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!isReady || !regions) return;

    for (const region of regions.getRegions()) {
      if (region.id.startsWith("excluded-")) {
        region.remove();
      }
    }

    for (const segment of excludedSegments) {
      const region = regions.addRegion({
        id: segment.id,
        start: segment.start,
        end: segment.end,
        drag: false,
        resize: false,
        color: EXCLUDED_REGION_COLOR,
      });

      region.element?.classList.add("waveform-region--excluded");
    }
  }, [regionsRef, isReady, excludedSegments]);

  // The in-progress/finished drag selection is also rendered as a region so
  // it automatically stays aligned with the waveform under any zoom/scroll
  // state - exactly like the excluded regions above, just keyed off
  // `tempSelection` instead of `excludedSegments`.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!isReady || !regions) return;

    if (!tempSelection) {
      if (tempRegionRef.current) {
        tempRegionRef.current.remove();
        tempRegionRef.current = null;
      }
      return;
    }

    if (tempRegionRef.current) {
      tempRegionRef.current.setOptions({ start: tempSelection.start, end: tempSelection.end });
    } else {
      const region = regions.addRegion({
        id: "temp-selection",
        start: tempSelection.start,
        end: tempSelection.end,
        drag: false,
        resize: false,
        color: TEMP_SELECTION_REGION_COLOR,
      });
      region.element?.classList.add("waveform-region--temp");
      tempRegionRef.current = region;
    }
  }, [regionsRef, isReady, tempSelection]);

  // Establishes the initial "fit the whole file to the viewport" zoom level
  // once the file is decoded, and keeps that floor (fitZoomRef) up to date
  // whenever the container is resized. The *current* zoom (zoomRef) is only
  // snapped back to the new fit level automatically until the user performs
  // their first manual wheel-zoom - after that, resizing never silently
  // resets a deliberately chosen zoom.
  useEffect(() => {
    if (!isReady) return undefined;
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) return undefined;

    const updateFitZoom = () => {
      const duration = wavesurfer.getDuration();
      const viewportWidth = wavesurfer.getWidth();
      if (!Number.isFinite(duration) || duration <= 0 || viewportWidth <= 0) return;

      fitZoomRef.current = Math.max(MIN_ZOOM, viewportWidth / duration);

      if (!hasZoomedRef.current) {
        zoomRef.current = fitZoomRef.current;
        setZoomPercent(100);
      }
    };

    updateFitZoom();
    wavesurfer.on("resize", updateFitZoom);
    return () => wavesurfer.un("resize", updateFitZoom);
  }, [isReady, wavesurferRef]);

  // Coalesces bursts of wheel ticks (e.g. inertial trackpad scrolling) into
  // at most one zoom-percentage label update per animation frame.
  const scheduleZoomLabelUpdate = useCallback(() => {
    if (zoomLabelFrameRef.current != null) return;
    zoomLabelFrameRef.current = requestAnimationFrame(() => {
      zoomLabelFrameRef.current = null;
      const fit = fitZoomRef.current || MIN_ZOOM;
      setZoomPercent(Math.round((zoomRef.current / fit) * 100));
    });
  }, []);

  useEffect(() => {
    return () => {
      if (zoomLabelFrameRef.current != null) {
        cancelAnimationFrame(zoomLabelFrameRef.current);
      }
    };
  }, []);

  // Mouse-wheel zoom, centered on the pointer position. Reads the source
  // time currently under the pointer *before* zooming (via the same shared
  // pointerEventToSourceTime helper used for selection), applies the new
  // zoom via WaveSurfer's own `zoom(minPxPerSec)` API (no
  // destroy/recreate), then restores scroll so that same source time is
  // still under the pointer afterwards.
  const handleWheel = useCallback((event) => {
    const wavesurfer = wavesurferRef.current;
    if (!isReady || !wavesurfer) return;

    const duration = wavesurfer.getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;

    // Every wheel tick over the waveform is claimed for zooming - the page
    // (and the waveform's own native scroller) must never also react to it.
    event.preventDefault();

    if (event.deltaY === 0) return;

    const viewport = getWaveformScrollViewport(wavesurfer);
    const content = getWaveformContentElement(wavesurfer);
    if (!viewport || !content) return;

    const zoomingIn = event.deltaY < 0;
    const currentZoom = zoomRef.current || fitZoomRef.current || MIN_ZOOM;
    const rawNextZoom = zoomingIn ? currentZoom * ZOOM_FACTOR : currentZoom / ZOOM_FACTOR;
    const minZoom = Math.max(MIN_ZOOM, fitZoomRef.current || MIN_ZOOM);
    const nextZoom = Math.min(MAX_ZOOM, Math.max(minZoom, rawNextZoom));

    if (Math.abs(nextZoom - currentZoom) < 0.001) return;

    const timeAtPointer = pointerEventToSourceTime(event, viewport, content, duration);

    hasZoomedRef.current = true;
    zoomRef.current = nextZoom;
    wavesurfer.zoom(nextZoom);

    // After zooming, the same source time renders at a new client X -
    // shift scroll by exactly that difference so it lands back under the
    // pointer, regardless of any scroll adjustment WaveSurfer's own
    // re-render already made (e.g. to keep the playhead in view).
    const newClientX = sourceTimeToClientX(timeAtPointer, viewport, content, duration);
    const scrollDelta = newClientX - event.clientX;
    wavesurfer.setScroll(Math.max(0, viewport.scrollLeft + scrollDelta));

    scheduleZoomLabelUpdate();
  }, [isReady, wavesurferRef, scheduleZoomLabelUpdate]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const closeSelection = useCallback(() => {
    setTempSelection(null);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  // If the transcript editor reports a selection of its own while ours is
  // still showing, our drag preview region would otherwise be left behind
  // with no toolbar pointing at it - drop it as soon as another source
  // takes over. Adjusting state directly during render (React's documented
  // pattern for resetting state in response to a prop change) rather than
  // in an effect: the `tempSelection` guard makes this a one-shot correction
  // that can't cascade, since it's false again on the very next render.
  if (activeSelection && activeSelection.source !== "waveform" && tempSelection) {
    setTempSelection(null);
  }

  // Escape / outside click / unmount all close the toolbar, mirroring the
  // transcript editor's selection toolbar behavior.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeSelection();
    };

    const handleOutsidePointerDown = (event) => {
      const container = containerRef.current;
      const toolbar = document.querySelector(".selection-toolbar");
      const insideContainer = container ? container.contains(event.target) : false;
      const insideToolbar = toolbar ? toolbar.contains(event.target) : false;

      if (!insideContainer && !insideToolbar) {
        closeSelection();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleOutsidePointerDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleOutsidePointerDown);
    };
  }, [closeSelection]);

  // Registered on the capture phase so we always see the pointerdown first,
  // even if a (non-draggable) excluded region element sits under the
  // pointer and would otherwise stop the event from bubbling further.
  const handlePointerDownCapture = useCallback((event) => {
    if (event.button !== 0) return;

    const container = containerRef.current;
    const wavesurfer = wavesurferRef.current;
    if (!container || !wavesurfer || !isReady) return;

    const duration = wavesurfer.getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;

    const viewport = getWaveformScrollViewport(wavesurfer);
    const content = getWaveformContentElement(wavesurfer);
    if (!viewport || !content) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startTime: pointerEventToSourceTime(event, viewport, content, duration),
      moved: false,
    };

    // Starting any new interaction here immediately relinquishes whatever
    // selection/toolbar is currently active - including one reported by
    // the transcript editor - so at most one can ever be open.
    onSelectionChange?.(null);
    container.setPointerCapture?.(event.pointerId);
  }, [wavesurferRef, isReady, onSelectionChange]);

  const handlePointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) return;

    // The click-vs-drag threshold is always measured in raw viewport
    // pixels, never in source-time distance - one pixel represents a
    // different number of seconds at every zoom level.
    if (!drag.moved && Math.abs(event.clientX - drag.startClientX) >= CLICK_VS_DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }

    if (!drag.moved) return;

    const viewport = getWaveformScrollViewport(wavesurfer);
    const content = getWaveformContentElement(wavesurfer);
    if (!viewport || !content) return;

    const duration = wavesurfer.getDuration();
    const currentTime = pointerEventToSourceTime(event, viewport, content, duration);

    setTempSelection({
      start: Math.min(drag.startTime, currentTime),
      end: Math.max(drag.startTime, currentTime),
    });
  }, [wavesurferRef]);

  const finishDrag = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    const container = containerRef.current;
    if (container?.releasePointerCapture) {
      try {
        container.releasePointerCapture(event.pointerId);
      } catch {
        // Capture may already have been released; safe to ignore.
      }
    }

    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) {
      setTempSelection(null);
      return;
    }

    if (!drag.moved) {
      setTempSelection(null);
      onSeek(drag.startTime);
      return;
    }

    const viewport = getWaveformScrollViewport(wavesurfer);
    const content = getWaveformContentElement(wavesurfer);
    if (!viewport || !content) {
      setTempSelection(null);
      return;
    }

    const duration = wavesurfer.getDuration();
    const rawStart = drag.startTime;
    const rawEnd = pointerEventToSourceTime(event, viewport, content, duration);

    // Normalize direction only - never snap to word boundaries, waveform
    // pixels, or rounded seconds. These are the exact times that get
    // committed, and the temporary selection above was already rendered
    // from the same unsnapped values, so the highlighted preview and the
    // final excluded/restored range always agree.
    const start = Math.min(rawStart, rawEnd);
    const end = Math.max(rawStart, rawEnd);

    if (ENABLE_WAVEFORM_SELECTION_DEBUG) {
      const viewportRect = viewport.getBoundingClientRect();
      console.table({
        pointerDownClientX: drag.startClientX,
        pointerUpClientX: event.clientX,
        viewportLeft: viewportRect.left,
        scrollLeft: viewport.scrollLeft,
        viewportWidth: viewportRect.width,
        contentWidth: content.scrollWidth,
        duration,
        rawStartTime: rawStart,
        rawEndTime: rawEnd,
        committedStartTime: start,
        committedEndTime: end,
      });
    }

    if (end - start < MIN_SELECTION_DURATION_SECONDS) {
      setTempSelection(null);
      return;
    }

    setTempSelection({ start, end });
    // Classification (included/excluded/mixed) is computed once, centrally,
    // in App from the same excludedSegments every other consumer uses - not
    // duplicated here.
    onSelectionChange?.({
      start,
      end,
      rect: computeSelectionRect(viewport, content, container, start, end, duration),
    });
  }, [onSeek, onSelectionChange, wavesurferRef]);

  const handlePointerCancel = useCallback(() => {
    dragRef.current = null;
    setTempSelection(null);
  }, []);

  return (
    <div className="waveform-editor" aria-label="Audio waveform editor. Scroll to zoom.">
      {/* One compact row: edited/source time (left), the shared playback
          transport (visually centered), and the zoom percentage (right) -
          no permanent heading or help text taking up extra rows. */}
      <div className="waveform-toolbar">
        <div className="waveform-toolbar-time">
          <span className="transport-controls__time">
            {formatTime(currentEditedTime)} / {formatTime(editedDuration)}
          </span>
          <span className="transport-controls__source-time" title="Position in the original, unedited file">
            (source {formatTime(currentSourceTime)} / {formatTime(sourceDuration)})
          </span>
          {!isReady && !error && <span className="waveform-editor__status">Loading waveform…</span>}
          {error && (
            <span className="waveform-editor__status waveform-editor__status--error">
              Could not display the waveform, but editing still works from the transcript.
            </span>
          )}
        </div>
        <div className="waveform-transport">
          <TransportControls
            isPlaying={isPlaying}
            editedDuration={editedDuration}
            sourceDuration={sourceDuration}
            onTogglePlayback={onTogglePlayback}
            seekToStart={seekToStart}
            seekBy={seekBy}
            seekToEnd={seekToEnd}
            disabled={disabled}
          />
        </div>
        <div className="waveform-zoom" aria-hidden="true">
          {isReady && !error ? `Zoom: ${zoomPercent}%` : null}
        </div>
      </div>
      <div
        ref={containerRef}
        className="waveform-editor__surface"
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={handlePointerCancel}
      />
      <div ref={timelineContainerRef} className="waveform-editor__timeline" />
    </div>
  );
}

export default WaveformEditor;
