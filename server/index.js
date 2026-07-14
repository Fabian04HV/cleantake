import express from "express";
import cors from "cors";
import { existsSync } from "fs";

import { uploadAudio, getAudioUrl, resolveUploadPath } from "./audioUpload.js";
import { transcribeAudio } from "./transcription.js";
import {
  findSilencesFromWords,
  getKeepSegments,
  normalizeExcludedSegments,
  renderKeepSegments,
  getAudioDuration,
} from "./audioEditing.js";
import { findRetakesFromWords } from "./retakeDetection.js";

const app = express();
const PORT = 3000;

app.use(cors());
app.use("/uploads", express.static("uploads"));
app.use("/exports", express.static("exports"));
app.use(express.json());

app.post("/api/upload", uploadAudio, async (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      error: "No audio file uploaded",
    });
  }

  try {
    const transcript = await transcribeAudio(req.file.path);
    console.log("WORDS: ", transcript.words);

    res.json({
      message: "File uploaded and transcribed",
      file: {
        ...req.file,
        url: getAudioUrl(req.file.filename),
        transcript: transcript.transcript,
        words: transcript.words,
      },
    });
  } 
  catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to transcribe audio",
    });
  }
});

// Detection only: figures out which time ranges are likely silence, but
// never touches the audio file itself - exactly like /api/remove-retakes
// below. The frontend adds these as suggested excluded segments to its own
// non-destructive editing state and only calls /api/export-audio once the
// user is happy with the combined edit list.
app.post("/api/remove-silences", async (req, res) => {
  try {
    const { words } = req.body;

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({
        error: "No transcript words provided",
      });
    }

    const silences = findSilencesFromWords(words);

    return res.json({
      silences,
    });
  } catch (error) {
    console.error("Silence detection failed:", error);

    return res.status(500).json({
      error: "Failed to detect silences",
    });
  }
});

// Detection only: figures out which word/time ranges are likely retakes, but
// never touches the audio file itself. The frontend keeps its own editable
// "excluded" state and only calls /api/export-audio once the user is happy
// with their selection.
app.post("/api/remove-retakes", async (req, res) => {
  try {
    const { words } = req.body;

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({
        error: "No transcript words provided"
      });
    }

    const retakes = findRetakesFromWords(words);

    return res.json({
      retakes
    });
  } catch (error) {
    console.error("Retake detection failed:", error);

    return res.status(500).json({
      error: "Failed to detect retakes"
    });
  }
});

// Renders the final, edited audio file: everything the client marked as
// excluded gets cut out with FFmpeg, the original upload is never modified.
app.post("/api/export-audio", async (req, res) => {
  try {
    const { path, excludedSegments } = req.body;

    const resolvedPath = resolveUploadPath(path);
    if (!resolvedPath || !existsSync(resolvedPath)) {
      return res.status(400).json({ error: "Invalid audio file path" });
    }

    if (!Array.isArray(excludedSegments)) {
      return res.status(400).json({ error: "excludedSegments must be an array" });
    }

    const duration = await getAudioDuration(resolvedPath);
    const normalizedExcluded = normalizeExcludedSegments(excludedSegments, duration);
    const keepSegments = getKeepSegments(normalizedExcluded, duration);

    if (keepSegments.length === 0) {
      return res.status(400).json({
        error: "Removing all selected segments would leave no audio behind",
      });
    }

    const outputFilename = `export-${Date.now()}.mp3`;
    const outputPath = `exports/${outputFilename}`;

    await renderKeepSegments(resolvedPath, keepSegments, outputPath);

    return res.download(outputPath, "clean-take.mp3");
  } catch (error) {
    console.error("Audio export failed:", error);
    return res.status(500).json({ error: "Failed to export audio" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
