# Video Downloader — Backend

Express API that uses `yt-dlp` to fetch video info and stream downloads.

## Requirements (must be installed on the server/machine)

- Node.js 18+
- Python 3 (needed by yt-dlp)
- `yt-dlp` — install with: `pip install yt-dlp` (or `pip3 install --break-system-packages yt-dlp` on newer systems)
- `ffmpeg` — needed to merge separate video/audio streams
  - Mac: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt-get install ffmpeg`
  - Windows: download from ffmpeg.org and add to PATH

## Local setup

```bash
cd backend
npm install
npm run dev
```

Server runs on `http://localhost:5000` by default.

## Endpoints

- `POST /api/info` — body: `{ "url": "..." }` → returns title, thumbnail, and available formats
- `GET /api/download?url=...&format_id=...` → streams the video file back

## Deploying to Render

1. Push this `backend` folder to its own GitHub repo (or a subfolder — set Render's root directory accordingly).
2. Create a new **Web Service** on Render, connect the repo.
3. The included `render.yaml` handles installing `yt-dlp` and `ffmpeg` during build. If you'd rather configure manually in the Render dashboard instead of using render.yaml:
   - Build Command: `apt-get update && apt-get install -y ffmpeg python3-pip && pip3 install --break-system-packages -U yt-dlp && npm install`
   - Start Command: `npm start`
4. Once deployed, copy your Render URL (e.g. `https://your-app.onrender.com`) — you'll need it in the frontend's `.env`.

## Notes

- Facebook links are less reliable than YouTube since Facebook changes its page structure often and actively blocks scraping — expect some failures there.
- This is for personal/practice use. Redistributing downloaded copyrighted content publicly can violate YouTube/Facebook's Terms of Service and copyright law.
