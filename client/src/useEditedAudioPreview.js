import { useEffect, useRef } from 'react';

// Lets the user preview the "edited" result of the retake selection without
// ever rendering a new audio file: while the given audio element plays, this
// hook watches currentTime via requestAnimationFrame and jumps straight to
// the end of any excluded segment it enters (whether by natural playback or
// by the user manually seeking into it).
export function useEditedAudioPreview(audioRef, excludedSegments) {
  const segmentsRef = useRef(excludedSegments);
  const frameRef = useRef(null);

  useEffect(() => {
    segmentsRef.current = excludedSegments;
  }, [excludedSegments]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const stopLoop = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const skipIfExcluded = () => {
      const segments = segmentsRef.current;
      const currentTime = audio.currentTime;

      const segment = segments.find(
        (candidate) => currentTime >= candidate.start && currentTime < candidate.end
      );

      if (segment) {
        try {
          audio.currentTime = segment.end;
        } catch {
          // Setting currentTime can throw if the media isn't seekable yet;
          // it will simply be re-checked on the next animation frame.
        }
      }
    };

    const tick = () => {
      skipIfExcluded();
      frameRef.current = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      stopLoop();
      frameRef.current = requestAnimationFrame(tick);
    };

    const handlePlay = () => startLoop();
    const handlePause = () => stopLoop();
    const handleEnded = () => stopLoop();
    const handleSeeked = () => skipIfExcluded();

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('seeked', handleSeeked);

    if (!audio.paused) {
      startLoop();
    }

    return () => {
      stopLoop();
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('seeked', handleSeeked);
    };
  }, [audioRef]);
}
