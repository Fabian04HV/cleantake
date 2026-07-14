import multer from "multer";
import { resolve as resolvePath, sep } from "path";

const UPLOADS_DIR = resolvePath("uploads");

export const uploadAudio = multer({
  dest: "uploads/",
}).single("audio");

export function getAudioUrl(filename) {
  return `http://localhost:3000/uploads/${filename}`;
}

// Resolves a client-supplied path and makes sure it actually lives inside the
// uploads directory, so requests can't escape it with something like
// "../../some-file" to read/process arbitrary files on disk.
export function resolveUploadPath(candidatePath) {
  if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
    return null;
  }

  const resolved = resolvePath(candidatePath);

  if (resolved !== UPLOADS_DIR && !resolved.startsWith(UPLOADS_DIR + sep)) {
    return null;
  }

  return resolved;
}