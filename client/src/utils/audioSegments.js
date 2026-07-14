// Pure, immutable helpers around "excluded segments" - the authoritative
// editing state of the whole app. Unlike the previous word-index based
// ranges, these are plain [start, end] spans of *source time* (seconds into
// the original uploaded file), because a waveform selection can begin or end
// inside silence, between words, or at any arbitrary point in the audio.
//
// Every part of the UI (waveform darkening, transcript strikethrough, live
// preview skipping, export) derives from this same array, regardless of
// whether a segment came from automatic retake detection, a manual
// transcript selection, or a manual waveform selection.

// Small tolerance used whenever comparing floating point time values, e.g.
// to treat two segments that touch (but don't numerically overlap due to
// rounding) as adjacent, or a selection that lands a hair outside a segment
// as still fully inside it.
export const TIME_EPSILON = 0.005;

function isValidRange(range) {
  return (
    range &&
    Number.isFinite(range.start) &&
    Number.isFinite(range.end) &&
    range.end - range.start > TIME_EPSILON
  );
}

function toSegment(start, end, origin) {
  return {
    id: `excluded-${start.toFixed(3)}-${end.toFixed(3)}`,
    start,
    end,
    origin: origin ?? "manual",
  };
}

// Removes invalid ranges, clamps to [0, duration], drops zero-length ranges,
// sorts by start time, and merges overlapping or directly-adjacent ranges
// (within TIME_EPSILON) into single segments with fresh, stable ids. Never
// mutates the input array.
export function normalizeExcludedSegments(segments, duration) {
  if (!Array.isArray(segments)) return [];

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : Infinity;

  const clamped = segments
    .filter((segment) => segment && Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .map((segment) => ({
      start: Math.max(0, Math.min(segment.start, segment.end)),
      end: Math.min(safeDuration, Math.max(segment.start, segment.end)),
      origin: segment.origin,
    }))
    .filter((segment) => segment.end - segment.start > TIME_EPSILON)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];

  for (const segment of clamped) {
    const last = merged[merged.length - 1];

    if (last && segment.start <= last.end + TIME_EPSILON) {
      last.end = Math.max(last.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged.map((segment) => toSegment(segment.start, segment.end, segment.origin));
}

// Adds a time range to the excluded set and re-normalizes.
export function excludeTimeRange(currentSegments, range, duration) {
  if (!isValidRange(range)) return normalizeExcludedSegments(currentSegments, duration);

  const next = [
    ...(Array.isArray(currentSegments) ? currentSegments : []),
    { start: range.start, end: range.end, origin: range.origin },
  ];

  return normalizeExcludedSegments(next, duration);
}

// Restores a time range by subtracting it from the excluded set: complete
// segments inside the range are dropped, segments the range only partially
// overlaps are trimmed or split in two.
export function includeTimeRange(currentSegments, range, duration) {
  if (!isValidRange(range)) return normalizeExcludedSegments(currentSegments, duration);
  if (!Array.isArray(currentSegments)) return [];

  const { start: selStart, end: selEnd } = range;
  const remaining = [];

  for (const segment of currentSegments) {
    const { start, end, origin } = segment;

    const noOverlap = selEnd <= start || selStart >= end;
    if (noOverlap) {
      remaining.push({ start, end, origin });
      continue;
    }

    if (start < selStart) {
      remaining.push({ start, end: selStart, origin });
    }
    if (end > selEnd) {
      remaining.push({ start: selEnd, end, origin });
    }
  }

  return normalizeExcludedSegments(remaining, duration);
}

// Removes every segment with the given origin, keeping everything else
// untouched. Used before merging in a fresh batch of automatic detections so
// stale suggestions from an older run never linger.
export function removeSegmentsByOrigin(currentSegments, origin) {
  if (!Array.isArray(currentSegments)) return [];
  return currentSegments.filter((segment) => segment.origin !== origin);
}

// "included": the selected time range has no meaningful overlap with
//   excluded audio
// "excluded": the complete selected time range is excluded
// "mixed": only part of the selection is excluded
export function getTimeRangeState(start, end, excludedSegments) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return "included";
  }

  const segments = Array.isArray(excludedSegments) ? excludedSegments : [];
  const total = end - start;
  let excludedDuration = 0;

  for (const segment of segments) {
    const overlapStart = Math.max(start, segment.start);
    const overlapEnd = Math.min(end, segment.end);
    if (overlapEnd > overlapStart) {
      excludedDuration += overlapEnd - overlapStart;
    }
  }

  if (excludedDuration <= TIME_EPSILON) return "included";
  if (excludedDuration >= total - TIME_EPSILON) return "excluded";
  return "mixed";
}
