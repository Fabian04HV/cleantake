import { mkdirSync } from "fs";
import { execFile } from "child_process";
import ffmpegPath from "ffmpeg-static";

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

export function getKeepSegments(silences, duration) {
  const keepSegments = [];
  let cursor = 0;

  for (const silence of silences) {
    if (silence.start > cursor) {
      keepSegments.push({ start: cursor, end: silence.start });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < duration) {
    keepSegments.push({ start: cursor, end: duration });
  }
  return keepSegments;
}

export function cutSilences(inputPath, keepSegments, outputPath) { 
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
    execFile(ffmpegPath, args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

export function findRetakesFromWords(words) {
  const retakes = [];

  
} 