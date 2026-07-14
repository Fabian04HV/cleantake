import { mkdirSync } from "fs";
import { execFile } from "child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export function findSilencesFromWords(words) {
  const silences = [];

  const threshold = 0.3
  const padding = 0.1

  for(let i = 0; i < words.length - 1; i++) {

    if(words[i].end + threshold < words[i + 1].start){
      silences.push({
        start: words[i].end + padding,
        end: words[i + 1].start - padding
      })
    }
  }

  return silences
}

// Turns a list of excluded (to-be-removed) time ranges into the complementary
// list of ranges that should be kept, across the full duration of the file.
export function getKeepSegments(excludedSegments, duration) {
  const keepSegments = [];
  let cursor = 0;

  for (const excluded of excludedSegments) {
    if (excluded.start > cursor) {
      keepSegments.push({ start: cursor, end: excluded.start });
    }
    cursor = Math.max(cursor, excluded.end);
  }
  if (cursor < duration) {
    keepSegments.push({ start: cursor, end: duration });
  }
  return keepSegments;
}

// Sanitizes excluded segments coming from the client (or from detection
// logic): clamps them into [0, duration], drops invalid/empty ranges, sorts
// them and merges anything overlapping or directly adjacent.
export function normalizeExcludedSegments(segments, duration) {
  if (!Array.isArray(segments)) {
    return [];
  }

  const safeDuration = Number.isFinite(duration) ? duration : Infinity;

  const clamped = segments
    .map((segment) => ({
      start: Math.max(0, Number(segment?.start)),
      end: Math.min(safeDuration, Number(segment?.end)),
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start
    )
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const segment of clamped) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

// Generic FFmpeg export step: cuts out the given keep-segments from
// inputPath, resets their timestamps and concatenates them back together.
// Used both by /api/remove-silences and /api/export-audio.
export function renderKeepSegments(inputPath, keepSegments, outputPath) {
  mkdirSync("exports", { recursive: true });

  const filterParts = keepSegments.map((seg, i) =>
    `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
  );

  const concatInputs = keepSegments.map((_, i) => `[a${i}]`).join("");
  const filterComplex =
    filterParts.join(";") +
    `;${concatInputs}concat=n=${keepSegments.length}:v=0:a=1[out]`;

  const args = [
    "-y",
    "-i", inputPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

// The last Deepgram word timestamp is not a reliable stand-in for the real
// file duration (there can be trailing audio after the last spoken word), so
// the export route determines it via ffprobe instead.
export function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobeStatic.path,
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      (err, stdout) => {
        if (err) return reject(err);

        const duration = Number.parseFloat(stdout);
        if (!Number.isFinite(duration)) {
          return reject(new Error("Could not determine audio duration"));
        }

        resolve(duration);
      }
    );
  });
}
