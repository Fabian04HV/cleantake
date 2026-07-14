import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import contentCutIconSvg from './icons/content_cut_24dp_E3E3E3_FILL0_wght300_GRAD0_opsz24.svg?raw';
import undoIconSvg from './icons/undo_24dp_E3E3E3_FILL0_wght300_GRAD0_opsz24.svg?raw';

const VIEWPORT_MARGIN = 8;

// Small contextual toolbar shown near the current text selection. Rendered
// through a portal so it is never clipped by the transcript container, and
// self-measures once mounted so it can clamp itself inside the viewport.
// There is no explicit close button - Escape, clicking outside, or choosing
// an action all already dismiss it (see App/TranscriptEditor/WaveformEditor).
function SelectionToolbar({ selection, onExclude, onInclude }) {
  const toolbarRef = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!selection || !toolbarRef.current) {
      setPosition(null);
      return;
    }

    const { rect } = selection;
    const toolbarRect = toolbarRef.current.getBoundingClientRect();

    const minLeft = VIEWPORT_MARGIN;
    const maxLeft = Math.max(minLeft, window.innerWidth - toolbarRect.width - VIEWPORT_MARGIN);
    const idealLeft = rect.left + rect.width / 2 - toolbarRect.width / 2;
    const left = Math.min(Math.max(idealLeft, minLeft), maxLeft);

    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const top =
      spaceAbove >= toolbarRect.height
        ? rect.top - toolbarRect.height - VIEWPORT_MARGIN
        : rect.bottom + VIEWPORT_MARGIN;

    setPosition({ top, left });
  }, [selection]);

  if (!selection) return null;

  const { state } = selection;
  const canExclude = state === 'included' || state === 'mixed';
  const canInclude = state === 'excluded' || state === 'mixed';

  return createPortal(
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      role="toolbar"
      aria-label="Selection actions"
      style={{
        top: position ? position.top : selection.rect.top,
        left: position ? position.left : selection.rect.left,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {canExclude && (
        <button
          type="button"
          className="selection-action-button selection-action-button--remove"
          onClick={onExclude}
          aria-label="Remove selected audio"
          title="Remove selected audio"
        >
          <Icon svg={contentCutIconSvg} />
        </button>
      )}
      {canInclude && (
        <button
          type="button"
          className="selection-action-button selection-action-button--restore"
          onClick={onInclude}
          aria-label="Restore selected audio"
          title="Restore selected audio"
        >
          <Icon svg={undoIconSvg} />
        </button>
      )}
    </div>,
    document.body
  );
}

export default SelectionToolbar;
