import { useState } from 'react'

function App() {

  const [uploadedAudio, setUploadedAudio] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

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
        <button>Remove Silences</button>
        <button>Remove Retakes</button>
        <button className="cta">Export Audio</button>
      </aside>
      <main> { uploadedAudio && ( <>
        {/* {uploadedAudio && (<audio src={uploadedAudio.url} controls />)} */}
        <h2>Transcript</h2>
        <p className="transcript">{uploadedAudio.transcript}</p>
      </>)}
      </main>
      
  </div>
);
}

export default App;
