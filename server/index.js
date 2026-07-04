import express from "express";
import cors from "cors";

import { uploadAudio, getAudioUrl } from "./audioUpload.js";
import { transcribeAudio } from "./transcription.js";

const app = express();
const PORT = 3000;

app.use(cors());
app.use("/uploads", express.static("uploads"));

app.post("/api/upload", uploadAudio, async (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      error: "No audio file uploaded",
    });
  }

  try {
    const transcript = await transcribeAudio(req.file.path);

    res.json({
      message: "File uploaded and transcribed",
      file: {
        ...req.file,
        url: getAudioUrl(req.file.filename),
        transcript,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});