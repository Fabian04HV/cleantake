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

export function findSilencesFromWords(words) {
  const silences = [];

  const threshold = 0.5
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