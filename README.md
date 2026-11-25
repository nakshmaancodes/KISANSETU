# SETU AI — Environmental & Agricultural Intelligence

> **Live Production Deployment:** https://setu-ai-rouge.vercel.app  
> **Repository name:** `setu-ai`  
> **Description:** A unified AI ecosystem for agriculture (`KisanSetu`), urban air-quality & smog protection (`VayuSetu`), real-time weather/rain intelligence, persistent user memory, and scheduled background monitoring powered by **Google Gemini** and **TinyFish**.

---

## Architecture Overview

SETU AI connects two real-world modules under one shared intelligence core (`SETU AI CORE`):

- **🌾 KisanSetu (Farm Intelligence):** Smart field mapping (Leaflet + Esri/OSM + Turf.js), Soil Health Card OCR (Image & PDF), crop suitability advice, deterministic NPK fertilizer math (`DAP 18-46-0`, `Urea 46-0-0`, `MOP 0-0-60`), and crop disease visual analysis.
- **🌫️ VayuSetu (Air & Smog Intelligence):** Live Indian NAQI / PM2.5 / PM10 / NO₂ / Ozone retrieval (Open-Meteo Copernicus CAMS), household protection, indoor air guidance, cleaner commuting, and an **Environmental Impact Bridge** connecting meteorology, farming, and urban AQI.
- **🧠 SETU AI CORE:**
  - **Tool-Routing Streaming Chat (`/api/chat/stream`):** Gemini detects intent & language (`English` / `हिन्दी`), runs live Weather, AQI, or TinyFish `.gov.in` web retrieval on the server, streams live status steps + Markdown responses with real retrieved citations only.
  - **Full Bilingual Support (English & हिन्दी):** Full UI dictionary (`public/js/i18n.js`), `Noto Sans Devanagari` font, UTF-8 encoding, persistent language preference, Hindi Web Speech voice input/TTS, and strict Devanagari Hindi AI replies.
  - **Persistent Memory & Multi-Conversation History:** Stores shared profile, saved location, VayuSetu household context, KisanSetu fields/soil/crops, user-editable facts, and multi-conversation history (`services/storageService.js`).
  - **Automatic Scheduled Monitoring & Notifications:** Node interval scheduler (`services/monitoringService.js`) + Vercel Cron (`/api/cron/monitor` in `vercel.json`) with deduplicated alerts.

---

## Setup & Environment Variables

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure `.env`
Copy `.env.example` to `.env`:
```env
PORT=3000
GEMINI_API_KEY=your_gemini_api_key
TINYFISH_API_KEY=your_tinyfish_api_key
WEATHER_API_KEY=        # Optional: OpenWeatherMap key (uses Open-Meteo keyless API if omitted)
DATABASE_URL=           # Optional: PostgreSQL / Supabase connection URL
CRON_SECRET=            # Optional: Bearer token protecting /api/cron/monitor
NOMINATIM_USER_AGENT=SetuAI/4.0 (contact@example.com)
```
> **Security:** `.env` and `data/db.json` are excluded in `.gitignore`. Never commit secrets to GitHub.

### 3. Run Locally & Test
```bash
npm start
# In another terminal:
npm test
```
Open **http://localhost:3000**.

---

## Feature Implementation Status

| Feature | Status | Notes |
| :--- | :--- | :--- |
| Unified My Setu + KisanSetu + VayuSetu UI | ✅ Implemented | Cute warm mint/cream/forest theme, responsive desktop & mobile |
| Real Hindi UI & Gemini Hindi AI | ✅ Implemented | Full `i18n.js` translation + Devanagari font + persistent language state |
| Intelligent Tool-Routing Streaming Chat | ✅ Implemented | Routes Weather, AQI, TinyFish, Memory & Vision via `/api/chat/stream` |
| Observed vs. Forecast Rainfall ("It Rained Here") | ✅ Implemented | Open-Meteo `past_days=2` + `forecast_days=5` + Chart.js graph |
| Live VayuSetu AQI + Environmental Bridge | ✅ Implemented | Open-Meteo Air Quality + CPCB NAQI + Gemini personalized guidance |
| Persistent Memory & Conversations | ✅ Implemented | `data/db.json` locally; `/tmp` fallback on Vercel serverless (`DATABASE_URL` schema ready for multi-region Postgres) |
| Automatic Scheduled Monitoring & Alerts | ✅ Implemented | Node `setInterval` scheduler locally; `vercel.json` Cron every 6h on Vercel |
| Soil OCR, Disease Scan, Schemes & Research | ✅ Implemented | Real Gemini multimodal + TinyFish Search & Fetch |

---

## GitHub & Deployment Guide

### Publish to GitHub (`setu-ai`)
```bash
git init
git add .
git status   # Verify .env and data/db.json are NOT listed
git commit -m "Initial SETU AI release"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/setu-ai.git
git push -u origin main
```

### Deploy to Vercel
1. Import the `setu-ai` GitHub repository in [vercel.com](https://vercel.com).
2. Add Environment Variables: `GEMINI_API_KEY`, `TINYFISH_API_KEY`, and optionally `CRON_SECRET`, `WEATHER_API_KEY`, `DATABASE_URL`.
3. `vercel.json` automatically configures `/api/*` routing and the `/api/cron/monitor` cron schedule.

### Deploy to Render.com
1. Push to GitHub and click **New + → Blueprint** on Render (`render.yaml` is included).
2. Add `GEMINI_API_KEY` and `TINYFISH_API_KEY` in Render Environment Variables.
