// Pure, immutable helpers around "word ranges" - inclusive
// [startWordIndex, endWordIndex] spans into the Deepgram `words` array. These
// are the single source of truth for which parts of the transcript/audio are
// currently excluded, regardless of whether a range came from automatic
// retake detection, manual text selection, or any future feature.

function toRangeId(startWordIndex, endWordIndex) {
  return `excluded-${startWordIndex}-${endWordIndex}`;
}

function isValidRange(range) {
  return (
    range &&
    Number.isFinite(range.startWordIndex) &&
    Number.isFinite(range.endWordIndex) &&
    range.endWordIndex >= range.startWordIndex
  );
}

// Sorts by start index, merges overlapping and directly adjacent ranges, and
// regenerates stable ids from the resulting indexes.
export function mergeWordRanges(ranges) {
  if (!Array.isArray(ranges)) return [];

  const sorted = ranges
    .filter(isValidRange)
    .map((range) => ({ startWordIndex: range.startWordIndex, endWordIndex: range.endWordIndex }))
    .sort((a, b) => a.startWordIndex - b.startWordIndex || a.endWordIndex - b.endWordIndex);

  if (sorted.length === 0) return [];

  const merged = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.startWordIndex <= last.endWordIndex + 1) {
      last.endWordIndex = Math.max(last.endWordIndex, current.endWordIndex);
    } else {
      merged.push({ ...current });
    }
  }

  return merged.map(({ startWordIndex, endWordIndex }) => ({
    id: toRangeId(startWordIndex, endWordIndex),
    startWordIndex,
    endWordIndex,
  }));
}

// Adds a range to the excluded set, merging it with anything it overlaps or
// touches.
export function excludeWordRange(currentRanges, selectionRange) {
  if (!isValidRange(selectionRange)) return currentRanges;
  return mergeWordRanges([...currentRanges, selectionRange]);
}

// Subtracts a range from the excluded set, splitting existing ranges when the
// selection only partially overlaps them.
export function includeWordRange(currentRanges, selectionRange) {
  if (!isValidRange(selectionRange)) return currentRanges;

  const { startWordIndex: selStart, endWordIndex: selEnd } = selectionRange;
  const remaining = [];

  for (const range of currentRanges) {
    const { startWordIndex, endWordIndex } = range;

    const noOverlap = selEnd < startWordIndex || selStart > endWordIndex;
    if (noOverlap) {
      remaining.push({ startWordIndex, endWordIndex });
      continue;
    }

    if (startWordIndex < selStart) {
      remaining.push({ startWordIndex, endWordIndex: selStart - 1 });
    }
    if (endWordIndex > selEnd) {
      remaining.push({ startWordIndex: selEnd + 1, endWordIndex });
    }
  }

  return mergeWordRanges(remaining);
}

export function isWordExcluded(wordIndex, excludedRanges) {
  if (!Array.isArray(excludedRanges)) return false;

  return excludedRanges.some(
    (range) => wordIndex >= range.startWordIndex && wordIndex <= range.endWordIndex
  );
}

// "included": none of the selected words are excluded
// "excluded": every selected word is excluded
// "mixed": some but not all of the selected words are excluded
export function getSelectionState(startWordIndex, endWordIndex, excludedRanges) {
  let hasIncludedWord = false;
  let hasExcludedWord = false;

  for (let index = startWordIndex; index <= endWordIndex; index++) {
    if (isWordExcluded(index, excludedRanges)) {
      hasExcludedWord = true;
    } else {
      hasIncludedWord = true;
    }

    if (hasIncludedWord && hasExcludedWord) {
      return 'mixed';
    }
  }

  return hasExcludedWord ? 'excluded' : 'included';
}
