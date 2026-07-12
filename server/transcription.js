import "dotenv/config";
import { createReadStream } from "fs";
import { DeepgramClient } from "@deepgram/sdk";

const deepgram = new DeepgramClient({
  apiKey: process.env.DEEPGRAM_API_KEY,
});

export async function transcribeAudio(filePath) {
  const response = await deepgram.listen.v1.media.transcribeFile(
    createReadStream(filePath),
    {
      model: "nova-3",
      smart_format: true,
    }
  );

  
  const alternative = response.results?.channels?.[0]?.alternatives?.[0];

  return {
    transcript: alternative?.transcript || "",
    words: alternative?.words || [],
  };
}

