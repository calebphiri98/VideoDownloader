const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 5000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_ACTIVE_JOBS = Math.max(1, Number(process.env.MAX_ACTIVE_JOBS) || 1);
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'video-downloader');
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const JOB_TTL_MS = 30 * 60 * 1000;

const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || '';
const YTDLP_JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || 'deno';

function extractorArgs() {
  const args = ['--js-runtimes', YTDLP_JS_RUNTIME];

  if (EXTRACTOR_ARGS) {
    args.push('--extractor-args', EXTRACTOR_ARGS);
  }

  return args;
}

const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION || '';

let ffmpegReady = null;

function ffmpegBinary() {
  if (!FFMPEG_LOCATION) return 'ffmpeg';
  return /\.exe$/i.test(FFMPEG_LOCATION) ? FFMPEG_LOCATION : path.join(FFMPEG_LOCATION, 'ffmpeg');
}

function checkFfmpeg() {
  return new Promise((resolve) => {
    execFile(ffmpegBinary(), ['-version'], { timeout: 10000 }, (err) => resolve(!err));
  });
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',') }));
app.use(express.json({ limit: '10kb' }));


app.get('/api/diagnostics/ytdlp', async (req, res) => {
  function checkVersion(command, args = []) {
    return new Promise((resolve) => {
      execFile(command, args, { timeout: 10000 }, (err, stdout) => {
        resolve({
          available: !err,
          version: err ? null : stdout.trim(),
          error: err ? err.message : null
        });
      });
    });
  }

  const [ytDlp, deno, ffmpeg] = await Promise.all([
    checkVersion('yt-dlp', ['--version']),
    checkVersion('deno', ['--version']),
    checkVersion(ffmpegBinary(), ['-version'])
  ]);

  res.json({
    success: ytDlp.available,
    ytDlpVersion: ytDlp.version,
    denoAvailable: deno.available,
    denoVersion: deno.version,
    ffmpegAvailable: ffmpeg.available,
    errors: {
      ytDlp: ytDlp.error,
      deno: deno.error,
      ffmpeg: ffmpeg.error
    }
  });
});


app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const hits = new Map();

