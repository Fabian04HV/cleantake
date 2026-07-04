import multer from "multer";

export const uploadAudio = multer({
  dest: "uploads/",
}).single("audio");

export function getAudioUrl(filename) {
  return `http://localhost:3000/uploads/${filename}`;
}