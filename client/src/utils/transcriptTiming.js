import { getTimeRangeState } from "./audioSegments.js";

// Binary search over Deepgram's `words` array (sorted, non-overlapping by
// construction) for the word that is active at `sourceTime`.
//
// A word is active when word.start <= sourceTime <= word.end. When
// `sourceTime` falls in a pause between words, the most recently spoken word
// is returned instead of `-1` - the transcript should keep highlighting the
// last thing that was said until the next word actually starts.
export function findActiveWordIndex(words, sourceTime) {
  if (!Array.isArray(words) || words.length === 0 || !Number.isFinite(sourceTime)) {
    return -1;
  }

  let low = 0;
  let high = words.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const word = words[mid];

    if (sourceTime < word.start) {
      high = mid - 1;
    } else {
      candidate = mid;
      low = mid + 1;
    }
  }

  return candidate;
}

// Binary search for the word whose [start, end] span contains `time`, or
// `null` when `time` falls in a silent gap between words.
function findWordAtTime(words, time) {
  let low = 0;
  let high = words.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const word = words[mid];

    if (time < word.start) {
      high = mid - 1;
    } else if (time > word.end) {
      low = mid + 1;
    } else {
      return word;
    }
  }

  return null;
}

// Hybrid snapping: a boundary that lands inside a spoken word snaps to that
// word's edge (so users can't accidentally cut through a syllable), while a
// boundary that lands in silence is preserved exactly.
export function snapStartTimeToWordBoundary(time, words) {
  if (!Array.isArray(words) || words.length === 0 || !Number.isFinite(time)) return time;
  const word = findWordAtTime(words, time);
  return word ? word.start : time;
}

export function snapEndTimeToWordBoundary(time, words) {
  if (!Array.isArray(words) || words.length === 0 || !Number.isFinite(time)) return time;
  const word = findWordAtTime(words, time);
  return word ? word.end : time;
}

// "included" | "excluded" | "partial" (only part of the word's spoken range
// is covered by excluded audio - rare once boundaries are snapped, but the
// UI must still handle it safely).
export function getWordExclusionState(word, excludedSegments) {
  const state = getTimeRangeState(word.start, word.end, excludedSegments);
  return state === "mixed" ? "partial" : state;
}

function isWordFullyExcluded(word, excludedSegments) {
  return getWordExclusionState(word, excludedSegments) === "excluded";
}

// The word the transcript should visually highlight: the raw active word
// (see findActiveWordIndex), walked backward past any excluded words so
// playback skipping an excluded passage never lets a crossed-out word light
// up, even momentarily.
export function resolveVisibleActiveWordIndex(words, rawActiveIndex, excludedSegments) {
  if (!Array.isArray(words)) return -1;

  for (let index = rawActiveIndex; index >= 0; index--) {
    const word = words[index];
    if (word && !isWordFullyExcluded(word, excludedSegments)) {
      return index;
    }
  }

  return -1;
}