function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${name}`;
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (now > entry.reset) hits.delete(key);
  }
}, 60 * 1000).unref();

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host.startsWith('[')) return true;
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

function validateUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (isPrivateHost(parsed.hostname.toLowerCase())) return null;
  return parsed.href;
}

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'video';
  return (
    name
      .replace(/[\r\n]+/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '')
      .trim()
      .slice(0, 80) || 'video'
  );
}

function asciiSafeName(name) {
  const stripped = name.replace(/[^\x20-\x7E]/g, '').replace(/"/g, '').trim();
  return stripped || 'video';
}

app.get('/', (req, res) => {
  res.send('Video downloader backend is running.');
});


function describeFailure(stderr, fallback) {
  const text = String(stderr || '');

  if (/HTTP Error 429|too many requests/i.test(text)) {
    return 'The video source is temporarily rate-limiting requests. Please wait before trying again.';
  }

  if (/HTTP Error 403|forbidden/i.test(text)) {
    return 'The video source refused the request. The URL may require different access permissions or may be blocked from this server.';
  }

  if (/private video|this video is private|login required|sign in to confirm/i.test(text)) {
    return 'This video may be private or require sign-in. Only publicly accessible videos can be processed.';
  }

  if (/unsupported URL/i.test(text)) {
    return 'This URL is not supported by the current video extractor.';
  }

  if (/ffmpeg/i.test(text) && /not found|not installed/i.test(text)) {
    return 'FFmpeg is not installed on the server, so video and audio cannot be combined.';
  }

  return fallback;
}


function sizeOf(f, duration) {
  if (f.filesize) return { bytes: f.filesize, approx: false };
  if (f.filesize_approx) return { bytes: f.filesize_approx, approx: true };
  if (f.tbr && duration) return { bytes: Math.round((f.tbr * 1000 * duration) / 8), approx: true };
  return { bytes: null, approx: false };
}

function pickAudio(formats) {
  const audios = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  if (audios.length === 0) return null;
  audios.sort((a, b) => {
    const aM4a = a.ext === 'm4a' ? 1 : 0;
    const bM4a = b.ext === 'm4a' ? 1 : 0;
    if (aM4a !== bM4a) return bM4a - aM4a;
    return (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
  });
  return audios[0];
}

const TARGET_QUALITIES = [360, 480, 720, 1080];

function qualityOf(f) {
  if (!f.height) return 0;
  return f.width ? Math.min(f.width, f.height) : f.height;
}

function preferenceScore(f) {
  const direct = /^https?$/i.test(f.protocol || '') ? 1 : 0;
  const compatible = f.ext === 'mp4' && /^(avc|h264)/i.test(f.vcodec || '') ? 1 : 0;
  return direct * 1e10 + compatible * 1e9 + (f.tbr || 0);
}

function buildOptions(data) {
  const all = data.formats || [];
  const audio = pickAudio(all);
  const audioSize = audio ? sizeOf(audio, data.duration) : { bytes: null, approx: false };
  const videos = all.filter((f) => {
    if (/premium/i.test(f.format_note || '')) return false;
    if (f.vcodec === 'none') return false;
    if (f.vcodec) return true;
    return f.ext === 'mp4' && /^https?$/i.test(f.protocol || '');
  });

  const group = (list) => {
    const groups = new Map();
    for (const f of list) {
      const key = f.height ? String(qualityOf(f)) : `id-${f.format_id}`;
      const current = groups.get(key);
      if (!current || preferenceScore(f) > preferenceScore(current)) groups.set(key, f);
    }
    return groups;
  };

  let groups = group(videos.filter((f) => TARGET_QUALITIES.includes(qualityOf(f))));
  if (groups.size === 0) groups = group(videos);

  return [...groups.values()]
    .map((f) => {
      const hasAudio = (!!f.acodec && f.acodec !== 'none') ||
        (!f.acodec && !f.vcodec && f.ext === 'mp4' && /^https?$/i.test(f.protocol || ''));
      const video = sizeOf(f, data.duration);
      let bytes = video.bytes;
      let approx = video.approx;

      if (!hasAudio && audio && bytes !== null) {
        bytes += audioSize.bytes || 0;
        approx = approx || audioSize.approx || audioSize.bytes === null;
      }

      const fps = f.fps && f.fps > 30 ? Math.round(f.fps) : '';
      const quality = qualityOf(f);
      const label = quality ? `${quality}p${fps}` : f.format_note || f.resolution || 'Best available';

      return {
        format_id: f.format_id,
        label,
        height: quality,
        ext: f.ext,
        filesize: bytes,
        approx,
        hasAudio
      };
    })
    .sort((a, b) => b.height - a.height);
}

const YOUTUBE_COOLDOWN_MS = 15 * 60 * 1000;
let youtubeCooldownUntil = 0;

function isYouTubeSource(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function isYouTubeThrottle(message) {
  return /HTTP Error 429|too many requests|sign in to confirm you.re not a bot/i.test(String(message || ''));
}

function youtubeCooldownActive(url) {
  return isYouTubeSource(url) && Date.now() < youtubeCooldownUntil;
}

function recordYouTubeThrottle(url, message) {
  if (!isYouTubeSource(url) || !isYouTubeThrottle(message)) return false;
  youtubeCooldownUntil = Math.max(youtubeCooldownUntil, Date.now() + YOUTUBE_COOLDOWN_MS);
  console.warn('YouTube cooldown activated until:', new Date(youtubeCooldownUntil).toISOString());
  return true;
}

function sendYouTubeCooldown(res) {
  const seconds = Math.max(1, Math.ceil((youtubeCooldownUntil - Date.now()) / 1000));
  res.setHeader('Retry-After', String(seconds));
  return res.status(429).json({
    error: 'YouTube is temporarily restricting requests from this server. Please try again later.',
    retryAfterSeconds: seconds
  });
}
app.post('/api/info', rateLimit('info', 20, 60 * 1000), (req, res) => {
  const url = validateUrl(req.body && req.body.url);
  if (!url) {
    return res.status(400).json({ error: 'Please provide a valid public http or https link.' });
  }

  if (youtubeCooldownActive(url)) return sendYouTubeCooldown(res);

const args = [...extractorArgs(), '--no-playlist', '--dump-json', '--', url];

  execFile('yt-dlp', args, { maxBuffer: 1024 * 1024 * 10, timeout: 60 * 1000 }, (err, stdout, stderr) => {
  if (err) {
  console.error('yt-dlp info error:', stderr || err.message);
    if (recordYouTubeThrottle(url, stderr || err.message)) {
      return sendYouTubeCooldown(res);
    }

  return res.status(422).json({
    error: describeFailure(
      stderr || err.message,
      'Could not fetch video information. This link may be unsupported, unavailable, or blocked by the source.'
    )
  });
}

    try {
      const data = JSON.parse(stdout);

      const formats = buildOptions(data);

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

const jobs = new Map();

function snapshot(job) {
  return {
    status: job.status,
    percent: Math.round(job.percent * 10) / 10,
    speed: job.speed,
    eta: job.eta,
    error: job.error
  };
}

function isFinished(job) {
  return job.status === 'done' || job.status === 'error';
}

function publish(job) {
  const payload = `data: ${JSON.stringify(snapshot(job))}\n\n`;
  for (const client of job.clients) {
    client.write(payload);
    if (isFinished(job)) client.end();
  }
  if (isFinished(job)) job.clients.clear();
}

function removeJobFiles(id) {
  if (!UUID_PATTERN.test(id)) return;
  try {
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      if (file.startsWith(`${id}.`)) {
        try {
          fs.rmSync(path.join(DOWNLOAD_DIR, file), { force: true });
        } catch (err) {
          console.error('File cleanup failed:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('Temporary directory error:', err.message);
  }
}

function temporaryFileSize(id) {
  let total = 0;
  try {
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      if (file.startsWith(`${id}.`)) {
        const stat = fs.statSync(path.join(DOWNLOAD_DIR, file));
        if (stat.isFile()) total += stat.size;
      }
    }
  } catch {}
  return total;
}
function failJob(job, message) {
  job.status = 'error';
  job.error = message;
  removeJobFiles(job.id);
  publish(job);
}

function runJob(job, url, formatId, hasAudio) {
  const selector = hasAudio
    ? `${formatId}/best`
    : `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/${formatId}/best`;
  const outputTemplate = path.join(DOWNLOAD_DIR, `${job.id}.%(ext)s`);

  const args = [
    ...extractorArgs(),
    ...(FFMPEG_LOCATION ? ['--ffmpeg-location', FFMPEG_LOCATION] : []),
    '-f',
    selector,
    '--merge-output-format',
    'mp4',
    '--concurrent-fragments',
    '8',
    '--no-warnings',
    '--no-playlist',
    '--newline',
    '--progress-template',
    'download:PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o',
    outputTemplate,
    '--',
    url
  ];

  const child = spawn('yt-dlp', args);
  job.child = child;
  job.limitExceeded = false;

  const sizeMonitor = setInterval(() => {
    if (!job.limitExceeded && temporaryFileSize(job.id) > MAX_DOWNLOAD_BYTES) {
      job.limitExceeded = true;
      console.error(`Download exceeded storage limit: ${job.id}`);
      child.kill('SIGKILL');
    }
  }, 2000);

  sizeMonitor.unref();
  child.once('close', () => clearInterval(sizeMonitor));
  child.once('error', () => clearInterval(sizeMonitor));

  let buffer = '';
  let stderr = '';

  const handleLine = (line) => {
    if (line.startsWith('PROGRESS|')) {
      const parts = line.split('|');
      const raw = parseFloat(parts[1]);
      if (Number.isNaN(raw)) return;
      if (raw + 1 < job.lastRaw) {
        job.stage = Math.min(job.stage + 1, job.totalStages - 1);
      }
      job.lastRaw = raw;
      const overall = ((job.stage + raw / 100) / job.totalStages) * 100;
      job.status = 'downloading';
      job.percent = Math.max(job.percent, Math.min(overall, 99));
      job.speed = (parts[2] || '').trim();
      job.eta = (parts[3] || '').trim();
      publish(job);
    } else if (/^\[(Merger|VideoRemuxer|ffmpeg)\]/.test(line)) {
      job.status = 'processing';
      job.percent = 99;
      job.speed = '';
      job.eta = '';
      publish(job);
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(handleLine);
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  child.on('error', (err) => {
    console.error('yt-dlp spawn error:', err);
    failJob(job, 'The download engine could not be started.');
  });

  child.on('close', (code) => {
    if (job.cancelled || isFinished(job)) return;

    if (code !== 0) {
      if (job.limitExceeded) {
        failJob(job, 'The download exceeds the 500 MB storage limit.');
        return;
      }
      console.error('yt-dlp download error:', stderr);
      if (recordYouTubeThrottle(url, stderr)) {
        failJob(job, 'YouTube is temporarily restricting requests from this server. Please try again later.');
        return;
      }
      failJob(job, describeFailure(stderr, 'Download failed. The link may be unavailable or unsupported.'));
      return;
    }

    const produced = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(`${job.id}.`) && !f.endsWith('.part'));
    const merged = produced.filter((f) => !/\.f[\w-]+\.[a-z0-9]+$/i.test(f));
    const file = merged.find((f) => f.endsWith('.mp4')) || merged[0];
    if (!file) {
      failJob(
        job,
        produced.length > 0
          ? 'Video and audio could not be combined. Make sure ffmpeg is installed on the server.'
          : 'Download completed but the file could not be found.'
      );
      return;
    }

    job.filePath = path.join(DOWNLOAD_DIR, file);
if (fs.statSync(job.filePath).size > MAX_DOWNLOAD_BYTES) {
  failJob(job, 'The downloaded file exceeds the maximum allowed size.');
  return;
}
    job.status = 'done';
    job.percent = 100;
    job.speed = '';
    job.eta = '';
    publish(job);
  });
}

app.post('/api/download/start', rateLimit('start', 10, 60 * 1000), (req, res) => {
  const body = req.body || {};
  const url = validateUrl(body.url);
  if (!url) {
    return res.status(400).json({ error: 'Please provide a valid public http or https link.' });
  }

  if (youtubeCooldownActive(url)) return sendYouTubeCooldown(res);

const formatId = body.format_id;
  if (typeof formatId !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(formatId)) {
    return res.status(400).json({ error: 'Invalid format selected.' });
  }

  if (ffmpegReady === false) {
    return res
      .status(503)
      .json({ error: 'ffmpeg is not installed on the server, so video and audio cannot be combined.' });
  }

  const active = [...jobs.values()].filter((j) => j.status === 'downloading' || j.status === 'processing').length;
  if (active >= MAX_ACTIVE_JOBS) {
    return res.status(503).json({ error: 'The server is busy with other downloads. Please try again shortly.' });
  }

  const hasAudio = body.has_audio === true || body.has_audio === 'true';
  const id = crypto.randomUUID();

  const job = {
    id,
    status: 'downloading',
    percent: 0,
    speed: '',
    eta: '',
    error: null,
    title: sanitizeFilename(body.title),
    filePath: null,
    clients: new Set(),
    stage: 0,
    lastRaw: 0,
    totalStages: hasAudio ? 1 : 2,
    cancelled: false,
    child: null,
    createdAt: Date.now(),
    transferring: false
  };

  jobs.set(id, job);
  runJob(job, url, formatId, hasAudio);
  res.status(202).json({ id });
});

app.get('/api/download/:id/progress', (req, res) => {
  const job = UUID_PATTERN.test(req.params.id) ? jobs.get(req.params.id) : null;
  if (!job) return res.status(404).json({ error: 'Download not found.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(snapshot(job))}\n\n`);

  if (isFinished(job)) return res.end();

  job.clients.add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.clients.delete(res);
  });
});

