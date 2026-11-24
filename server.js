'use strict';
// Pi dashboard server: bridges the browser to Spotify Soloist (audio + control)
// and to the Spotify Web API (search, playlists, library). Zero framework.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn, execFile } = require('child_process');

const CFG = {
  host: process.env.HOST || '127.0.0.1',
  port: +process.env.PORT || 8080,
  soloistWs: process.env.SOLOIST_WS || 'ws://127.0.0.1:9090',
  dataDir: process.env.DASH_DATA || path.join(os.homedir(), '.pi-dashboard'),
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  ytKey: process.env.YOUTUBE_API_KEY || '',
  demo: process.env.DEMO === '1',
  deviceName: process.env.DEVICE_NAME || 'Pi',
  // Small LAN-facing listener for the phone triggers (sleep / wake / handoff). Everything else stays on HOST (localhost by default).
  triggerHost: process.env.TRIGGER_HOST || '0.0.0.0',
  triggerPort: process.env.TRIGGER_PORT === undefined ? 8081 : +process.env.TRIGGER_PORT, // 0 turns it off
};
fs.mkdirSync(CFG.dataDir, { recursive: true, mode: 0o700 });
const PUB = path.join(__dirname, 'public');
const REDIRECT = `http://127.0.0.1:${CFG.port}/auth/callback`;
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read user-library-modify user-read-playback-state user-modify-playback-state user-read-recently-played user-read-playback-position';

/* ---------- small helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o, mode = 0o600) => fs.writeFileSync(f, JSON.stringify(o), { mode });
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Browsers on other sites must not be able to drive the player (Soloist's own
// WebSocket has no Origin checks, so this proxy is the only gate).
let confGet = () => ({});
const allowedOrigins = () => [...(confGet().corsOrigins || []), ...(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)];
function tokenFrom(req) { const u = new URL(req.url, 'http://x'); return (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-token'] || u.searchParams.get('token') || ''; }
const tokenValid = req => { const t = confGet().apiToken; return !!t && tokenFrom(req) === t; };
// Same-site pages pass. A page on another origin (e.g. the hosted companion app) passes only if it is on the allow-list AND sends the API token.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // non-browser clients / same-origin GETs
  try { if (new URL(o).host === req.headers.host) return true; } catch { return false; }
  return allowedOrigins().includes(o) && tokenValid(req);
}

/* ---------- Spotify OAuth (PKCE, no client secret) ---------- */
const TOKEN_FILE = path.join(CFG.dataDir, 'spotify-token.json');
let tok = readJson(TOKEN_FILE, null);
let pending = null; // { verifier, state }

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.clientId, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'token request failed');
  return j;
}
function saveTok(j) {
  tok = { access: j.access_token, refresh: j.refresh_token || tok?.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
  writeJson(TOKEN_FILE, tok);
}
async function accessToken() {
  if (!tok) return null;
  if (Date.now() < tok.exp) return tok.access;
  try { saveTok(await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh })); return tok.access; }
  catch (e) { console.error('refresh failed:', e.message); tok = null; try { fs.unlinkSync(TOKEN_FILE); } catch {} return null; }
}

