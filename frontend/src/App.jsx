import { useState } from 'react';
import './index.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5000';

function formatSize(bytes, approx) {
  if (!bytes) return 'size unavailable';
  const mb = bytes / (1024 * 1024);
  return approx ? `~${mb.toFixed(1)} MB` : `${mb.toFixed(1)} MB`;
}

function App() {
  const [url, setUrl] = useState('');
  const [videoInfo, setVideoInfo] = useState(null);
  const [selectedFormat, setSelectedFormat] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchInfo = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    setVideoInfo(null);

    try {
      const res = await fetch(`${API_BASE}/api/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch video info');
      }

      const data = await res.json();
      setVideoInfo(data);
      setSelectedFormat(data.formats?.[0]?.format_id || '');
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!selectedFormat) return;
    const chosen = videoInfo?.formats?.find((f) => f.format_id === selectedFormat);
    const hasAudio = chosen?.hasAudio ? 'true' : 'false';
    const link = `${API_BASE}/api/download?url=${encodeURIComponent(url)}&format_id=${selectedFormat}&has_audio=${hasAudio}&title=${encodeURIComponent(videoInfo?.title || 'video')}`;
    window.location.href = link;
  };

  return (
    <div className="page">
      <div className="card">
        <h1>Video Downloader</h1>
        <p className="subtitle">Paste a YouTube or Facebook link to get started</p>

        <div className="input-row">
          <input
            type="text"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchInfo()}
          />
          <button onClick={fetchInfo} disabled={loading}>
            {loading ? 'Fetching...' : 'Fetch'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {videoInfo && (
          <div className="result">
            {videoInfo.thumbnail && <img src={videoInfo.thumbnail} alt="thumbnail" />}
            <h2>{videoInfo.title}</h2>

            <div className="format-row">
              <select value={selectedFormat} onChange={(e) => setSelectedFormat(e.target.value)}>
                {videoInfo.formats?.map((f) => (
                  <option key={f.format_id} value={f.format_id}>
                    {f.resolution} ({f.ext}) — {formatSize(f.filesize, f.approx)}
                  </option>
                ))}
              </select>
              <button onClick={download}>Download</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
