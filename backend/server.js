const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// Health check (useful for Render)
app.get('/', (req, res) => {
  res.send('Video downloader backend is running.');
});

// Get available formats/resolutions for a video
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const command = `yt-dlp --dump-json "${url}"`;

  exec(command, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp info error:', stderr);
      return res.status(500).json({ error: 'Could not fetch video info. The link may be private, invalid, or unsupported.' });
    }

    try {
      const data = JSON.parse(stdout);

      const formats = (data.formats || [])
        .filter((f) => f.vcodec && f.vcodec !== 'none')
        .map((f) => {
          let filesize = f.filesize || f.filesize_approx || null;
          let approx = false;

          // Many formats (esp. Facebook, and YouTube DASH streams) don't report filesize at all.
          // Estimate it from bitrate * duration when we have enough info, instead of showing nothing.
          if (!filesize && f.tbr && data.duration) {
            filesize = Math.round((f.tbr * 1000 * data.duration) / 8);
            approx = true;
          }

          return {
            format_id: f.format_id,
            resolution: f.resolution || (f.height ? `${f.height}p` : 'unknown'),
            ext: f.ext,
            filesize,
            approx,
            hasAudio: !!f.acodec && f.acodec !== 'none'
          };
        });

      res.json({
        title: data.title,
        thumbnail: data.thumbnail,
        duration: data.duration,
        formats
      });
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

function sanitizeFilename(name) {
  if (!name) return 'video';
  return name
    .replace(/[\\/:*?"<>|]/g, '') // strip characters illegal in filenames
    .trim()
    .slice(0, 80) || 'video';
}

// Download to a temp file first (MP4 needs a seekable file to write its index),
// then stream the completed file to the client and clean up.
app.get('/api/download', (req, res) => {
  const { url, format_id, has_audio, title } = req.query;

  if (!url || !format_id) {
    return res.status(400).json({ error: 'url and format_id are required' });
  }

  // Chain fallbacks so a format that no longer resolves exactly (links/formats can shift
  // between fetching info and downloading) doesn't just fail outright.
  const formatSelector =
    has_audio === 'true'
      ? `${format_id}/best`
      : `${format_id}+bestaudio/${format_id}/best`;

  const tempDir = os.tmpdir();
  const tempId = crypto.randomUUID();
  const outputTemplate = path.join(tempDir, `${tempId}.%(ext)s`);

  // --concurrent-fragments speeds up downloads of fragmented (DASH/HLS) streams, common on YouTube.
  const command = `yt-dlp -f "${formatSelector}" --merge-output-format mp4 --concurrent-fragments 8 --no-warnings -o "${outputTemplate}" "${url}"`;

  exec(command, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp download error:', stderr);
      if (!res.headersSent) {
        const message = /private|login|sign in/i.test(stderr)
          ? 'This video appears to be private or requires login, so it cannot be downloaded.'
          : 'Download failed. The link may be unavailable or unsupported.';
        res.status(500).json({ error: message });
      }
      return;
    }

    const files = fs.readdirSync(tempDir).filter((f) => f.startsWith(tempId));
    if (files.length === 0) {
      return res.status(500).json({ error: 'Download completed but the file could not be found' });
    }

    const filePath = path.join(tempDir, files[0]);
    const ext = path.extname(filePath).slice(1) || 'mp4';
    const stat = fs.statSync(filePath);

    const safeName = sanitizeFilename(title);
    const encodedName = encodeURIComponent(`${safeName}.${ext}`);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}.${ext}"; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);

    const cleanup = () => fs.unlink(filePath, () => {});
    readStream.on('close', cleanup);
    readStream.on('error', cleanup);
    req.on('close', cleanup);
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