function authLogin(req, res) {
  if (!CFG.clientId) return json(res, 500, { error: 'SPOTIFY_CLIENT_ID is not set' });
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(16));
  pending = { verifier, state };
  const q = new URLSearchParams({
    response_type: 'code', client_id: CFG.clientId, scope: SCOPES, redirect_uri: REDIRECT, state,
    code_challenge_method: 'S256', code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
  });
  res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + q });
  res.end();
}
async function authCallback(req, res, url) {
  const done = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<meta name=viewport content="width=device-width"><body style="font:20px system-ui;background:#0b0d10;color:#fff;padding:40px">${msg}<p><a style="color:#1ed760" href="/">Back to the dashboard</a></p>`); };
  const p = pending; pending = null;
  if (!p || url.searchParams.get('state') !== p.state) return done('Login expired or invalid. Start again from the dashboard.');
  if (url.searchParams.get('error')) return done('Spotify said: ' + url.searchParams.get('error'));
  try {
    saveTok(await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: p.verifier }));
    res.writeHead(302, { Location: '/' }); res.end();
  } catch (e) { done('Login failed: ' + e.message); }
}

/* ---------- Spotify Web API proxy (whitelisted) ---------- */
const ID = '[A-Za-z0-9]+';
const GET_OK = [
  /^search$/, /^me$/, /^me\/playlists$/, /^me\/tracks$/, /^me\/albums$/, /^me\/library\/contains$/, /^me\/shows$/,
  new RegExp(`^playlists/${ID}$`), new RegExp(`^playlists/${ID}/items$`),
  new RegExp(`^albums/${ID}$`), new RegExp(`^artists/${ID}$`), new RegExp(`^artists/${ID}/albums$`), new RegExp(`^tracks/${ID}$`), new RegExp(`^shows/${ID}$`), new RegExp(`^shows/${ID}/episodes$`),
];
const WRITE_OK = [/^me\/library$/];

async function spotifyProxy(req, res, url, sub) {
  if (CFG.demo) return require('./tools/demo-data').handle(req, res, url, sub, json);
  const ok = req.method === 'GET' ? GET_OK : (['PUT', 'DELETE'].includes(req.method) ? WRITE_OK : []);
  if (!ok.some(re => re.test(sub))) return json(res, 403, { error: 'not allowed' });
  if (req.method !== 'GET' && (req.headers['x-dash'] !== '1' || !sameOrigin(req))) return json(res, 403, { error: 'bad origin' });
  const t = await accessToken();
  if (!t) return json(res, 401, { error: 'not_logged_in', clientIdSet: !!CFG.clientId });
  const target = 'https://api.spotify.com/v1/' + sub + url.search;
  const r = await fetch(target, { method: req.method, headers: { Authorization: 'Bearer ' + t } });
  const body = await r.text();
  const headers = { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' };
  if (r.headers.get('retry-after')) headers['Retry-After'] = r.headers.get('retry-after');
  res.writeHead(r.status, headers); res.end(body);
}

/* ---------- Recently played (for sorting tiles) ---------- */
const HIST_FILE = path.join(CFG.dataDir, 'history.json');
const hist = readJson(HIST_FILE, {});
let rpCache = { t: 0, m: {} };
async function recentMap(res) {
  const m = { ...hist };
  if (!CFG.demo) {
    if (Date.now() - rpCache.t > 60000) {
      rpCache.t = Date.now(); // also throttles retries if the token lacks the scope
      try {
        const t = await accessToken();
        if (t) {
          const r = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=50', { headers: { Authorization: 'Bearer ' + t } });
          if (r.ok) { const mm = {}; for (const it of (await r.json()).items || []) { const c = it.context; if (c && (c.type === 'playlist' || c.type === 'album')) mm[c.uri] = Math.max(mm[c.uri] || 0, Date.parse(it.played_at) || 0); } rpCache.m = mm; let ch = false; for (const [u, ts] of Object.entries(mm)) if ((hist[u] || 0) < ts) { hist[u] = ts; ch = true; } if (ch) writeJson(HIST_FILE, hist); } // keep what Spotify shows, since it only returns the last 50 plays
        }
      } catch {}
    }
    for (const [u, ts] of Object.entries(rpCache.m)) m[u] = Math.max(m[u] || 0, ts);
  }
  json(res, 200, m);
}
async function notePlayed(req, res) {
  if (req.headers['x-dash'] !== '1' || !sameOrigin(req)) return json(res, 403, {});
  let body = ''; for await (const c of req) { body += c; if (body.length > 1024) return json(res, 413, {}); }
  let m; try { m = JSON.parse(body); } catch { return json(res, 400, {}); }
  if (!/^spotify:(playlist|album|show):[A-Za-z0-9]+$/.test(m.uri || '')) return json(res, 400, {});
  hist[m.uri] = Date.now();
  const keep = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 500); // bounded
  for (const k of Object.keys(hist)) delete hist[k]; for (const [k, v] of keep) hist[k] = v;
  writeJson(HIST_FILE, hist); json(res, 200, { ok: true });
}

/* ---------- Playlist name/art by URI (no login needed), for playlists the API won't list ---------- */
const OEMBED_FILE = path.join(CFG.dataDir, 'oembed.json');
const oembedCache = readJson(OEMBED_FILE, {});
async function oembed(res, url) {
  const uri = url.searchParams.get('uri') || '';
  const m = uri.match(/^spotify:(playlist|album|show):([A-Za-z0-9]+)$/);
  if (!m) return json(res, 400, { error: 'bad uri' });
  if (oembedCache[uri]) return json(res, 200, oembedCache[uri]);
  if (CFG.demo) return json(res, 200, { title: 'Discover Weekly (demo)', thumbnail_url: '' });
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${m[1]}/${m[2]}`)}`);
    if (!r.ok) return json(res, 200, { error: 'none' });
    const j = await r.json(); const out = { title: j.title || '', thumbnail_url: j.thumbnail_url || '' };
    oembedCache[uri] = out; writeJson(OEMBED_FILE, oembedCache); json(res, 200, out);
  } catch { json(res, 200, { error: 'none' }); }
}

/* ---------- Pinned playlists (for ones the API never lists, e.g. Spotify's mood mixes) ---------- */
const PIN_FILE = path.join(CFG.dataDir, 'pins.json');
let pins = readJson(PIN_FILE, []);
async function pinsApi(req, res) {
  if (req.method === 'GET') return json(res, 200, pins);
  if (req.headers['x-dash'] !== '1' || !sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
  let body = ''; for await (const c of req) { body += c; if (body.length > 16384) return json(res, 413, {}); }
  let m; try { m = JSON.parse(body); } catch { return json(res, 400, {}); }
  if (req.method === 'POST') {
    const re = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]{10,})/g;
    let added = 0, x; const text = String(m.text || '');
    while ((x = re.exec(text))) { const u = 'spotify:playlist:' + x[1]; if (!pins.includes(u) && pins.length < 300) { pins.unshift(u); added++; } }
    writeJson(PIN_FILE, pins); return json(res, 200, { added, pins });
  }
  if (req.method === 'DELETE') { pins = pins.filter(u => u !== m.uri); writeJson(PIN_FILE, pins); return json(res, 200, { pins }); }
  json(res, 405, {});
}

/* ---------- System volume (PipeWire/WirePlumber), so it works for any output: USB DAC, HDMI, Bluetooth ---------- */
const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { timeout: 4000, maxBuffer: 8 << 20 }, (e, so) => e ? no(e) : ok(so)));
let sinkCache = { at: 0, name: '', id: '' };
async function sinkTarget() {
  if (process.env.AUDIO_SINK) return process.env.AUDIO_SINK;          // explicit override (id or "@DEFAULT_AUDIO_SINK@")
  const o = process.env.SOLOIST_OUTPUT;                               // the node Soloist is pinned to, if any
  if (!o) return '@DEFAULT_AUDIO_SINK@';
  if (/^\d+$/.test(o)) return o;
  if (sinkCache.name === o && Date.now() - sinkCache.at < 30000) return sinkCache.id;
  try { // wpctl wants an id, Soloist's flag takes a node name: look the id up
    const n = JSON.parse(await run('pw-dump', [])).find(x => x.type === 'PipeWire:Interface:Node' && x.info?.props?.['node.name'] === o);
    if (n) { sinkCache = { at: Date.now(), name: o, id: String(n.id) }; return sinkCache.id; }
  } catch {}
  return '@DEFAULT_AUDIO_SINK@';
}
let demoVol = 60;
async function volumeApi(req, res) {
  if (CFG.demo) { if (req.method === 'POST') { let b = ''; for await (const c of req) b += c; demoVol = Math.round(JSON.parse(b).volume); } return json(res, 200, { ok: true, volume: demoVol, muted: false }); }
  try {
    const target = await sinkTarget();
    if (req.method === 'POST') {
      if (req.headers['x-dash'] !== '1' || !sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
      let b = ''; for await (const c of req) { b += c; if (b.length > 512) return json(res, 413, {}); }
      const v = Number(JSON.parse(b).volume); if (!isFinite(v)) return json(res, 400, {});
      const f = Math.min(100, Math.max(0, Math.round(v))) / 100;       // never above 100%: no boost into the speaker
      await run('wpctl', ['set-volume', target, f.toFixed(2)]);
    }
    const out = await run('wpctl', ['get-volume', target]);
    const m = out.match(/Volume:\s*([\d.]+)/);
    return json(res, 200, { ok: true, volume: m ? Math.round(parseFloat(m[1]) * 100) : 0, muted: /MUTED/.test(out) });
  } catch (e) { return json(res, 200, { ok: false, error: String(e.code === 'ENOENT' ? 'wpctl not installed' : e.message).slice(0, 200) }); }
}

/* ---------- Play a track inside its album/playlist on this Pi ---------- */
// Soloist's `play` takes a bare URI (no offset), so "tap a track in a playlist" goes through
// the Web API player endpoint, targeted at the Soloist device by name.
async function playFrom(req, res) {
  if (CFG.demo) return json(res, 501, { error: 'demo' });
  if (req.headers['x-dash'] !== '1' || !sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
  let body = ''; for await (const c of req) { body += c; if (body.length > 4096) return json(res, 413, {}); }
  let m; try { m = JSON.parse(body); } catch { return json(res, 400, {}); }
  const ctx = m.context_uri, tr = m.track_uri;
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(tr || '') || (ctx && !/^spotify:(album|playlist):[A-Za-z0-9]+$/.test(ctx))) return json(res, 400, { error: 'bad uri' });
  const t = await accessToken(); if (!t) return json(res, 401, { error: 'not_logged_in' });
  const H = { Authorization: 'Bearer ' + t };
  const dr = await fetch('https://api.spotify.com/v1/me/player/devices', { headers: H });
  if (!dr.ok) return json(res, dr.status, { error: 'devices' });
  const dev = ((await dr.json()).devices || []).find(d => d.name.toLowerCase() === CFG.deviceName.toLowerCase());
  if (!dev) return json(res, 404, { error: 'device_not_found' });
  const pr = await fetch('https://api.spotify.com/v1/me/player/play?device_id=' + encodeURIComponent(dev.id), {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(ctx ? { context_uri: ctx, offset: { uri: tr } } : { uris: [tr] }),
  });
  res.writeHead(pr.status === 204 ? 200 : pr.status, { 'Content-Type': 'application/json' }); res.end('{}');
}

/* ---------- Hand playback back to the device it came from ---------- */
// Poll the device list so we know which other device was last active (usually the phone that cast to us).
let origin = null; // { id, name, type }
const isPi = d => d.name.toLowerCase() === CFG.deviceName.toLowerCase();
async function listDevices(t) {
  const r = await fetch('https://api.spotify.com/v1/me/player/devices', { headers: { Authorization: 'Bearer ' + t } });
  return r.ok ? ((await r.json()).devices || []) : null;
}
async function pollOrigin() {
  try {
    const t = await accessToken(); if (!t) return;
    const ds = await listDevices(t); if (!ds) return;
    const a = ds.find(d => d.is_active && !isPi(d));
    if (a) origin = { id: a.id, name: a.name, type: a.type };
    else if (origin && !ds.some(d => d.id === origin.id)) origin = null; // it went away
  } catch {}
}
if (!CFG.demo) { setInterval(pollOrigin, 4000); setTimeout(pollOrigin, 1000); }
async function handBack(req, res) {
  if (CFG.demo) return json(res, 200, { ok: true, demo: true, name: 'Phone' });
  if (req.headers['x-dash'] !== '1' || !sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
  let body = ''; for await (const c of req) { body += c; if (body.length > 1024) return json(res, 413, {}); }
  let m = {}; try { m = JSON.parse(body || '{}'); } catch {}
  const t = await accessToken(); if (!t) return json(res, 401, { error: 'not_logged_in' });
  const ds = await listDevices(t); if (!ds) return json(res, 502, { error: 'devices' });
  const others = ds.filter(d => !isPi(d));
  const dev = (origin && others.find(d => d.id === origin.id)) || others.find(d => d.type === 'Smartphone') || others[0];
  if (!dev) return json(res, 404, { error: 'no_other_device' });
  const r = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [dev.id], play: m.play !== false }),
  });
  if (r.status !== 204 && r.status !== 200) return json(res, r.status, { error: 'transfer_failed' });
  json(res, 200, { ok: true, name: dev.name });
}

/* ---------- Handoff: tap the phone on the NFC tag, Spotify moves to the Pi and the Music page blooms up ---------- */
// One ping does everything: wakes the screen if it's asleep, moves playback here, and tells the kiosk page
// (over the existing WebSocket) to run the animation. Safe to hit twice: repeats within 4 s are ignored.
// Tapping again while the Pi is already playing does the opposite and sends playback back to the phone.
const esc = x => String(x).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
let hoSeq = 0, hoLast = 0;
// What Soloist last told us, so a second tap can tell that the Pi is already playing.
const pb = { status: 'idle', active: false };
function trackSoloist(txt) {
  if (!/playback_state|playback_changed|device_changed|auth_state/.test(txt)) return;
  try {
    const m = JSON.parse(txt);
    if (m.status !== undefined && (m.type === 'playback_state' || m.type === 'playback_changed')) pb.status = m.status;
    if (m.is_active !== undefined && ['playback_state', 'device_changed', 'auth_state'].includes(m.type)) pb.active = !!m.is_active;
  } catch {}
}
// Move playback to the phone (or whichever other device was last active). Returns its name, or null.
async function sendBackToPhone() {
  if (CFG.demo) return 'Phone';
  const t = await accessToken(); if (!t) return null;
  const ds = await listDevices(t); if (!ds) return null;
  const others = ds.filter(d => !isPi(d));
  const dev = (origin && others.find(d => d.id === origin.id)) || others.find(d => d.type === 'Smartphone') || others[0];
  if (!dev) return null;
  const r = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [dev.id], play: true }),
  });
  return (r.status === 204 || r.status === 200) ? dev.name : null;
}
async function transferHere() {
  // 1) Web API transfer: takes over from whatever device is playing. Soloist can take a moment to appear in the device list, so retry.
  const t = await accessToken();
  if (t) {
    for (let i = 0; i < 4; i++) {
      try {
        const dev = ((await listDevices(t)) || []).find(isPi);
        if (dev) {
          const r = await fetch('https://api.spotify.com/v1/me/player', {
            method: 'PUT', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_ids: [dev.id], play: true }),
          });
          if (r.status === 204 || r.status === 200) return 'webapi';
          if (r.status === 401 || r.status === 403) break;
        }
      } catch {}
      await sleepMs(700);
    }
  }
  // 2) Not signed in to the Web API (or it wouldn't transfer): ask Soloist itself, same as the on-screen "Play here" button.
  if (upOpen) { up.send(JSON.stringify({ type: 'command', command: 'activate' })); return 'soloist'; }
  return null;
}
async function handoff(req, res, url) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
  if (!powerApi.tokenOk(req, url)) return json(res, 401, { error: 'bad or missing token' });
  const accepts = (req.headers.accept || '').includes('text/html'); // an NFC URL tag opens Safari: give it a tiny page, not JSON
  const reply = (obj) => accepts && req.method === 'GET'
    ? (res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }), res.end(`<meta name=viewport content="width=device-width"><body style="font:22px system-ui;background:#0b0d10;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:56px;color:#1ed760">${obj.ok ? '&#9654;' : '!'}</div>${obj.how === 'back' ? (obj.ok ? 'Sent back to ' + esc(obj.to) : 'Couldn&rsquo;t send it back') : obj.ok ? 'Playing on the Pi' : 'Couldn&rsquo;t move playback'}</div>`))
    : json(res, 200, obj);
  if (Date.now() - hoLast < 4000) return reply({ ok: true, duplicate: true });
  hoLast = Date.now();
  const id = ++hoSeq, from = origin?.name || null;
  if (pb.status === 'playing' && pb.active) { // second tap while the Pi is already playing: give it back to the phone
    const to = await sendBackToPhone().catch(e => { console.error('handoff back:', e.message); return null; });
    broadcast(JSON.stringify({ type: 'handoff', phase: 'back', id, ok: !!to, to }));
    return reply({ ok: !!to, how: 'back', to });
  }
  const asleep = powerApi.isSleeping();
  if (asleep) { broadcast(JSON.stringify({ type: 'handoff', phase: 'wake', id })); powerApi.wakeNow(); } // page keeps the black veil up until the bloom
  const screens = [...wss.clients].filter(c => c.readyState === 1).length;
  const moving = transferHere().catch(e => { console.error('handoff:', e.message); return null; }); // audio starts while the monitor wakes
  if (asleep) await sleepMs(1500);                                                                     // let the monitor come back before the bloom
  broadcast(JSON.stringify({ type: 'handoff', phase: 'start', id, woke: asleep }));
  const how = await moving;
  broadcast(JSON.stringify({ type: 'handoff', phase: 'done', id, ok: !!how, how, from }));
  reply({ ok: !!how, how, from, woke: asleep, screens });
}

/* ---------- Music video lookup (YouTube Data API, cached) ---------- */
const VID_FILE = path.join(CFG.dataDir, 'video-cache.json');
const vids = readJson(VID_FILE, {});
async function videoLookup(res, url) {
  const q = (url.searchParams.get('q') || '').slice(0, 160);
  if (!q) return json(res, 400, { error: 'q required' });
  if (vids[q]) return json(res, 200, vids[q]);
  if (CFG.demo) return json(res, 200, { id: 'dQw4w9WgXcQ', title: 'Demo video' });
  if (!CFG.ytKey) return json(res, 200, { error: 'no_key' });
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.search = new URLSearchParams({ part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '5', q: q + ' official music video', key: CFG.ytKey });
  const r = await fetch(u); const j = await r.json();
  if (!r.ok) return json(res, 200, { error: 'yt_error', detail: j.error?.message });
  const pick = (j.items || []).find(i => /official/i.test(i.snippet.title)) || (j.items || [])[0];
  if (!pick) return json(res, 200, { error: 'none' });
  const out = { id: pick.id.videoId, title: pick.snippet.title };
  vids[q] = out; writeJson(VID_FILE, vids);
  json(res, 200, out);
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const org = req.headers.origin;
  if (org) { // cross-origin browser request (the hosted companion app)
    let same = false; try { same = new URL(org).host === req.headers.host; } catch {}
    if (!same) {
      const api = url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/');
      if (!allowedOrigins().includes(org)) { if (api) return json(res, 403, { error: 'origin not allowed' }); }
      else {
        res.setHeader('Access-Control-Allow-Origin', org); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Dash, X-Token');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Private-Network', 'true'); res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        if (api && !tokenValid(req)) return json(res, 401, { error: 'token required' });
      }
    }
  }
  try {
    if (url.pathname === '/auth/login') return authLogin(req, res);
    if (url.pathname === '/auth/callback') return authCallback(req, res, url);
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, {}); tok = null; try { fs.unlinkSync(TOKEN_FILE); } catch {} return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/exit' && req.method === 'POST') {
      // Close the kiosk browser. Only from the Pi's own screen (loopback), same-origin, custom header.
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!local || req.headers['x-dash'] !== '1' || !sameOrigin(req)) return json(res, 403, { error: 'local only' });
      spawn('pkill', ['-f', `chromium.*127.0.0.1:${CFG.port}`], { stdio: 'ignore', detached: true }).unref();
      return json(res, 200, { ok: true });
    }
    if (await homeApi(req, res, url)) return;
    if (await powerApi(req, res, url)) return;
    if (url.pathname === '/api/handoff' && ['GET', 'POST'].includes(req.method)) return handoff(req, res, url);
    if (url.pathname === '/api/status') return json(res, 200, { local: ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress), loggedIn: CFG.demo || !!(await accessToken()), clientIdSet: !!CFG.clientId, ytKey: CFG.demo || !!CFG.ytKey, demo: CFG.demo, redirect: REDIRECT, bound: CFG.host, port: CFG.port, lan: Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address) });
    if (url.pathname === '/api/volume' && ['GET', 'POST'].includes(req.method)) return volumeApi(req, res);
    if (url.pathname === '/api/pins') return pinsApi(req, res);
    if (url.pathname === '/api/oembed') return oembed(res, url);
    if (url.pathname === '/api/recent') return recentMap(res);
    if (url.pathname === '/api/played' && req.method === 'POST') return notePlayed(req, res);
    if (url.pathname === '/api/video') return videoLookup(res, url);
    if (url.pathname === '/api/play-from' && req.method === 'POST') return playFrom(req, res);
    if (url.pathname === '/api/handback' && req.method === 'POST') return handBack(req, res);
    if (url.pathname.startsWith('/api/spotify/')) return spotifyProxy(req, res, url, url.pathname.slice('/api/spotify/'.length));
    // static
    let p = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
    if (!p.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      // The NFC handoff animation lives in its own file; load it after the page's own script (index.html itself is untouched).
      if (p === path.join(PUB, 'index.html')) data = Buffer.from(data.toString('utf8').replace('</body>', '<script src="/handoff.js"></script>\n</body>'));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end(); }
});

const homeApi = require('./home')({ CFG, json, readJson, writeJson, sameOrigin });
const powerApi = require('./power')({ CFG, json, readJson, writeJson, sameOrigin, getConf: homeApi.getConf });
confGet = homeApi.getConf;

/* ---------- Soloist bridge ---------- */
const CMDS = {
  get_auth_state: [], get_state: [], get_queue: ['limit?:n'],
  play: ['uri?:uri'], pause: [], skip_next: [], skip_prev: [],
  seek: ['position_ms:n'], set_volume: ['volume:n'], set_shuffle: ['enabled:b'],
  set_repeat_context: ['enabled:b'], set_repeat_track: ['enabled:b'],
  add_to_queue: ['uri:uri'], activate: [], deactivate: [],
};
const URI_RE = /^spotify:(track|album|playlist|episode|show):[A-Za-z0-9]+$/;
function sanitize(m) {
  if (!m || m.type !== 'command' || !(m.command in CMDS)) return null;
  const out = { type: 'command', command: m.command };
  for (const spec of CMDS[m.command]) {
    const [k0, t] = spec.split(':'); const opt = k0.endsWith('?'); const k = k0.replace('?', '');
    const v = m[k];
    if (v === undefined) { if (opt) continue; return null; }
    if (t === 'n') { if (typeof v !== 'number' || !isFinite(v) || v < 0) return null; out[k] = k === 'volume' ? Math.min(100, Math.round(v)) : Math.round(v); }
    else if (t === 'b') { if (typeof v !== 'boolean') return null; out[k] = v; }
    else if (t === 'uri') { if (typeof v !== 'string' || !URI_RE.test(v)) return null; out[k] = v; }
  }
  return out;
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !sameOrigin(req)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws));
});
const broadcast = (s) => wss.clients.forEach(c => c.readyState === 1 && c.send(s));
const bridge = (connected) => JSON.stringify({ type: 'bridge', connected });

let up = null, upOpen = false, normalised = false;
function connectUp() {
  up = new WebSocket(CFG.soloistWs);
  up.on('open', () => { upOpen = true; broadcast(bridge(true)); queryAll(); });
  up.on('message', d => {
    const txt = d.toString(); broadcast(txt); trackSoloist(txt);
    if (!normalised && !CFG.demo) { try { const m = JSON.parse(txt); if (m.type === 'auth_state' && m.logged_in) { normalised = true; up.send(JSON.stringify({ type: 'command', command: 'set_volume', volume: 100 })); } } catch {} }
  });
  up.on('close', () => { upOpen = false; pb.status = 'idle'; pb.active = false; broadcast(bridge(false)); setTimeout(connectUp, 2000); });
  up.on('error', () => {});
}
function queryAll() {
  if (!upOpen) return;
  for (const c of [{ command: 'get_auth_state' }, { command: 'get_state' }, { command: 'get_queue', limit: 25 }])
    up.send(JSON.stringify({ type: 'command', ...c }));
}
wss.on('connection', ws => {
  ws.send(bridge(upOpen)); queryAll();
  ws.on('message', d => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    const s = sanitize(m);
    if (!s) return ws.send(JSON.stringify({ type: 'error', message: 'rejected command' }));
    if (!upOpen) return ws.send(JSON.stringify({ type: 'error', message: 'Soloist is not running' }));
    up.send(JSON.stringify(s));
  });
});
connectUp();

server.listen(CFG.port, CFG.host, () => console.log(`dashboard on http://${CFG.host}:${CFG.port}  soloist=${CFG.soloistWs}${CFG.demo ? '  [DEMO]' : ''}`));

