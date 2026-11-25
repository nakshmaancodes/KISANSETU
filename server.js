import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getWorkspaceState,
  clearWorkspaceData,
  updateSharedSettings,
  updateVayuMemory,
  updateKisanMemory,
  addMemory,
  editMemory,
  deleteMemory,
  listFields,
  saveField,
  deleteField,
  listSavedItems,
  addSavedItem,
  deleteSavedItem,
  listConversations,
  createConversation,
  renameConversation,
  deleteConversation,
  appendToConversation,
  listNotifications,
  markNotificationRead,
  updateMonitoringConfig
} from './services/storageService.js';

import {
  tinyfishSearch,
  tinyfishFetch,
  streamTinyfishAutomation,
  TinyFishConfigError
} from './services/tinyfishService.js';

import { fetchRealWeather, fetchRealAirQuality } from './services/weatherService.js';

import {
  planChatTools,
  streamGroundedChat,
  generateVayuAndBridge,
  extractSoilReport,
  analyzeCropDisease,
  recommendCrops,
  interpretWeather,
  synthesizeSchemes,
  synthesizeResearch,
  GeminiConfigError
} from './services/geminiService.js';

import {
  STATES_DATA,
  CROPS_DATA,
  PESTS_DATA,
  LANGUAGES_DATA,
  MARKETS_DATA,
  matchStateMeta,
  calculateFertilizerPlan
} from './services/agronomyService.js';

import {
  runMonitoringCycle,
  runAllScheduledMonitoring,
  startBackgroundScheduler
} from './services/monitoringService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const NOMINATIM_UA =
  process.env.NOMINATIM_USER_AGENT || 'SetuAI/4.0 (precision-env-ag@setu.local)';

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getUserId(req) {
  return req.headers['x-setu-user'] || req.headers['x-farmer-id'] || 'default';
}

function handleApiError(res, err) {
  if (err instanceof GeminiConfigError || err instanceof TinyFishConfigError) {
    return res.status(503).json({
      error: err.message,
      needsConfiguration: true,
      service: err instanceof GeminiConfigError ? 'GEMINI_API_KEY' : 'TINYFISH_API_KEY'
    });
  }
  return res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
}

// Nominatim rate-limiter & cache
const geocodeCache = new Map();
let lastNominatimCall = 0;

async function nominatimFetch(url) {
  const now = Date.now();
  const waitMs = Math.max(0, 1100 - (now - lastNominatimCall));
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  lastNominatimCall = Date.now();

  const resp = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
  return resp.json();
}

function buildMemorySummary(ws) {
  const latestSoil = ws.savedItems.find(s => s.type === 'soil') || null;
  return {
    name: ws.shared.name || null,
    preferredLanguage: ws.shared.preferredLanguage || 'en',
    savedLocation: ws.shared.location || null,
    farmLocation: ws.shared.farmLocation || null,
    vayuSetu: {
      householdContext: ws.vayuMemory.householdContext || null,
      dailySchedule: ws.vayuMemory.dailySchedule || null,
      airPreferences: ws.vayuMemory.airPreferences || null
    },
    kisanSetu: {
      cropsGrown: ws.kisanMemory.cropsGrown || null,
      farmingSeason: ws.kisanMemory.farmingSeason || null,
      soilType: ws.kisanMemory.soilType || null,
      irrigationType: ws.kisanMemory.irrigationType || null,
      savedFields: ws.kisanMemory.fields.map(f => ({
        name: f.name,
        crop: f.crop,
        areaAcres: Number(f.areaAcres?.toFixed(2)),
        areaHectares: Number(f.areaHectares?.toFixed(3)),
        location: f.locationNote,
        centroid: f.centroid
      })),
      latestSoilReport: latestSoil ? { title: latestSoil.title, parameters: latestSoil.data?.parameters } : null
    },
    rememberedFacts: ws.memories.slice(0, 15).map(m => `[${m.scope}] ${m.text}`)
  };
}

