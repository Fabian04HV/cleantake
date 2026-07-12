import { useState } from 'react'

function App() {

  const [uploadedAudio, setUploadedAudio] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [processedAudio, setProcessedAudio] = useState(null);
  const [isRemovingSilences, setIsRemovingSilences] = useState(false);

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

  const handleRemoveRetakes = async () => {
    
  }

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
        <button>Remove Retakes</button>
        <button className="cta">Export Audio</button>
      </aside>
      <main> { uploadedAudio && ( <>
        {/* {uploadedAudio && (<audio src={uploadedAudio.url} controls />)} */}
        <h2>Transcript</h2>
        <p className="transcript">{uploadedAudio.transcript}</p>
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
