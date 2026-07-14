import { useMemo, useRef, useState } from 'react'
import TranscriptEditor from './TranscriptEditor.jsx'
import WaveformEditor from './WaveformEditor.jsx'
import SelectionToolbar from './SelectionToolbar.jsx'
import { useEditedPlayback } from './hooks/useEditedPlayback.js'
import { usePlaybackShortcuts } from './hooks/usePlaybackShortcuts.js'
import { excludeTimeRange, getTimeRangeState, includeTimeRange, normalizeExcludedSegments } from './utils/audioSegments.js'

function App() {

  const [uploadedAudio, setUploadedAudio] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  // The authoritative editing state is split by *source* rather than kept as
  // one flat list: re-running automatic detection (retakes or silences) must
  // be able to replace only its own previous suggestions without disturbing
  // manual transcript/waveform edits or the other detector's suggestions.
  // Once two sources' ranges overlap and get merged into a single normalized
  // segment, that per-segment origin is gone - so instead of trying to
  // recover it later, each source's *raw* ranges are kept separately and
  // merged fresh every time via `excludedSegments` below.
  const [automaticRetakeSegments, setAutomaticRetakeSegments] = useState([]);
  const [automaticSilenceSegments, setAutomaticSilenceSegments] = useState([]);
  const [manualSegments, setManualSegments] = useState([]);

  // `retakes` / `silences` are kept only as metadata (e.g. "N retakes
  // detected"); they no longer drive the transcript, waveform, preview or
  // export - `excludedSegments` (derived below) is the only source of truth
  // for that.
  const [retakes, setRetakes] = useState([]);
  const [isDetectingRetakes, setIsDetectingRetakes] = useState(false);
  const [hasDetectedRetakes, setHasDetectedRetakes] = useState(false);

  const [silences, setSilences] = useState([]);
  const [isRemovingSilences, setIsRemovingSilences] = useState(false);
  const [hasDetectedSilences, setHasDetectedSilences] = useState(false);

  const [isExporting, setIsExporting] = useState(false);

  // The one authoritative selection: TranscriptEditor and WaveformEditor
  // never keep their own "active selection" state or render their own
  // SelectionToolbar - they only *report* selections up via
  // onSelectionChange, tagged with `source` here. That guarantees at most
  // one selection (and therefore exactly one rendered toolbar) can ever
  // exist, which is what previously let a transcript selection and a
  // waveform selection be open - and rendering their own actions - at the
  // same time.
  const [activeSelection, setActiveSelection] = useState(null);

  // The one authoritative playback media element, shared between the
  // <audio> tag, WaveSurfer, and every control surface.
  const audioRef = useRef(null);

  // `useEditedPlayback` needs *a* merged excludedSegments list before it can
  // report `sourceDuration` itself (its input can't depend on its own
  // output), so this first merge never clamps to a duration - unclamped
  // ranges are harmless for the skip-during-playback logic that consumes
  // them, since the browser can never play past its own real duration
  // anyway. The real, duration-clamped list used by everything else
  // (waveform, transcript, export) is derived right below once
  // `playback.sourceDuration` is available.
  const rawExcludedSegments = useMemo(
    () => normalizeExcludedSegments(
      [...automaticRetakeSegments, ...automaticSilenceSegments, ...manualSegments],
      Infinity
    ),
    [automaticRetakeSegments, automaticSilenceSegments, manualSegments]
  );

  const playback = useEditedPlayback({
    audioRef,
    words: uploadedAudio?.words ?? [],
    excludedSegments: rawExcludedSegments,
  });

  // The actual authoritative state every consumer (waveform, transcript,
  // export) reads from: the same three raw sources, clamped to the real
  // source duration once it is known.
  const excludedSegments = useMemo(
    () => normalizeExcludedSegments(
      rawExcludedSegments,
      playback.sourceDuration > 0 ? playback.sourceDuration : Infinity
    ),
    [rawExcludedSegments, playback.sourceDuration]
  );

  usePlaybackShortcuts(playback.togglePlayback);

  // The single authoritative classification (included/excluded/mixed) for
  // whatever selection is currently active, derived exclusively from the
  // same normalized `excludedSegments` every other consumer uses - never
  // recomputed differently for transcript vs. waveform selections.
  const selectionForToolbar = useMemo(() => {
    if (!activeSelection) return null;
    return {
      ...activeSelection,
      state: getTimeRangeState(activeSelection.start, activeSelection.end, excludedSegments),
    };
  }, [activeSelection, excludedSegments]);

  const handleUpload = async (file) => {

    if (!file) {
      alert('Please select an audio file');
      return;
    }

    setIsUploading(true); 
    const formData = new FormData();
    formData.append('audio', file);
    

    try {
      const response = await fetch('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json(); 

      if (!response.ok) {
        throw new Error('Failed to upload audio');
      }

      // A new file invalidates any previous editing state and playback
      // position - all of it refers to the file that was just replaced.
      // TranscriptEditor and WaveformEditor also remount (via `key`) once
      // `uploadedAudio` changes, which resets their own temporary
      // selection/toolbar state for free.
      playback.reset();
      setActiveSelection(null);
      setAutomaticRetakeSegments([]);
      setAutomaticSilenceSegments([]);
      setManualSegments([]);
      setRetakes([]);
      setHasDetectedRetakes(false);
      setSilences([]);
      setHasDetectedSilences(false);
      setUploadedAudio(data.file);
    } catch (err) {
      alert('Failed to upload audio');
      console.error(err);
    } finally {
      setIsUploading(false);
    }
  };

  // Detection-only, exactly like Remove Retakes: the backend never touches
  // the audio file, it only returns suggested silence time ranges. Those
  // ranges become ordinary `excludedSegments` (origin: "silence") that the
  // waveform immediately renders as excluded and live playback immediately
  // skips - there is no separate processed audio file or comparison player
  // anymore. A re-run only replaces this source's own previous suggestions.
  const handleRemoveSilences = async () => {
    if (!uploadedAudio) {
      alert('Please upload an audio file first');
      return;
    }

    setIsRemovingSilences(true);

    try {
      const response = await fetch('http://localhost:3000/api/remove-silences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          words: uploadedAudio.words,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to detect silences');
      }

      const detectedSilences = data.silences.map(({ start, end }) => ({
        id: `silence-${start}-${end}`,
        start,
        end,
        origin: 'silence',
      }));

      setSilences(data.silences);
      setAutomaticSilenceSegments(detectedSilences);
      setHasDetectedSilences(true);
    } catch (error) {
      console.error(error);
      alert('Failed to detect silences');
    } finally {
      setIsRemovingSilences(false);
    }
  };

  // Detection only replaces *previous automatic suggestions from this same
  // source*: manual transcript/waveform edits and the other detector's
  // suggestions are kept untouched across repeated detection runs, but a
  // stale retake from an older run never lingers once a fresh detection
  // replaces it.
  const handleRemoveRetakes = async () => {
    if (!uploadedAudio) {
      alert('Please upload an audio file first');
      return;
    }

    setIsDetectingRetakes(true);

    try {
      const response = await fetch(
        'http://localhost:3000/api/remove-retakes',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            words: uploadedAudio.words
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to detect retakes');
      }

      const detectedSegments = data.retakes.map((retake) => ({
        start: retake.start,
        end: retake.end,
        origin: 'retake',
      }));

      setRetakes(data.retakes);
      setAutomaticRetakeSegments(detectedSegments);
      setHasDetectedRetakes(true);
    } catch (error) {
      console.error(error);
      alert('Failed to detect retakes');
    } finally {
      setIsDetectingRetakes(false);
    }
  };

  // Purely local edits: selecting text/waveform and choosing an action never
  // triggers a backend call - only the final "Export Audio" does. A manual
  // exclude always lands in `manualSegments`, regardless of which detector
  // (if any) already covers part of that range.
  const handleExcludeRange = (range) => {
    setManualSegments((current) => excludeTimeRange(current, range, playback.sourceDuration));
  };

  // A restore/include has to work no matter *why* a range was excluded, so
  // it is applied to all three raw sources independently - each one trims
  // or splits only the parts it actually overlaps. This is what makes
  // automatically detected silences/retakes fully editable afterwards
  // instead of being special, immutable regions.
  const handleIncludeRange = (range) => {
    setAutomaticRetakeSegments((current) => includeTimeRange(current, range, playback.sourceDuration));
    setAutomaticSilenceSegments((current) => includeTimeRange(current, range, playback.sourceDuration));
    setManualSegments((current) => includeTimeRange(current, range, playback.sourceDuration));
  };

  // TranscriptEditor/WaveformEditor call these to report their own selection
  // (or `null` once it's gone) instead of owning the toolbar themselves;
  // tagging with `source` here is what lets the two Exclude/Restore actions
  // below know which raw editing operation and origin to use.
  const handleTranscriptSelectionChange = (selection) => {
    setActiveSelection(selection ? { ...selection, source: 'transcript' } : null);
  };

  const handleWaveformSelectionChange = (selection) => {
    setActiveSelection(selection ? { ...selection, source: 'waveform' } : null);
  };

  const closeActiveSelection = () => setActiveSelection(null);

  const handleSelectionExclude = () => {
    if (!selectionForToolbar) return;
    handleExcludeRange({
      start: selectionForToolbar.start,
      end: selectionForToolbar.end,
      origin: selectionForToolbar.source === 'waveform' ? 'waveform' : 'transcript',
    });
    closeActiveSelection();
  };

  const handleSelectionInclude = () => {
    if (!selectionForToolbar) return;
    handleIncludeRange({ start: selectionForToolbar.start, end: selectionForToolbar.end });
    closeActiveSelection();
  };

  const handleExportAudio = async () => {
    if (!uploadedAudio) {
      alert('Please upload an audio file first');
      return;
    }

    setIsExporting(true);

    try {
      const response = await fetch(
        'http://localhost:3000/api/export-audio',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            path: uploadedAudio.path,
            excludedSegments: excludedSegments.map(({ start, end }) => ({ start, end }))
          })
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => null);

        throw new Error(
          error?.error || 'Failed to export audio'
        );
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');

      anchor.href = downloadUrl;
      anchor.download = 'clean-take.mp3';

      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      console.error(error);
      alert('Failed to export audio');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="App">
      <header>
        <h1>Clean Take AI</h1>  
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => {
            handleUpload(e.target.files[0]);
          }}
        />
        {isUploading && <p>Uploading...</p>}
      </header>
      {/* The audio element is the single authoritative playback surface for
          both WaveSurfer and every custom control; it is never shown with
          native browser controls, and there is never a second one. */}
      <audio ref={audioRef} src={uploadedAudio?.url} preload="metadata" />
      <div className="editor-layout">
        <main className="transcript-panel">
          {uploadedAudio && (
            <>
              <h2>Transcript</h2>
              {hasDetectedRetakes && (
                <p className="detection-summary">
                  {retakes.length} retake{retakes.length === 1 ? '' : 's'} detected
                </p>
              )}
              {hasDetectedSilences && (
                <p className="detection-summary">
                  {silences.length} silence{silences.length === 1 ? '' : 's'} detected
                </p>
              )}
              <p className="transcript-hint">Select any words to remove or restore them.</p>
              <TranscriptEditor
                key={uploadedAudio.url}
                words={uploadedAudio.words}
                excludedSegments={excludedSegments}
                activeWordIndex={playback.activeWordIndex}
                isPlaying={playback.isPlaying}
                activeSelection={activeSelection}
                onSelectionChange={handleTranscriptSelectionChange}
                onSeek={playback.seekToSourceTime}
              />
            </>
          )}
        </main>
        <aside className="controls">
          <button className="secondary" onClick={handleRemoveSilences} disabled={!uploadedAudio || isRemovingSilences}>
            {isRemovingSilences
              ? 'Detecting Silences...'
              : hasDetectedSilences
              ? 'Re-run Remove Silences'
              : 'Remove Silences'}
          </button>
          <button
            className="secondary"
            onClick={handleRemoveRetakes}
            disabled={!uploadedAudio || isDetectingRetakes}
          >
            {isDetectingRetakes
              ? 'Detecting Retakes...'
              : hasDetectedRetakes
              ? 'Re-run Remove Retakes'
              : 'Remove Retakes'}
          </button>
          <button className="cta" onClick={handleExportAudio} disabled={!uploadedAudio || isExporting}>
            {isExporting ? 'Exporting...' : 'Export Audio'}
          </button>
        </aside>
      </div>
      {uploadedAudio && (
        <section className="waveform-section">
          <WaveformEditor
            key={uploadedAudio.url}
            audioRef={audioRef}
            url={uploadedAudio.url}
            excludedSegments={excludedSegments}
            activeSelection={activeSelection}
            onSelectionChange={handleWaveformSelectionChange}
            onSeek={playback.seekToSourceTime}
            isPlaying={playback.isPlaying}
            currentEditedTime={playback.currentEditedTime}
            editedDuration={playback.editedDuration}
            currentSourceTime={playback.currentSourceTime}
            sourceDuration={playback.sourceDuration}
            onTogglePlayback={playback.togglePlayback}
            seekToStart={playback.seekToStart}
            seekBy={playback.seekBy}
            seekToEnd={playback.seekToEnd}
            disabled={!uploadedAudio}
          />
        </section>
      )}
      {/* The one and only SelectionToolbar in the app: whichever editor last
          reported a selection (see activeSelection above) owns it, so a
          transcript selection and a waveform selection can never both show
          their own Remove/Restore actions at the same time. */}
      <SelectionToolbar
        selection={selectionForToolbar}
        onExclude={handleSelectionExclude}
        onInclude={handleSelectionInclude}
      />
  </div>
);
}

export default App;
