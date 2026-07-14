import { useMemo, useRef, useState } from 'react'
import TranscriptEditor from './TranscriptEditor.jsx'
import { useEditedAudioPreview } from './useEditedAudioPreview.js'
import { excludeWordRange, includeWordRange, mergeWordRanges } from './utils/wordRanges.js'

function App() {

  const [uploadedAudio, setUploadedAudio] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [processedAudio, setProcessedAudio] = useState(null);
  const [isRemovingSilences, setIsRemovingSilences] = useState(false);

  // The authoritative editing state: every excluded word range, regardless of
  // whether it came from automatic retake detection or a manual selection.
  const [excludedWordRanges, setExcludedWordRanges] = useState([]);

  // `retakes` is kept only as metadata (e.g. to show "N retakes detected");
  // it no longer drives the transcript, preview or export.
  const [retakes, setRetakes] = useState([]);
  const [isDetectingRetakes, setIsDetectingRetakes] = useState(false);
  const [hasDetectedRetakes, setHasDetectedRetakes] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const previewAudioRef = useRef(null);

  // Converts the word-index based editing state into the time ranges the
  // audio preview/export actually need, merging anything that ends up
  // touching or overlapping once translated to timestamps.
  const excludedTimeSegments = useMemo(() => {
    if (!uploadedAudio) return [];

    const segments = excludedWordRanges
      .map((range) => {
        const firstWord = uploadedAudio.words[range.startWordIndex];
        const lastWord = uploadedAudio.words[range.endWordIndex];
        if (!firstWord || !lastWord) return null;
        return { start: firstWord.start, end: lastWord.end };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      if (previous && segment.start <= previous.end) {
        previous.end = Math.max(previous.end, segment.end);
      } else {
        merged.push({ ...segment });
      }
    }
    return merged;
  }, [excludedWordRanges, uploadedAudio]);

  useEditedAudioPreview(previewAudioRef, excludedTimeSegments);

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

      setUploadedAudio(data.file);
      // A new file invalidates any previous editing state and comparison
      // audio - both refer to the file that was just replaced.
      setExcludedWordRanges([]);
      setRetakes([]);
      setHasDetectedRetakes(false);
      setProcessedAudio(null);
    } catch (err) {
      alert('Failed to upload audio');
      console.error(err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveSilences = async () => {
    if (!uploadedAudio) {
      alert('Please upload an audio file first');
      return;
    }

    setIsRemovingSilences(true);
    try {
      const response = await fetch('http://localhost:3000/api/remove-silences', {
        method: 'POST',
        body: JSON.stringify({
          path: uploadedAudio.path,
          words: uploadedAudio.words
        }),
        headers: { 'Content-Type': 'application/json' }
      })

      const data = await response.json();

      if (!response.ok) {
        throw new Error('Failed to remove silences');
      }

      setProcessedAudio(data);
    } catch (error) {
      alert('Failed to remove silences');
      console.error(error)
    } finally {
      setIsRemovingSilences(false);
    }
  }

  // Detection only initializes exclusions; it never overwrites ranges the
  // user already edited manually - detected ranges are merged in instead.
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

      const detectedRanges = data.retakes.map((retake) => ({
        startWordIndex: retake.startWordIndex,
        endWordIndex: retake.endWordIndex,
      }));

      setRetakes(data.retakes);
      setExcludedWordRanges((current) => mergeWordRanges([...current, ...detectedRanges]));
      setHasDetectedRetakes(true);
    } catch (error) {
      console.error(error);
      alert('Failed to detect retakes');
    } finally {
      setIsDetectingRetakes(false);
    }
  };

  // Purely local edits: selecting text and choosing an action in the
  // transcript never triggers a backend call.
  const handleExcludeWordRange = (range) => {
    setExcludedWordRanges((current) => excludeWordRange(current, range));
  };

  const handleIncludeWordRange = (range) => {
    setExcludedWordRanges((current) => includeWordRange(current, range));
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
            excludedSegments: excludedTimeSegments
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
      <aside className="controls">
        <button onClick={handleRemoveSilences} disabled={!uploadedAudio || isRemovingSilences}>
          {isRemovingSilences ? 'Removing Silences...' : 'Remove Silences'}
        </button>
        <button
          onClick={handleRemoveRetakes}
          disabled={!uploadedAudio || isDetectingRetakes || hasDetectedRetakes}
        >
          {isDetectingRetakes
            ? 'Detecting Retakes...'
            : hasDetectedRetakes
            ? 'Retakes Detected'
            : 'Remove Retakes'}
        </button>
        <button className="cta" onClick={handleExportAudio} disabled={!uploadedAudio || isExporting}>
          {isExporting ? 'Exporting...' : 'Export Audio'}
        </button>
      </aside>
      <main> { uploadedAudio && ( <>
        <audio ref={previewAudioRef} src={uploadedAudio.url} controls />
        <h2>Transcript</h2>
        {hasDetectedRetakes && (
          <p className="retake-summary">
            {retakes.length} retake{retakes.length === 1 ? '' : 's'} detected
          </p>
        )}
        <p className="transcript-hint">Select any words to remove or restore them.</p>
        <TranscriptEditor
          key={uploadedAudio.url}
          words={uploadedAudio.words}
          excludedWordRanges={excludedWordRanges}
          onExcludeRange={handleExcludeWordRange}
          onIncludeRange={handleIncludeWordRange}
        />
      </>)}
      </main>
      {processedAudio && (
        <section className="editor">
          <h2>Compare</h2>
          <div className="audio-compare">
            <div className="audio-compare-item">
              <h3>Before</h3>
              <audio src={uploadedAudio.url} controls />
            </div>
            <div className="audio-compare-item">
              <h3>Silences Removed</h3>
              <audio src={processedAudio.url} controls />
            </div>
          </div>
        </section>
      )}
  </div>
);
}

export default App;
