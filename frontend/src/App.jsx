import { useState, useRef, useEffect } from 'react';
import './index.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5000';

function formatSize(bytes, approx) {
  if (!bytes) return 'size unavailable';
  const mb = bytes / (1024 * 1024);
  return approx ? `~${mb.toFixed(1)} MB` : `${mb.toFixed(1)} MB`;
}

const trackStyle = {
  width: '100%',
  height: '10px',
  borderRadius: '999px',
  background: 'rgba(128, 128, 128, 0.25)',
  overflow: 'hidden'
};

function App() {
  const [url, setUrl] = useState('');
  const [videoInfo, setVideoInfo] = useState(null);
  const [selectedFormat, setSelectedFormat] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [downloadId, setDownloadId] = useState(null);
  const [progress, setProgress] = useState({ status: 'idle', percent: 0, speed: '', eta: '' });

  const sourceRef = useRef(null);

  const isBusy = progress.status === 'starting' || progress.status === 'downloading' || progress.status === 'processing';

  const closeStream = () => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  };

  useEffect(() => closeStream, []);

  const fetchInfo = async () => {
    if (!url.trim() || isBusy) return;
    setLoading(true);
    setError('');
    setVideoInfo(null);
    setProgress({ status: 'idle', percent: 0, speed: '', eta: '' });

    try {
      const res = await fetch(`${API_BASE}/api/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
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

  const watchProgress = (id) => {
    closeStream();
    const source = new EventSource(`${API_BASE}/api/download/${id}/progress`);
    sourceRef.current = source;

    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setProgress({
        status: data.status,
        percent: data.percent || 0,
        speed: data.speed || '',
        eta: data.eta || ''
      });

      if (data.status === 'done') {
        closeStream();
        window.location.href = `${API_BASE}/api/download/${id}/file`;
      }

      if (data.status === 'error') {
        closeStream();
        setError(data.error || 'Download failed');
      }
    };

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        closeStream();
      }
    };
  };

  const download = async () => {
    if (!selectedFormat || isBusy) return;
    const chosen = videoInfo?.formats?.find((f) => f.format_id === selectedFormat);

    setError('');
    setProgress({ status: 'starting', percent: 0, speed: '', eta: '' });

    try {
      const res = await fetch(`${API_BASE}/api/download/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          format_id: selectedFormat,
          has_audio: !!chosen?.hasAudio,
          title: videoInfo?.title || 'video'
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not start the download');
      }

      const { id } = await res.json();
      setDownloadId(id);
      watchProgress(id);
    } catch (err) {
      setProgress({ status: 'idle', percent: 0, speed: '', eta: '' });
      setError(err.message || 'Something went wrong');
    }
  };

  const cancel = async () => {
    closeStream();
    const id = downloadId;
    setProgress({ status: 'idle', percent: 0, speed: '', eta: '' });
    setDownloadId(null);
    if (id) {
      await fetch(`${API_BASE}/api/download/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  };

  const statusLabel = () => {
    if (progress.status === 'starting') return 'Starting...';
    if (progress.status === 'processing') return 'Finalizing file...';
    if (progress.status === 'done') return 'Complete. Your file is downloading.';
    return `${progress.percent.toFixed(1)}%`;
  };

  const showProgress = progress.status !== 'idle' && progress.status !== 'error';

  return (
    <div className="page">
      <div className="card">
        <h1>Video Downloader</h1>
        <p className="subtitle">Paste a video link to get started</p>

        <div className="input-row">
          <input
            type="text"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchInfo()}
          />
          <button onClick={fetchInfo} disabled={loading || isBusy}>
            {loading ? 'Fetching...' : 'Fetch'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {videoInfo && (
          <div className="result">
            {videoInfo.thumbnail && <img src={videoInfo.thumbnail} alt="thumbnail" />}
            <h2>{videoInfo.title}</h2>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: '10px',
                marginTop: '12px'
              }}
            >
              {videoInfo.formats?.map((f) => {
                const active = f.format_id === selectedFormat;
                return (
                  <button
                    key={f.format_id}
                    type="button"
                    onClick={() => setSelectedFormat(f.format_id)}
                    disabled={isBusy}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '10px 8px',
                      borderRadius: '10px',
                      border: active ? '2px solid #6c63ff' : '2px solid transparent',
                      background: active ? 'rgba(108, 99, 255, 0.25)' : 'rgba(128, 128, 128, 0.15)',
                      color: 'inherit',
                      cursor: isBusy ? 'not-allowed' : 'pointer'
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{f.label}</span>
                    <span style={{ fontSize: '13px', opacity: 0.8 }}>{formatSize(f.filesize, f.approx)}</span>
                  </button>
                );
              })}
            </div>

            <button onClick={download} disabled={isBusy || !selectedFormat} style={{ marginTop: '14px', width: '100%' }}>
              {isBusy
                ? 'Downloading...'
                : `Download ${videoInfo.formats?.find((f) => f.format_id === selectedFormat)?.label || ''}`}
            </button>

            {showProgress && (
              <div style={{ marginTop: '16px' }}>
                <div
                  style={trackStyle}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress.percent)}
                >
                  <div
                    style={{
                      width: `${progress.percent}%`,
                      height: '100%',
                      borderRadius: '999px',
                      background: '#4f8cff',
                      transition: 'width 0.3s ease'
                    }}
                  />
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '12px',
                    marginTop: '8px',
                    fontSize: '14px'
                  }}
                >
                  <span>{statusLabel()}</span>
                  <span>
                    {progress.speed}
                    {progress.speed && progress.eta ? ' · ' : ''}
                    {progress.eta ? `ETA ${progress.eta}` : ''}
                  </span>
                </div>
                {isBusy && (
                  <button onClick={cancel} style={{ marginTop: '12px' }}>
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;