// ---------------- HEALTH, META & WORKSPACE ----------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    product: 'SETU AI',
    geminiConfigured: Boolean((process.env.GEMINI_API_KEY || '').trim()),
    tinyfishConfigured: Boolean((process.env.TINYFISH_API_KEY || '').trim()),
    weatherAndAqiProvider: (process.env.WEATHER_API_KEY || '').trim()
      ? 'OpenWeatherMap + Open-Meteo (Weather & AQI)'
      : 'Open-Meteo Live Weather & Air Quality API',
    persistenceMode: process.env.VERCEL === '1'
      ? 'Serverless /tmp JSON store (configure DATABASE_URL for permanent multi-region DB)'
      : 'Persistent Backend JSON Store (data/db.json)',
    schedulerMode: process.env.VERCEL === '1'
      ? 'Vercel Cron (/api/cron/monitor)'
      : 'Active Node.js Background Interval Scheduler + /api/cron/monitor',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/meta', (req, res) => {
  res.json({
    states: STATES_DATA,
    crops: CROPS_DATA,
    pests: PESTS_DATA,
    languages: LANGUAGES_DATA,
    markets: MARKETS_DATA
  });
});

app.get('/api/workspace', (req, res) => {
  const ws = getWorkspaceState(getUserId(req));
  res.json({ workspace: ws });
});

app.put('/api/settings', (req, res) => {
  const userId = getUserId(req);
  const { shared, vayuMemory, kisanMemory } = req.body || {};
  if (shared) updateSharedSettings(userId, shared);
  if (vayuMemory) updateVayuMemory(userId, vayuMemory);
  if (kisanMemory) updateKisanMemory(userId, kisanMemory);
  res.json({ workspace: getWorkspaceState(userId) });
});

app.delete('/api/settings/account', (req, res) => {
  const ws = clearWorkspaceData(getUserId(req));
  res.json({ cleared: true, workspace: ws });
});

// ---------------- PERSISTENT MEMORIES ----------------
app.post('/api/memories', (req, res) => {
  const { scope, text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Memory text is required.' });
  const item = addMemory(getUserId(req), { scope: scope || 'shared', text, source: 'User' });
  res.json({ memory: item });
});

app.put('/api/memories/:id', (req, res) => {
  const item = editMemory(getUserId(req), req.params.id, req.body?.text);
  if (!item) return res.status(404).json({ error: 'Memory not found.' });
  res.json({ memory: item });
});

app.delete('/api/memories/:id', (req, res) => {
  const deleted = deleteMemory(getUserId(req), req.params.id);
  res.json({ deleted });
});

// ---------------- GEOCODING ----------------
app.get('/api/geocode', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'Valid lat and lon are required.' });
  }
  const cacheKey = `rev:${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (geocodeCache.has(cacheKey)) return res.json({ ...geocodeCache.get(cacheKey), cached: true });

  try {
    const data = await nominatimFetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&addressdetails=1&zoom=16`
    );
    const addr = data.address || {};
    const village = addr.village || addr.hamlet || addr.suburb || addr.town || '';
    const tehsil = addr.county || addr.subdistrict || '';
    const district = addr.state_district || addr.district || addr.city || addr.county || '';
    const state = addr.state || '';
    const pincode = addr.postcode || '';

    const payload = {
      village, tehsil, district, state, pincode,
      displayName: data.display_name || '',
      stateMeta: matchStateMeta(state),
      provenance: 'Real Retrieved Data (OpenStreetMap Nominatim)'
    };
    geocodeCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: `Reverse geocoding failed: ${err.message}` });
  }
});

