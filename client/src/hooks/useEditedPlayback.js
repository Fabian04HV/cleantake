import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findExcludedSegmentAtTime, findNextPlayableTime, getEditedDuration, sourceTimeToEditedTime } from "../utils/timelineMapping.js";
import { findActiveWordIndex, resolveVisibleActiveWordIndex } from "../utils/transcriptTiming.js";

// Throttle the *displayed* time to roughly 12 updates/sec. The underlying
// media element and WaveSurfer's own cursor still track real playback at
// full frame rate; this only limits how often React re-renders because of it.
const TIME_LABEL_UPDATE_INTERVAL_MS = 80;

// The single shared playback controller: owns the one requestAnimationFrame
// loop, the one source of isPlaying/activeWordIndex truth, and every seek.
// TranscriptEditor, WaveformEditor and TransportControls all consume this
// same hook instead of keeping their own playback state.
export function useEditedPlayback({ audioRef, words, excludedSegments }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [currentSourceTime, setCurrentSourceTime] = useState(0);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);

  // Rapidly-changing/read-only-for-callbacks values live in refs so the
  // animation loop always sees the latest data without needing to be
  // recreated (and without triggering extra renders itself).
  const excludedSegmentsRef = useRef(excludedSegments);
  const wordsRef = useRef(words);
  const frameRef = useRef(null);
  const lastLabelUpdateRef = useRef(0);

  useEffect(() => {
    excludedSegmentsRef.current = excludedSegments;
  }, [excludedSegments]);

  useEffect(() => {
    wordsRef.current = words;
  }, [words]);

  // The core of the preview: if the media element's real currentTime has
  // drifted into an excluded segment (via normal playback or a seek),
  // resolve it forward to the next playable position and keep the active
  // word / time label in sync. Returns the resulting effective source time.
  const syncFromCurrentTime = useCallback(({ forceLabelUpdate = false } = {}) => {
    const audio = audioRef.current;
    if (!audio) return 0;

    const rawTime = audio.currentTime;
    const segments = excludedSegmentsRef.current;
    const segment = findExcludedSegmentAtTime(rawTime, segments);
    let effectiveTime = rawTime;

    if (segment) {
      const next = findNextPlayableTime(rawTime, segments, audio.duration);

      if (next === null) {
        audio.pause();
        effectiveTime = Number.isFinite(audio.duration) ? audio.duration : rawTime;
      } else {
        effectiveTime = next;
        if (Math.abs(audio.currentTime - next) > 0.0005) {
          try {
            audio.currentTime = next;
          } catch {
            // Not seekable yet - the next frame/event will retry.
          }
        }
      }
    }

    const rawActiveIndex = findActiveWordIndex(wordsRef.current, effectiveTime);
    const visibleActiveIndex = resolveVisibleActiveWordIndex(wordsRef.current, rawActiveIndex, segments);

    setActiveWordIndex((current) => (current === visibleActiveIndex ? current : visibleActiveIndex));

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (forceLabelUpdate || now - lastLabelUpdateRef.current >= TIME_LABEL_UPDATE_INTERVAL_MS) {
      lastLabelUpdateRef.current = now;
      setCurrentSourceTime(effectiveTime);
    }

    return effectiveTime;
  }, [audioRef]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const stopLoop = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const tick = () => {
      syncFromCurrentTime();
      frameRef.current = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      stopLoop();
      frameRef.current = requestAnimationFrame(tick);
    };

    const handlePlay = () => {
      setIsPlaying(true);
      startLoop();
    };

    const handlePause = () => {
      setIsPlaying(false);
      stopLoop();
      syncFromCurrentTime({ forceLabelUpdate: true });
    };

    const handleEnded = () => {
      setIsPlaying(false);
      stopLoop();
      syncFromCurrentTime({ forceLabelUpdate: true });
    };

    const handleLoadedMetadata = () => {
      setSourceDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      syncFromCurrentTime({ forceLabelUpdate: true });
    };

    const handleSeeked = () => {
      syncFromCurrentTime({ forceLabelUpdate: true });
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("seeked", handleSeeked);

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setSourceDuration(audio.duration);
    }

    if (!audio.paused) {
      setIsPlaying(true);
      startLoop();
    }

    return () => {
      stopLoop();
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("seeked", handleSeeked);
    };
  }, [audioRef, syncFromCurrentTime]);

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Pressing play while inside an excluded range (or exactly at the end of
    // playable audio) must not start playback into/through it.
    const resolvedTime = syncFromCurrentTime({ forceLabelUpdate: true });
    if (Number.isFinite(audio.duration) && resolvedTime >= audio.duration - 0.001) {
      return;
    }

    audio.play().catch(() => {
      // Ignore autoplay/interaction rejections; the media element's own
      // `pause` state (unchanged) already reflects reality.
    });
  }, [audioRef, syncFromCurrentTime]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, [audioRef]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      play();
    } else {
      pause();
    }
  }, [audioRef, play, pause]);

  // Used by waveform/transcript seeking: always resolves into playable audio
  // and immediately refreshes the cursor/active word, whether or not
  // playback is currently active.
  const seekToSourceTime = useCallback((time) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(time)) return;

    const duration = Number.isFinite(audio.duration) ? audio.duration : time;
    const clamped = Math.max(0, Math.min(time, duration));

    try {
      audio.currentTime = clamped;
    } catch {
      // Ignore; resolved once the media becomes seekable.
    }

    syncFromCurrentTime({ forceLabelUpdate: true });
  }, [audioRef, syncFromCurrentTime]);

  // The four playback-cursor buttons (start/-5s/+5s/end) all funnel through
  // this same `seekToSourceTime`, so they get its clamping, excluded-segment
  // resolution, WaveSurfer sync, active-word update and time-label update
  // for free - none of them ever assigns `audio.currentTime` directly.
  const seekBy = useCallback((deltaSeconds) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(deltaSeconds)) return;

    // Read the media element's own live currentTime rather than the
    // throttled `currentSourceTime` state, so repeated clicks always add up
    // from the real current position instead of a slightly stale one.
    const base = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    seekToSourceTime(base + deltaSeconds);
  }, [audioRef, seekToSourceTime]);

  const seekToStart = useCallback(() => {
    seekToSourceTime(0);
  }, [seekToSourceTime]);

  const seekToEnd = useCallback(() => {
    const audio = audioRef.current;
    const duration = audio && Number.isFinite(audio.duration) ? audio.duration : sourceDuration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    // A tiny offset before the exact duration avoids landing exactly on it,
    // which would otherwise fire a native `ended` event the instant the
    // seek completes; `seekToSourceTime` still resolves this into whatever
    // the last *playable* position actually is.
    seekToSourceTime(Math.max(0, duration - 0.05));
  }, [audioRef, sourceDuration, seekToSourceTime]);

  // Called when a brand new file is loaded - see App's upload handler.
  const reset = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // ignore
      }
    }

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    lastLabelUpdateRef.current = 0;
    setIsPlaying(false);
    setCurrentSourceTime(0);
    setActiveWordIndex(-1);
    setSourceDuration(0);
  }, [audioRef]);

  const currentEditedTime = useMemo(
    () => sourceTimeToEditedTime(currentSourceTime, excludedSegments),
    [currentSourceTime, excludedSegments]
  );

  const editedDuration = useMemo(
    () => getEditedDuration(sourceDuration, excludedSegments),
    [sourceDuration, excludedSegments]
  );

  return {
    isPlaying,
    currentSourceTime,
    currentEditedTime,
    sourceDuration,
    editedDuration,
    activeWordIndex,
    play,
    pause,
    togglePlayback,
    seekToSourceTime,
    seekBy,
    seekToStart,
    seekToEnd,
    reset,
  };
}
