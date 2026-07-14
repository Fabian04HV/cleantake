import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";

// WaveSurfer's canvas rendering can't read CSS custom properties, so these
// mirror the dark-green palette defined in index.css (`--color-*`). Keep
// them in sync if the palette there ever changes.
const WAVE_COLOR = "#5c6f66"; // included/unplayed audio: muted grey-green
const PROGRESS_COLOR = "#8ef0b0"; // played/included audio: light green accent
const CURSOR_COLOR = "#b7ffcf"; // playhead: brighter green

// Creates (and fully tears down) exactly one WaveSurfer instance for the
// given media element/url pair, using the official Regions and Timeline
// plugins. WaveSurfer only renders the waveform and cursor here - it is
// never treated as application state; see WaveformEditor for how excluded
// regions are synced *from* React state, one-way.
export function useWaveSurfer({ containerRef, timelineContainerRef, mediaRef, url }) {
  const wavesurferRef = useRef(null);
  const regionsRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const container = containerRef.current;
    const media = mediaRef.current;

    if (!container || !media || !url) {
      return undefined;
    }

    setIsReady(false);
    setError(null);

    const regions = RegionsPlugin.create();
    const plugins = [regions];

    if (timelineContainerRef?.current) {
      plugins.push(
        TimelinePlugin.create({
          container: timelineContainerRef.current,
          height: 28,
          insertPosition: "afterend",
        })
      );
    }

    const wavesurfer = WaveSurfer.create({
      container,
      media,
      plugins,
      waveColor: WAVE_COLOR,
      progressColor: PROGRESS_COLOR,
      cursorColor: CURSOR_COLOR,
      cursorWidth: 2,
      // "auto" fills whatever height the container element actually has
      // (see `.waveform-editor__surface` in index.css) and, per WaveSurfer's
      // own renderer, keeps re-rendering at the new height through its
      // built-in ResizeObserver whenever that container is resized - so the
      // vertical-resize handle in WaveformEditor never has to destroy/
      // recreate this instance or manually poke its canvases.
      height: "auto",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      // All pointer interaction (click-to-seek vs. drag-to-select, with a
      // pixel threshold and word-boundary snapping) is handled by
      // WaveformEditor itself, not WaveSurfer's built-in interaction model.
      interact: false,
      dragToSeek: false,
      autoScroll: true,
      autoCenter: false,
    });

    wavesurferRef.current = wavesurfer;
    regionsRef.current = regions;

    const handleReady = () => setIsReady(true);
    const handleDecodeError = (err) => {
      setError(err instanceof Error ? err : new Error("Failed to decode audio for the waveform"));
    };

    wavesurfer.on("ready", handleReady);
    wavesurfer.on("error", handleDecodeError);

    return () => {
      wavesurfer.un("ready", handleReady);
      wavesurfer.un("error", handleDecodeError);
      wavesurfer.destroy();

      if (wavesurferRef.current === wavesurfer) {
        wavesurferRef.current = null;
        regionsRef.current = null;
      }

      setIsReady(false);
    };
    // Re-create only when the container/media nodes or the file itself
    // change - never merely because excludedSegments changed.
  }, [containerRef, timelineContainerRef, mediaRef, url]);

  return { wavesurferRef, regionsRef, isReady, error };
}