app.get('/api/geocode/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Search query q is required.' });
  try {
    const results = await nominatimFetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=5&addressdetails=1`
    );
    res.json({
      results: (results || []).map(r => ({
        displayName: r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        address: r.address || {}
      }))
    });
  } catch (err) {
    res.status(502).json({ error: `Location search failed: ${err.message}` });
  }
});

// ---------------- WEATHER, RAIN ("IT RAINED HERE") & VAYUSETU AQI ----------------
app.post('/api/weather', async (req, res) => {
  try {
    const userId = getUserId(req);
    const ws = getWorkspaceState(userId);
    const loc = req.body?.lat !== undefined ? req.body : (ws.shared.farmLocation || ws.shared.location);
    if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lon))) {
      return res.status(400).json({ error: 'No location available. Please save your location or select one.' });
    }
    const langCode = req.body?.languageCode || ws.shared.preferredLanguage || 'en';
    const weather = await fetchRealWeather(loc.lat, loc.lon);

    let interpretation = null;
    let aiError = null;
    if ((process.env.GEMINI_API_KEY || '').trim()) {
      try {
        interpretation = await interpretWeather({
          weather,
          crop: req.body?.crop || ws.kisanMemory.cropsGrown || '',
          location: req.body?.locationLabel || loc.label || '',
          languageCode: langCode
        });
      } catch (err) {
        aiError = err.message;
      }
    }
    res.json({ weather, interpretation, aiError, locationUsed: loc });
  } catch (err) {
    res.status(502).json({ error: `Weather retrieval failed: ${err.message}` });
  }
});

app.post('/api/vayu/analyze', async (req, res) => {
  try {
    const userId = getUserId(req);
    const ws = getWorkspaceState(userId);
    const loc = req.body?.lat !== undefined ? req.body : (ws.shared.location || ws.shared.farmLocation);
    if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lon))) {
      return res.status(400).json({ error: 'Please save or search a location first to retrieve live Air Quality.' });
    }
    const langCode = req.body?.languageCode || ws.shared.preferredLanguage || 'en';
    const locationLabel = req.body?.locationLabel || loc.label || `${Number(loc.lat).toFixed(2)}, ${Number(loc.lon).toFixed(2)}`;

    const [aqiData, weather] = await Promise.all([
      fetchRealAirQuality(loc.lat, loc.lon),
      fetchRealWeather(loc.lat, loc.lon).catch(() => null)
    ]);

    let guidance = null;
    let bridge = null;
    let aiError = null;

    if ((process.env.GEMINI_API_KEY || '').trim()) {
      try {
        const aiOut = await generateVayuAndBridge({
          aqiData,
          weather,
          vayuMemory: ws.vayuMemory,
          farmContext: {
            cropsGrown: ws.kisanMemory.cropsGrown,
            fieldsCount: ws.kisanMemory.fields.length
          },
          locationLabel,
          languageCode: langCode
        });
        guidance = aiOut.guidance;
        bridge = aiOut.bridge;
      } catch (err) {
        aiError = err.message;
      }
    }

    res.json({ aqiData, weather, guidance, bridge, aiError, locationUsed: { ...loc, label: locationLabel } });
  } catch (err) {
    res.status(502).json({ error: `Air quality retrieval failed: ${err.message}` });
  }
});

// ---------------- KISANSETU: FIELDS, SOIL, CROPS, FERTILIZER, DISEASE ----------------
app.get('/api/fields', (req, res) => res.json({ fields: listFields(getUserId(req)) }));

app.post('/api/fields', (req, res) => {
  const { name, areaSqm } = req.body || {};
  if (!name || !Number.isFinite(Number(areaSqm)) || Number(areaSqm) <= 0) {
    return res.status(400).json({ error: 'Field name and valid polygon area (> 0 m²) are required.' });
  }
  const field = saveField(getUserId(req), req.body);
  res.json({ field });
});

app.delete('/api/fields/:id', (req, res) => res.json({ deleted: deleteField(getUserId(req), req.params.id) }));

app.post('/api/soil/analyze', async (req, res) => {
  try {
    const userId = getUserId(req);
    const ws = getWorkspaceState(userId);
    const { base64Data, mimeType, fileName, languageCode } = req.body || {};
    if (!base64Data) return res.status(400).json({ error: 'Please upload a Soil Health Card image or PDF.' });
    const extracted = await extractSoilReport({
      base64Data,
      mimeType,
      languageCode: languageCode || ws.shared.preferredLanguage || 'en'
    });
    const saved = addSavedItem(userId, {
      type: 'soil',
      module: 'kisan',
      title: `Soil Report: ${fileName || 'Uploaded Card'}`,
      provenance: 'AI Extraction (Verify Values)',
      summary: extracted.plainLanguageSummary || 'Soil report extracted.',
      data: extracted
    });
    res.json({ extracted, savedId: saved.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

app.post('/api/crops/recommend', async (req, res) => {
  try {
    const userId = getUserId(req);
    const ws = getWorkspaceState(userId);
    const { state, district, season, soilType, waterAvailability, fieldSizeAcres, soilParams, preferences, useTinyFishGrounding, languageCode } = req.body || {};
    if (!state && !season) return res.status(400).json({ error: 'State or season is required.' });

    let retrievedSources = [];
    if (useTinyFishGrounding && (process.env.TINYFISH_API_KEY || '').trim()) {
      try {
        const sr = await tinyfishSearch(`ICAR recommended crops ${season || ''} ${state || ''} ${district || ''}`.trim());
        retrievedSources = sr.items.slice(0, 4);
      } catch { /* non-fatal */ }
    }

    const result = await recommendCrops({
      input: { state, district, season, soilType, waterAvailability, fieldSizeAcres, soilParams, preferences },
      retrievedSources,
      languageCode: languageCode || ws.shared.preferredLanguage || 'en'
    });

    const saved = addSavedItem(userId, {
      type: 'crop',
      module: 'kisan',
      title: `Crop Advice: ${season || ''} (${state || 'India'})`,
      provenance: 'AI Guidance (Not Yield Model)',
      summary: result.recommendations?.map(r => r.cropName).join(', ') || '',
      data: { input: req.body, result, retrievedSources }
    });
    res.json({ result, retrievedSources, savedId: saved.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

app.post('/api/fertilizer/calculate', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { areaHectares, cropName, state, soilParams, printedDoses, fetchOfficialAdvisory } = req.body || {};
    if (!cropName || !Number.isFinite(Number(areaHectares)) || Number(areaHectares) <= 0) {
      return res.status(400).json({ error: 'Select a crop and valid field area (> 0 ha).' });
    }
    const calculation = calculateFertilizerPlan({ areaHectares, cropName, soilParams, printedDoses });

    let officialLinks = [];
    let officialFetchError = null;
    if (fetchOfficialAdvisory) {
      try {
        const sr = await tinyfishSearch(`ICAR fertilizer dose ${cropName} ${state || 'India'} kg per hectare`);
        officialLinks = sr.items.slice(0, 4);
      } catch (err) {
        officialFetchError = err.message;
      }
    }

    const saved = addSavedItem(userId, {
      type: 'fertilizer',
      module: 'kisan',
      title: `Fertilizer: ${cropName} (${Number(areaHectares).toFixed(2)} ha)`,
      provenance: calculation.supported ? 'Deterministic Formula + ICAR/SHC' : 'Unavailable Reference',
      summary: calculation.supported
        ? `Urea ${calculation.quantities.ureaBags50kg} bags, DAP ${calculation.quantities.dapBags50kg} bags, MOP ${calculation.quantities.mopBags50kg} bags`
        : calculation.recommendationSource,
      data: { calculation, officialLinks }
    });

    res.json({ calculation, officialLinks, officialFetchError, savedId: saved.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

app.post('/api/disease/analyze', async (req, res) => {
  try {
    const userId = getUserId(req);
    const ws = getWorkspaceState(userId);
    const { base64Data, mimeType, cropHint, notes, languageCode } = req.body || {};
    if (!base64Data) return res.status(400).json({ error: 'Plant image is required.' });
    const analysis = await analyzeCropDisease({
      base64Data,
      mimeType,
      cropHint,
      notes,
      languageCode: languageCode || ws.shared.preferredLanguage || 'en'
    });
    const saved = addSavedItem(userId, {
      type: 'disease',
      module: 'kisan',
      title: `Plant Scan: ${analysis.likelyCrop || cropHint || 'Crop'}`,
      provenance: 'AI Visual Observation (Not Lab Confirmed)',
      summary: analysis.potentialIdentifications?.[0]?.name || analysis.imageQualityFeedback,
      data: analysis
    });
    res.json({ analysis, savedId: saved.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

// ---------------- TINYFISH RESEARCH & SCHEMES ----------------
app.post('/api/schemes/find', async (req, res) => {
  try {
    const userId = getUserId(req);
    const ws = getWorkspaceState(userId);
    const { state, district, category, crop, schemeType, languageCode } = req.body || {};
    const query = `${state || 'India'} ${district || ''} government agricultural scheme ${schemeType || ''} ${crop || ''} ${category || ''} site:gov.in OR site:nic.in`.replace(/\s+/g, ' ').trim();
    const searchRes = await tinyfishSearch(query, { location: 'IN' });

    if (!searchRes.items.length) {
      return res.json({ query, schemes: [], fetchedUrls: [], fetchErrors: [], overviewNote: 'No matching official scheme pages returned.' });
    }
    const fetched = await tinyfishFetch(searchRes.items.slice(0, 4).map(x => x.url));
    const organized = await synthesizeSchemes({
      filters: { state, district, category, crop, schemeType },
      fetchedDocs: fetched.results,
      searchItems: searchRes.items.slice(0, 6),
      languageCode: languageCode || ws.shared.preferredLanguage || 'en'
    });

    const saved = addSavedItem(userId, {
      type: 'schemes',
      module: 'kisan',
      title: `Schemes: ${state || 'India'} ${schemeType || ''}`.trim(),
      provenance: 'TinyFish Live Retrieval',
      summary: `${organized.schemes?.length || 0} schemes retrieved`,
      data: { query, organized, fetchedUrls: fetched.results.map(r => r.url) }
    });
    res.json({ query, ...organized, fetchedUrls: fetched.results.map(r => ({ title: r.title, url: r.url })), fetchErrors: fetched.errors, retrievedAt: searchRes.retrievedAt, savedId: saved.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

app.post('/api/research', async (req, res) => {
  try {
    const userId = getUserId(req);
    const ws = getWorkspaceState(userId);
    const { query, state, crop, scope, languageCode } = req.body || {};
    if (!query || !String(query).trim()) return res.status(400).json({ error: 'Research query is required.' });
    const fullQuery = `${query.trim()} ${state || ws.shared.location?.label || ''} ${crop || ''} India`.replace(/\s+/g, ' ').trim();
    const searchRes = await tinyfishSearch(fullQuery, { location: 'IN' });

    if (!searchRes.items.length) {
      return res.json({
        query: fullQuery,
        executiveSummary: 'TinyFish Search returned 0 results. Try broader terms.',
        keyFindings: [],
        actionItems: [],
        limitationsAndGaps: 'No accessible pages retrieved.',
        citations: [],
        fetchErrors: []
      });
    }

    const fetched = await tinyfishFetch(searchRes.items.slice(0, 4).map(x => x.url));
    const synthesized = await synthesizeResearch({
      query: fullQuery,
      fetchedDocs: fetched.results,
      fetchErrors: fetched.errors,
      searchItems: searchRes.items.slice(0, 6),
      languageCode: languageCode || ws.shared.preferredLanguage || 'en'
    });
    const allowedUrls = new Set([...searchRes.items.map(x => x.url), ...fetched.results.map(x => x.url)]);
    synthesized.citations = (synthesized.citations || []).filter(c => allowedUrls.has(c.url));

    const saved = addSavedItem(userId, {
      type: 'research',
      module: scope || 'shared',
      title: `Research: ${query.trim().slice(0, 55)}`,
      provenance: 'TinyFish Web Research',
      summary: synthesized.executiveSummary?.slice(0, 170) || '',
      data: { query: fullQuery, synthesized, fetchErrors: fetched.errors }
    });
    res.json({ query: fullQuery, ...synthesized, retrievedAt: new Date().toISOString(), fetchErrors: fetched.errors, savedId: saved.id });
  } catch (err) {
    handleApiError(res, err);
  }
});

app.post('/api/land-records/stream', async (req, res) => {
  const { state, district, tehsil, village, khasra } = req.body || {};
  const stateMeta = matchStateMeta(state);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const goal = `Inspect ${stateMeta.portalName} for State=${state || ''}, District=${district || ''}, Village=${village || ''}, Khasra=${khasra || ''}. If CAPTCHA or login blocks you, STOP immediately and return JSON: {"status":"captcha_required","portal_name":"${stateMeta.portalName}","message":"Portal requires manual CAPTCHA."}.`;
  try {
    sendEvent('status', { message: `Connecting to TinyFish for ${stateMeta.portalName}...`, portalUrl: stateMeta.portalUrl });
    await streamTinyfishAutomation({
      url: stateMeta.portalUrl,
      goal,
      signal: controller.signal,
      onEvent: (evt) => {
        if (evt.type === 'STREAMING_URL' || evt.streaming_url) sendEvent('streaming_url', { streamingUrl: evt.streaming_url || evt.url });
        else if (evt.type === 'PROGRESS' || evt.purpose) sendEvent('progress', { message: evt.purpose || evt.message });
        else if (evt.type === 'COMPLETE' || evt.status === 'COMPLETED') sendEvent('complete', { result: evt.resultJson || evt.result_json || evt.result || {}, portalName: stateMeta.portalName, portalUrl: stateMeta.portalUrl });
        else if (evt.type === 'ERROR' || evt.status === 'FAILED') sendEvent('error', { message: evt.error?.message || evt.message || 'TinyFish run failed' });
      }
    });
    res.end();
  } catch (err) {
    if (err.name !== 'AbortError') {
      sendEvent('error', { message: err.message });
      res.end();
    }
  }
});

// ---------------- SAVED ITEMS, NOTIFICATIONS & MONITORING ----------------
app.get('/api/saved', (req, res) => res.json({ items: listSavedItems(getUserId(req), req.query.type || null) }));
app.post('/api/saved', (req, res) => res.json({ item: addSavedItem(getUserId(req), req.body || {}) }));
app.delete('/api/saved/:id', (req, res) => res.json({ deleted: deleteSavedItem(getUserId(req), req.params.id) }));

app.get('/api/notifications', (req, res) => res.json({ notifications: listNotifications(getUserId(req)) }));
app.post('/api/notifications/read', (req, res) => {
  const { id, dismiss } = req.body || {};
  res.json({ notifications: markNotificationRead(getUserId(req), id || 'all', Boolean(dismiss)) });
});

app.put('/api/monitoring/config', (req, res) => {
  const monitoring = updateMonitoringConfig(getUserId(req), req.body || {});
  res.json({ monitoring });
});

app.post('/api/monitoring/run', async (req, res) => {
  const result = await runMonitoringCycle(getUserId(req), { force: true });
  res.json({ ...result, notifications: listNotifications(getUserId(req)) });
});

app.get('/api/cron/monitor', async (req, res) => {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized cron trigger' });
  }
  const results = await runAllScheduledMonitoring();
  res.json({ ok: true, checkedAt: new Date().toISOString(), results });
});

// ---------------- CONVERSATIONS & INTELLIGENT TOOL-ROUTING CHAT STREAM ----------------
app.get('/api/conversations', (req, res) => res.json({ conversations: listConversations(getUserId(req)) }));

app.post('/api/conversations', (req, res) => {
  const conv = createConversation(getUserId(req), req.body || {});
  res.json({ conversation: conv });
});

app.put('/api/conversations/:id', (req, res) => {
  const conv = renameConversation(getUserId(req), req.params.id, req.body?.title);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ conversation: conv });
});

app.delete('/api/conversations/:id', (req, res) => {
  res.json({ deleted: deleteConversation(getUserId(req), req.params.id) });
});

app.post('/api/chat/stream', async (req, res) => {
  const userId = getUserId(req);
  const ws = getWorkspaceState(userId);
  const { conversationId, message, imageBase64, mimeType, activeModule, languageCode } = req.body || {};

  if (!message && !imageBase64) {
    return res.status(400).json({ error: 'Message or image is required.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const existingConv = ws.conversations.find(c => c.id === conversationId);
  const history = existingConv ? existingConv.messages : [];
  const memorySummary = buildMemorySummary(ws);
  const preferredLang = languageCode || ws.shared.preferredLanguage || 'en';

  try {
    send('tool_status', { step: 'routing', label: preferredLang === 'hi' ? 'आपके प्रश्न को समझा जा रहा है...' : 'Understanding your question...' });
    const plan = await planChatTools({
      message: message || 'Analyze uploaded image',
      history,
      memorySummary,
      activeModule,
      preferredLanguage: preferredLang
    });

    const respLang = plan.responseLanguage || preferredLang;
    const toolResults = {};
    const toolsUsed = [];

    if (plan.rememberFact) {
      addMemory(userId, { scope: plan.rememberScope || 'shared', text: plan.rememberFact, source: 'AI Chat' });
      toolsUsed.push('Persistent Memory');
    }

    const loc = ws.shared.location || ws.shared.farmLocation || ws.kisanMemory.fields?.[0]?.centroid;

    if ((plan.needsWeather || plan.needsAqi) && loc && Number.isFinite(Number(loc.lat))) {
      send('tool_status', {
        step: 'local_data',
        label: respLang === 'hi' ? 'आपके स्थान का मौसम और हवा (AQI) जाँचा जा रहा है...' : 'Fetching live weather & air quality for your saved location...'
      });
      if (plan.needsWeather) {
        try {
          toolResults.weather = await fetchRealWeather(loc.lat, loc.lon);
          toolsUsed.push('Open-Meteo Weather');
        } catch (err) {
          toolResults.weatherError = err.message;
        }
      }
      if (plan.needsAqi) {
        try {
          toolResults.airQuality = await fetchRealAirQuality(loc.lat, loc.lon);
          toolsUsed.push('Open-Meteo AQI');
        } catch (err) {
          toolResults.aqiError = err.message;
        }
      }
    }

    if (plan.needsTinyfish && (process.env.TINYFISH_API_KEY || '').trim()) {
      send('tool_status', {
        step: 'tinyfish',
        label: respLang === 'hi' ? 'विश्वसनीय स्रोतों से जानकारी खोजी जा रही है...' : 'Researching reliable sources with TinyFish...'
      });
      try {
        const q = plan.tinyfishQuery || `${message} ${loc?.label || 'India'}`;
        const sr = await tinyfishSearch(q, { location: 'IN' });
        const topUrls = sr.items.slice(0, 3).map(x => x.url);
        const fetched = topUrls.length ? await tinyfishFetch(topUrls) : { results: [], errors: [] };
        toolResults.tinyfishSources = sr.items.slice(0, 4).map(x => ({ title: x.title, url: x.url, snippet: x.snippet }));
        toolResults.tinyfishExtractedDocs = fetched.results;
        toolResults.tinyfishErrors = fetched.errors;
        toolsUsed.push('TinyFish Web Research');
      } catch (err) {
        toolResults.tinyfishError = err.message;
      }
    } else if (plan.needsTinyfish) {
      toolResults.tinyfishError = 'TINYFISH_API_KEY is not configured.';
    }

    send('tool_status', {
      step: 'gemini',
      label: respLang === 'hi' ? 'AI के साथ विश्लेषण और उत्तर तैयार किया जा रहा है...' : 'Analyzing with Gemini...'
    });

    const replyText = await streamGroundedChat({
      message: message || 'Please inspect this plant/crop image.',
      history,
      memorySummary: buildMemorySummary(getWorkspaceState(userId)),
      toolResults,
      imageBase64,
      mimeType,
      responseLanguage: respLang,
      signal: controller.signal,
      onChunk: (chunk) => send('chunk', { text: chunk })
    });

    const citations = (toolResults.tinyfishSources || []).map(s => ({ title: s.title, url: s.url }));
    const savedConv = appendToConversation(
      userId,
      conversationId,
      { id: `m_u_${Date.now()}`, role: 'user', text: message || '[Image attached]', imageAttached: Boolean(imageBase64), timestamp: new Date().toISOString() },
      { id: `m_a_${Date.now()}`, role: 'assistant', text: replyText, toolsUsed, citations, responseLanguage: respLang, timestamp: new Date().toISOString() },
      plan.module
    );

    send('done', {
      conversation: savedConv,
      toolsUsed,
      citations,
      responseLanguage: respLang,
      rememberedFact: plan.rememberFact || null
    });
    res.end();
  } catch (err) {
    if (err.name !== 'AbortError') {
      send('error', { error: err.message, needsConfiguration: err instanceof GeminiConfigError });
      res.end();
    }
  }
});

if (process.env.VERCEL !== '1') {
  startBackgroundScheduler();
  app.listen(PORT, () => {
    console.log(`SETU AI running at http://localhost:${PORT}`);
  });
}

export default app;
