# Video Downloader — Frontend

React (Vite) app for pasting a video URL, picking a resolution, and downloading.

## Local setup

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Runs on `http://localhost:5173` by default. Make sure `VITE_API_BASE` in `.env` points at your backend (`http://localhost:5000` for local dev).

## Deploying to Vercel

1. Push this `frontend` folder to a GitHub repo (or subfolder — set Vercel's root directory accordingly).
2. Import the repo into Vercel.
3. Framework preset: **Vite**.
4. Add an environment variable in Vercel's project settings:
   - `VITE_API_BASE` = your deployed Render backend URL (e.g. `https://your-app.onrender.com`)
5. Deploy.
