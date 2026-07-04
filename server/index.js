import express from "express";
import cors from "cors";

import { uploadAudio, getAudioUrl } from "./audioUpload.js";
import { findSilencesFromWords, transcribeAudio } from "./transcription.js";

const app = express();
const PORT = 3000;

app.use(cors());
app.use("/uploads", express.static("uploads"));
app.use("/exports", express.static("exports"))
app.use(express.json())

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

app.post("/api/remove-silences", (req, res) => {
  const { words, path } = req.body 
  
  const silences = findSilencesFromWords(words)
  
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});