/* ---------- LAN trigger port: the only thing reachable from the Wi-Fi without Tailscale ---------- */
// The dashboard itself stays on localhost (Soloist's socket and the setup pages have no auth). This second listener
// answers just the endpoints a phone shortcut or NFC tag needs; every other path is a 404, so nothing else is exposed.
if (CFG.triggerPort) {
  const LAN_OK = new Set(['/api/sleep', '/api/wake', '/api/power', '/api/handoff']);
  const lan = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/ping') return json(res, 200, { ok: true, name: CFG.deviceName });
      if (!LAN_OK.has(url.pathname)) return json(res, 404, { error: 'not found' });
      if (url.pathname === '/api/handoff' && ['GET', 'POST'].includes(req.method)) return await handoff(req, res, url);
      if (url.pathname !== '/api/handoff' && await powerApi(req, res, url)) return;
      json(res, 405, { error: 'method not allowed' });
    } catch (e) { console.error('lan:', e); if (!res.headersSent) json(res, 500, { error: 'error' }); else res.end(); }
  });
  lan.requestTimeout = 15000; lan.headersTimeout = 10000;
  lan.on('error', e => console.error(`trigger port ${CFG.triggerPort} unavailable: ${e.code || e.message}. Sleep/handoff only work on the main port until fixed.`));
  lan.listen(CFG.triggerPort, CFG.triggerHost, () => console.log(`trigger port on http://${CFG.triggerHost}:${CFG.triggerPort}  (sleep, wake, power, handoff only)`));
}
