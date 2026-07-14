import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SelectionToolbar from './SelectionToolbar.jsx';
import { getSelectionState } from './utils/wordRanges.js';

const SELECTION_CHANGE_DEBOUNCE_MS = 120;

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
// SelectionToolbar. This is intentionally independent from how a range ended
// up in `excludedWordRanges` - manual selection, automatic retake detection,
// or anything else all look the same here.
function TranscriptEditor({ words, excludedWordRanges, onExcludeRange, onIncludeRange }) {
  const transcriptRef = useRef(null);
  const debounceRef = useRef(null);
  const [activeSelection, setActiveSelection] = useState(null);

  // A Set lookup keeps per-word rendering O(1) instead of scanning
  // `excludedWordRanges` for every single word on every render.
  const excludedWordIndexes = useMemo(() => {
    const indexes = new Set();
    for (const range of excludedWordRanges) {
      for (let index = range.startWordIndex; index <= range.endWordIndex; index++) {
        indexes.add(index);
      }
    }
    return indexes;
  }, [excludedWordRanges]);

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

    const rect = getUsableRect(range);
    const state = getSelectionState(minIndex, maxIndex, excludedWordRanges);

    return {
      startWordIndex: minIndex,
      endWordIndex: maxIndex,
      state,
      rect: {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    };
  }, [excludedWordRanges]);

  const updateActiveSelection = useCallback(() => {
    setActiveSelection(resolveActiveSelection());
  }, [resolveActiveSelection]);

  useEffect(() => {
    const container = transcriptRef.current;
    if (!container) return;

    const handleMouseUp = () => updateActiveSelection();

    const handleSelectionChange = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(updateActiveSelection, SELECTION_CHANGE_DEBOUNCE_MS);
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setActiveSelection(null);
      }
    };

    const handleOutsidePointerDown = (event) => {
      const toolbar = document.querySelector('.selection-toolbar');
      const insideTranscript = container.contains(event.target);
      const insideToolbar = toolbar ? toolbar.contains(event.target) : false;

      if (!insideTranscript && !insideToolbar) {
        setActiveSelection(null);
      }
    };

    container.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleOutsidePointerDown);

    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleOutsidePointerDown);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [updateActiveSelection]);

  const clearBrowserSelection = () => {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  };

  const closeToolbar = () => {
    clearBrowserSelection();
    setActiveSelection(null);
  };

  const handleExclude = () => {
    if (!activeSelection) return;
    onExcludeRange({
      startWordIndex: activeSelection.startWordIndex,
      endWordIndex: activeSelection.endWordIndex,
    });
    closeToolbar();
  };

  const handleInclude = () => {
    if (!activeSelection) return;
    onIncludeRange({
      startWordIndex: activeSelection.startWordIndex,
      endWordIndex: activeSelection.endWordIndex,
    });
    closeToolbar();
  };

  return (
    <>
      <p className="transcript" ref={transcriptRef}>
        {words.map((word, index) => {
          const label = word.punctuated_word ?? word.word;
          const classNames = ['transcript-word'];
          if (excludedWordIndexes.has(index)) classNames.push('transcript-word--excluded');

          return (
            <span key={index} data-word-index={index} className={classNames.join(' ')}>
              {label}{' '}
            </span>
          );
        })}
      </p>
      <SelectionToolbar
        selection={activeSelection}
        onExclude={handleExclude}
        onInclude={handleInclude}
        onClose={closeToolbar}
      />
    </>
  );
}

export default TranscriptEditor;
