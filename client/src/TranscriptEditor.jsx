import { useCallback, useEffect, useMemo, useRef } from 'react';
import { getWordExclusionState } from './utils/transcriptTiming.js';

const SELECTION_CHANGE_DEBOUNCE_MS = 120;
const MANUAL_SCROLL_COOLDOWN_MS = 4000;
const AUTO_SCROLL_MARGIN_PX = 96;

// Below this pointer movement (in pixels) a press-and-release is treated as
// a plain seek click rather than the start of a text selection drag - the
// same threshold/approach WaveformEditor uses for its own click-vs-drag
// distinction.
const CLICK_VS_DRAG_THRESHOLD_PX = 4;

function getUsableRect(range) {
  const rect = range.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return rect;
  }

  const clientRects = range.getClientRects();
  return clientRects[clientRects.length - 1] || rect;
}

// Renders the transcript word-by-word and lets the user select an arbitrary
// run of words with the mouse (or keyboard) to exclude/restore it via the
// shared SelectionToolbar (rendered once, in App). Every selection is
// converted to a *time* range (via the first/last word's timestamps) and
// reported up through `onSelectionChange` - this editor never keeps its own
// "active selection" state or renders a toolbar itself, so it can never end
// up showing Remove/Restore actions at the same time as a waveform
// selection's toolbar.
function TranscriptEditor({ words, excludedSegments, activeWordIndex, isPlaying, activeSelection, onSelectionChange, onSeek }) {
  const transcriptRef = useRef(null);
  const debounceRef = useRef(null);
  const programmaticScrollRef = useRef(false);
  const lastManualScrollAtRef = useRef(0);
  // Tracks a possible plain click from mousedown to mouseup, entirely
  // separate from the browser's own text-selection state - see
  // handleMouseDown/handleMouseMove/handleMouseUp below.
  const clickCandidateRef = useRef(null);

  // Computed once per excludedSegments/words change, not per animation
  // frame: the animation loop only ever recomputes the cheap activeWordIndex
  // binary search, never this per-word classification.
  const wordStates = useMemo(
    () => words.map((word) => getWordExclusionState(word, excludedSegments)),
    [words, excludedSegments]
  );

  useEffect(() => {
    const handleScroll = () => {
      if (programmaticScrollRef.current) return;
      lastManualScrollAtRef.current = Date.now();
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Keep the active word visible during playback, without fighting a user
  // who is actively selecting text or who just scrolled manually.
  useEffect(() => {
    if (!isPlaying || activeWordIndex < 0 || activeSelection) return;

    const sinceManualScroll = Date.now() - lastManualScrollAtRef.current;
    if (sinceManualScroll < MANUAL_SCROLL_COOLDOWN_MS) return;

    const container = transcriptRef.current;
    const element = container?.querySelector(`[data-word-index="${activeWordIndex}"]`);
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const isOutOfView =
      rect.top < AUTO_SCROLL_MARGIN_PX || rect.bottom > window.innerHeight - AUTO_SCROLL_MARGIN_PX;

    if (!isOutOfView) return;

    programmaticScrollRef.current = true;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 500);
  }, [activeWordIndex, isPlaying, activeSelection]);

  const resolveActiveSelection = useCallback(() => {
    const container = transcriptRef.current;
    if (!container) return null;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);

    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      return null;
    }

    if (range.toString().trim() === '') {
      return null;
    }

    let minIndex = null;
    let maxIndex = null;

    container.querySelectorAll('[data-word-index]').forEach((element) => {
      if (range.intersectsNode(element)) {
        const index = Number(element.dataset.wordIndex);
        if (minIndex === null || index < minIndex) minIndex = index;
        if (maxIndex === null || index > maxIndex) maxIndex = index;
      }
    });

    if (minIndex === null || maxIndex === null) {
      return null;
    }

    const firstWord = words[minIndex];
    const lastWord = words[maxIndex];
    if (!firstWord || !lastWord) return null;

    const rect = getUsableRect(range);

    // Classification (included/excluded/mixed) is computed once, centrally,
    // in App from the same excludedSegments every other consumer uses - not
    // duplicated here.
    return {
      startWordIndex: minIndex,
      endWordIndex: maxIndex,
      start: firstWord.start,
      end: lastWord.end,
      rect: {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    };
  }, [words]);

  const updateActiveSelection = useCallback(() => {
    onSelectionChange?.(resolveActiveSelection());
  }, [resolveActiveSelection, onSelectionChange]);

  useEffect(() => {
    const container = transcriptRef.current;
    if (!container) return;

    // A word click seeks; dragging or highlighting text opens the
    // Remove/Restore toolbar instead. Both start from the same mousedown, so
    // they have to be told apart here rather than via a plain onClick -
    // browsers still fire click/mouseup after a drag-selection ends.
    const handleMouseDown = (event) => {
      if (event.button !== 0) return;

      // Starting any new interaction here immediately relinquishes whatever
      // selection/toolbar is currently active - including one reported by
      // the waveform editor - so at most one can ever be open. If this
      // mousedown does turn into a fresh transcript selection, mouseup
      // below reports that right back via the same callback.
      onSelectionChange?.(null);

      const wordElement = event.target.closest('[data-word-index]');
      clickCandidateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        wordIndex: wordElement ? Number(wordElement.dataset.wordIndex) : null,
        moved: false,
      };
    };

    const handleMouseMove = (event) => {
      const candidate = clickCandidateRef.current;
      if (!candidate || candidate.moved) return;

      const dx = event.clientX - candidate.startX;
      const dy = event.clientY - candidate.startY;
      if (Math.hypot(dx, dy) >= CLICK_VS_DRAG_THRESHOLD_PX) {
        candidate.moved = true;
      }
    };

    const handleMouseUp = (event) => {
      // Always resolve the toolbar's selection state first - a click still
      // has to close/refresh it exactly like before.
      updateActiveSelection();

      const candidate = clickCandidateRef.current;
      clickCandidateRef.current = null;

      if (!onSeek || !candidate || candidate.moved || candidate.wordIndex === null) {
        return;
      }

      // `event.detail` is the browser's own click-count for this mouseup
      // (2+ on the second click of a double/triple click, which natively
      // selects a word/paragraph) - only a genuine standalone click seeks.
      if (event.detail && event.detail > 1) return;

      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const word = words[candidate.wordIndex];
      if (!word || !Number.isFinite(word.start)) return;

      onSeek(word.start);
    };

    const handleSelectionChange = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(updateActiveSelection, SELECTION_CHANGE_DEBOUNCE_MS);
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onSelectionChange?.(null);
      }
    };

    const handleOutsidePointerDown = (event) => {
      // Now that there is only ever one SelectionToolbar in the whole app
      // (rendered once in App), this query reliably finds it regardless of
      // which editor's selection is currently active.
      const toolbar = document.querySelector('.selection-toolbar');
      const insideTranscript = container.contains(event.target);
      const insideToolbar = toolbar ? toolbar.contains(event.target) : false;

      if (!insideTranscript && !insideToolbar) {
        onSelectionChange?.(null);
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleOutsidePointerDown);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleOutsidePointerDown);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [updateActiveSelection, onSeek, onSelectionChange, words]);

  // Whenever the app-wide active selection stops being "ours" - either
  // dismissed entirely or taken over by a waveform selection - drop the
  // native browser text highlight too, so it never lingers after its own
  // toolbar is gone.
  useEffect(() => {
    if (!activeSelection || activeSelection.source !== 'transcript') {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
    }
  }, [activeSelection]);

  return (
    <p className="transcript" ref={transcriptRef}>
      {words.map((word, index) => {
        const label = word.punctuated_word ?? word.word;
        const state = wordStates[index];
        const classNames = ['transcript-word'];
        if (state === 'excluded') classNames.push('transcript-word--excluded');
        if (state === 'partial') classNames.push('transcript-word--partial');
        if (index === activeWordIndex) classNames.push('transcript-word--active');

        return (
          <span key={index} data-word-index={index} className={classNames.join(' ')}>
            {label}{' '}
          </span>
        );
      })}
    </p>
  );
}

export default TranscriptEditor;
