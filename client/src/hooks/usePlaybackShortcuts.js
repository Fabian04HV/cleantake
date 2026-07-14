import { useEffect } from "react";

const EDITABLE_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (EDITABLE_TAG_NAMES.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

// Global Space-to-toggle-playback shortcut. Both this hook and the transport
// play button call the exact same `togglePlayback`, so there is only ever
// one code path that can start/stop the shared audio element.
export function usePlaybackShortcuts(togglePlayback) {
  useEffect(() => {
    if (typeof togglePlayback !== "function") return;

    const handleKeyDown = (event) => {
      if (event.code !== "Space" && event.key !== " ") return;
      if (event.repeat) return;
      if (isTypingTarget(event.target)) return;

      // A focused <button> (e.g. the play/pause button itself) already
      // toggles playback via its own click-on-Space behavior; let the
      // browser handle that natively instead of toggling twice.
      if (event.target instanceof HTMLElement && event.target.tagName === "BUTTON") return;

      event.preventDefault();
      togglePlayback();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [togglePlayback]);
}
