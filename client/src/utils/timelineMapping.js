// Helpers that translate between SOURCE TIME (a position in the original,
// unmodified uploaded file - used by Deepgram timestamps, the waveform, and
// FFmpeg export ranges) and EDITED TIME (how much included audio the user
// would actually hear, with every excluded segment skipped).
//
// The waveform, playhead and export all stay in source time. Edited time is
// only ever used for the optional current-time / duration display.

function findExcludedSegmentAtTime(time, excludedSegments) {
  if (!Array.isArray(excludedSegments)) return null;

  for (const segment of excludedSegments) {
    if (time >= segment.start && time < segment.end) {
      return segment;
    }
  }

  return null;
}

// A source time inside an excluded segment maps to the edited time at that
// segment's start - i.e. "as far as the user would have gotten" - until
// playback actually resolves the seek to the next playable position.
export function sourceTimeToEditedTime(sourceTime, excludedSegments) {
  if (!Number.isFinite(sourceTime)) return 0;

  const segments = Array.isArray(excludedSegments) ? excludedSegments : [];
  const containingSegment = findExcludedSegmentAtTime(sourceTime, segments);
  const effectiveTime = containingSegment ? containingSegment.start : sourceTime;

  let excludedBefore = 0;
  for (const segment of segments) {
    if (segment.end <= effectiveTime) {
      excludedBefore += segment.end - segment.start;
    }
  }

  return Math.max(0, effectiveTime - excludedBefore);
}

export function getEditedDuration(sourceDuration, excludedSegments) {
  if (!Number.isFinite(sourceDuration)) return 0;

  const segments = Array.isArray(excludedSegments) ? excludedSegments : [];
  const totalExcluded = segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);

  return Math.max(0, sourceDuration - totalExcluded);
}

export { findExcludedSegmentAtTime };

// Resolves `time` forward past any excluded segment(s) it falls inside,
// repeating in case the resolved position itself lands inside another
// (adjacent) excluded segment. Returns `null` when no playable audio remains
// from this position onward.
export function findNextPlayableTime(time, excludedSegments, duration) {
  const segments = Array.isArray(excludedSegments) ? excludedSegments : [];
  let resolvedTime = time;

  // Bounded by segments.length + 1: even in the worst case (every segment
  // chained back-to-back) we can only ever jump past each segment once.
  for (let iterations = 0; iterations <= segments.length; iterations++) {
    const segment = findExcludedSegmentAtTime(resolvedTime, segments);
    if (!segment) break;
    resolvedTime = segment.end;
  }

  if (Number.isFinite(duration) && resolvedTime >= duration - 0.001) {
    return null;
  }

  return resolvedTime;
}

// Formats a duration/time in seconds as "00:00", "01:24", or "01:02:18".
export function formatTime(totalSeconds) {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const wholeSeconds = Math.floor(safeSeconds);

  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;

  const pad = (value) => String(value).padStart(2, "0");

  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
