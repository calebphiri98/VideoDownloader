# Video Downloader (Practice Project)

A simple web app: paste a YouTube or Facebook video link, pick a resolution, download it.

- `backend/` — Node/Express API that shells out to `yt-dlp` (deploy to Render)
- `frontend/` — React (Vite) UI (deploy to Vercel)

See the README inside each folder for setup and deployment steps.

## Quick start (local)

**Terminal 1 — backend:**
```bash
cd backend
npm install
npm run dev
```

**Terminal 2 — frontend:**
```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Then open `http://localhost:5173`, paste a video URL, and try it out.

## Before you deploy anywhere public

- Downloading and redistributing videos from YouTube/Facebook generally violates their Terms of Service and can raise copyright issues — treat this as a learning project, not something to publish widely or monetize.
- `yt-dlp` and `ffmpeg` must be installed wherever the backend runs (handled automatically on Render via `render.yaml`, but you need them locally too — see `backend/README.md`).