app.get('/api/download/:id/file', (req, res) => {
  const job = UUID_PATTERN.test(req.params.id) ? jobs.get(req.params.id) : null;

  if (!job || job.status !== 'done' || !job.filePath) {
    return res.status(404).json({ error: 'File not available.' });
  }

  if (job.transferring) {
    return res.status(409).json({ error: 'File transfer already in progress.' });
  }

  let stat;

  try {
    stat = fs.statSync(job.filePath);
  } catch {
    jobs.delete(job.id);
    return res.status(404).json({ error: 'File not available.' });
  }

  if (stat.size > MAX_DOWNLOAD_BYTES) {
    removeJobFiles(job.id);
    jobs.delete(job.id);
    return res.status(413).json({ error: 'File exceeds the allowed size.' });
  }

  const ext = path.extname(job.filePath).slice(1).toLowerCase() || 'mp4';
  const asciiName = asciiSafeName(job.title);
  const encodedName = encodeURIComponent(`${job.title}.${ext}`);

  const contentTypes = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    opus: 'audio/ogg'
  };

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}.${ext}"; filename*=UTF-8''${encodedName}`
  );

  res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-store');

  job.transferring = true;

  const readStream = fs.createReadStream(job.filePath);
  let completed = false;

  res.once('finish', () => {
    completed = true;
    job.transferring = false;
    removeJobFiles(job.id);
    jobs.delete(job.id);
    console.log(`Completed transfer and removed temporary files: ${job.id}`);
  });

  res.once('close', () => {
    if (!completed) {
      job.transferring = false;
      readStream.destroy();
      console.log(`Interrupted transfer retained for retry: ${job.id}`);
    }
  });

  readStream.once('error', (err) => {
    job.transferring = false;
    console.error('File streaming error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'File transfer failed.' });
    } else {
      res.destroy(err);
    }
  });

  readStream.pipe(res);
});
app.delete('/api/download/:id', (req, res) => {
  const job = UUID_PATTERN.test(req.params.id) ? jobs.get(req.params.id) : null;
  if (!job) return res.status(404).json({ error: 'Download not found.' });

  job.cancelled = true;
  if (job.child) job.child.kill('SIGKILL');
  for (const client of job.clients) client.end();
  job.clients.clear();
  removeJobFiles(job.id);
  jobs.delete(job.id);
  res.status(204).end();
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS && !job.transferring) {
      job.cancelled = true;
      if (job.child) job.child.kill('SIGKILL');
      for (const client of job.clients) client.end();
      removeJobFiles(id);
      jobs.delete(id);
    }
  }
}, 60 * 1000).unref();

function cleanupOrphanedFiles() {
  const now = Date.now();
  try {
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      const fullPath = path.join(DOWNLOAD_DIR, file);
      const stat = fs.statSync(fullPath);
      const id = file.split('.')[0];
      const job = jobs.get(id);
      if (job && (job.transferring || job.status === 'downloading' || job.status === 'processing')) continue;
      if (stat.isFile() && now - stat.mtimeMs > JOB_TTL_MS) {
        fs.rmSync(fullPath, { force: true });
      }
    }
  } catch (err) {
    console.error('Orphan cleanup error:', err.message);
  }
}

cleanupOrphanedFiles();
setInterval(cleanupOrphanedFiles, 60000).unref();
checkFfmpeg().then((ok) => {
  ffmpegReady = ok;
  if (!ok) {
    console.error('WARNING: ffmpeg was not found. Downloads that need merging video and audio will fail.');
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));






