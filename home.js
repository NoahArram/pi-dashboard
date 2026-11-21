'use strict';
// Home-page back end: config store, photos, weather (Open-Meteo / Met Office models), calendars (ICS), Todoist.
const fs = require('fs'), path = require('path');
let ical = null; try { ical = require('node-ical'); } catch { console.error('node-ical is not installed: calendars are disabled until you run npm install in the dashboard folder'); }

module.exports = function init({ CFG, json, readJson, writeJson, sameOrigin }) {
  const CONF = path.join(CFG.dataDir, 'config.json');
  const PHOTOS = path.join(CFG.dataDir, 'photos'), ORIG = path.join(CFG.dataDir, 'originals'), THUMB = path.join(CFG.dataDir, 'thumbs');
  fs.mkdirSync(PHOTOS, { recursive: true, mode: 0o755 });
  const DEF = { location: null, calendars: [], todoistToken: '', saver: { photoMin: 5, idleMin: 3 }, weatherModel: 'ukmo_seamless', alarm: { enabled: true, delayMin: 15, volume: 70, autoOffMin: 2 }, defaultWake: '07:00', apiToken: '', corsOrigins: [] };
  let conf = { ...DEF, ...readJson(CONF, {}) }; conf.alarm = { ...DEF.alarm, ...conf.alarm }; conf.saver = { ...DEF.saver, ...conf.saver };
  const save = () => writeJson(CONF, conf);
  const guard = (req, res) => { if (req.headers['x-dash'] !== '1' || !sameOrigin(req)) { json(res, 403, { error: 'bad origin' }); return false; } return true; };
  const body = async (req, max) => { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > max) return null; ch.push(c); } return Buffer.concat(ch); };
  const pub = () => ({ location: conf.location, calendars: conf.calendars.map(({ id, name, color }) => ({ id, name, color })), todoist: !!conf.todoistToken || CFG.demo, saver: conf.saver, weatherModel: conf.weatherModel, alarm: conf.alarm, defaultWake: conf.defaultWake, tokenSet: !!conf.apiToken, corsOrigins: conf.corsOrigins });
  const cache = new Map(); // key -> { at, v }
  const clearCal = () => { for (const k of cache.keys()) if (k.startsWith('cal:')) cache.delete(k); };
  const cached = async (key, ttl, fn) => { const c = cache.get(key); if (c && Date.now() - c.at < ttl) return c.v; const v = await fn(); cache.set(key, { at: Date.now(), v }); return v; };
  const get = async (url, opt = {}) => { const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'pi-dashboard', ...(opt.headers || {}) } }); return r; };

  /* ---------- weather ---------- */
  const demoWeather = () => {
    const now = new Date(), h = []; const base = new Date(now); base.setMinutes(0, 0, 0);
    const pad = n => String(n).padStart(2, '0'), iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    for (let i = 0; i < 48; i++) { const d = new Date(+base + i * 36e5); h.push({ t: iso(d), temp: Math.round(8 + 5 * Math.sin((d.getHours() - 9) / 24 * 6.28)), pop: [0, 10, 40, 70, 20][i % 5], mm: 0, code: [3, 3, 61, 80, 2][i % 5], day: d.getHours() >= 7 && d.getHours() < 17 ? 1 : 0 }); }
    const days = []; for (let i = 0; i < 6; i++) { const d = new Date(+base + i * 864e5); days.push({ date: iso(d).slice(0, 10), code: [3, 61, 2, 0, 95, 71][i], hi: 11 - i, lo: 4 - i, pop: [20, 80, 10, 0, 60, 40][i], mm: i === 1 ? 4.2 : 0, sunrise: iso(new Date(+d.setHours(7, 24))), sunset: iso(new Date(+d.setHours(16, 12))) }); }
    return { current: { temp: 9, feels: 6, humidity: 82, code: 3, day: 1, mm: 0, wind: 14, gust: 26, dir: 230, time: iso(now) }, hourly: h, daily: days };
  };
  async function weather() {
    if (!conf.location) return { error: 'no_location' };
    if (CFG.demo) return { location: conf.location, ...demoWeather(), source: 'demo' };
    const { lat, lon } = conf.location;
    return cached('wx:' + lat + ',' + lon + conf.weatherModel, 10 * 60e3, async () => {
      const q = new URLSearchParams({
        latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '6', wind_speed_unit: 'mph', temperature_unit: 'celsius',
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
        hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset',
      });
      if (conf.weatherModel) q.set('models', conf.weatherModel);
      const r = await get('https://api.open-meteo.com/v1/forecast?' + q);
      if (!r.ok) throw new Error('weather ' + r.status);
      const j = await r.json(), c = j.current || {}, h = j.hourly || {}, d = j.daily || {};
      return {
        location: conf.location, source: 'Open-Meteo' + (conf.weatherModel ? ' · ' + conf.weatherModel : ''),
        current: { temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, code: c.weather_code, day: c.is_day, mm: c.precipitation, wind: c.wind_speed_10m, gust: c.wind_gusts_10m, dir: c.wind_direction_10m, time: c.time },
        hourly: (h.time || []).map((t, i) => ({ t, temp: h.temperature_2m?.[i], pop: h.precipitation_probability?.[i] ?? null, mm: h.precipitation?.[i], code: h.weather_code?.[i], day: h.is_day?.[i] })),
        daily: (d.time || []).map((t, i) => ({ date: t, code: d.weather_code?.[i], hi: d.temperature_2m_max?.[i], lo: d.temperature_2m_min?.[i], pop: d.precipitation_probability_max?.[i] ?? null, mm: d.precipitation_sum?.[i], sunrise: d.sunrise?.[i], sunset: d.sunset?.[i] })),
      };
    });
  }
  async function geocode(q) {
    if (CFG.demo) return [{ name: 'Birmingham', admin1: 'England', country: 'United Kingdom', lat: 52.4814, lon: -1.8998 }, { name: 'London', admin1: 'England', country: 'United Kingdom', lat: 51.5085, lon: -0.1257 }].filter(x => x.name.toLowerCase().includes(q.toLowerCase()));
    const r = await get('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('geocode ' + r.status);
    return ((await r.json()).results || []).map(x => ({ name: x.name, admin1: x.admin1 || '', country: x.country || '', lat: x.latitude, lon: x.longitude }));
  }

  /* ---------- calendars (ICS feeds: Google "secret address in iCal format", Outlook "publish calendar") ---------- */
  const txt = v => (v && typeof v === 'object' ? v.val : v) || '';
  async function loadCal(c, from, to) {
    if (!ical) throw new Error('run npm install on the Pi');
    const r = await get(c.url.replace(/^webcal:/i, 'https:')); if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.text(); if (raw.length > 8e6) throw new Error('feed too large');
    const data = await ical.async.parseICS(raw), out = [];
    for (const ev of Object.values(data)) {
      if (!ev || ev.type !== 'VEVENT' || !ev.start || /cancel/i.test(ev.status || '')) continue;
      const allDay = ev.datetype === 'date', s0 = new Date(ev.start), dur = (ev.end ? +new Date(ev.end) : +s0 + (allDay ? 864e5 : 0)) - +s0;
      const push = (s, e, src) => out.push({ cal: c.id, title: String(txt(src.summary) || '(no title)').slice(0, 140), start: s.toISOString(), end: e.toISOString(), allDay, location: String(txt(src.location) || '').slice(0, 100) });
      if (ev.rrule) {
        for (const d of ev.rrule.between(new Date(+from - dur), to, true)) {
          if (ev.exdate && Object.values(ev.exdate).some(x => +new Date(x) === +d)) continue;
          const o = ev.recurrences?.[d.toISOString().slice(0, 10)];
          if (o && o.start) push(new Date(o.start), new Date(o.end || +new Date(o.start) + dur), o); else push(d, new Date(+d + dur), ev);
        }
      } else if (+new Date(ev.end || ev.start) > +from && +s0 < +to) push(s0, new Date(+s0 + dur), ev);
    }
    return out;
  }
  async function calendar(q = {}) {
    if (CFG.demo) {
      const t = new Date(); t.setMinutes(0, 0, 0); const at = (dh, len, title, cal, allDay = false, loc = '') => { const s = new Date(+t + dh * 36e5), e = new Date(+s + len * 36e5); return { cal, title, start: s.toISOString(), end: e.toISOString(), allDay, location: loc }; };
      const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      const base = [at(-1, 1, 'Stand-up', 'work', false, 'Teams'), at(1, 1, 'FYP supervisor meeting', 'uni', false, 'Strathcona 215'), at(3, 2, 'Lecture: Security of Real World Systems', 'uni'), at(6, 1, 'Dinner with family', 'home'), at(26, 1, 'Dentist', 'home'), { cal: 'home', title: 'Mum’s birthday', start: new Date(+d0 + 864e5).toISOString(), end: new Date(+d0 + 2 * 864e5).toISOString(), allDay: true, location: '' }]; // demo: repeat weekly so paging shows events in any window
      const f0 = new Date(); f0.setHours(0, 0, 0, 0); let fd = f0; if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { const [y, m, d] = q.from.split('-').map(Number); fd = new Date(y, m - 1, d); }
      const fr = +fd, tt = fr + (Math.min(31, +q.days || 14)) * 864e5, out = [];
      for (let w = -60; w <= 60; w++) for (const e of base) { const sh = w * 7 * 864e5, s2 = +new Date(e.start) + sh, e2 = +new Date(e.end) + sh; if (e2 > fr && s2 < tt) out.push({ ...e, start: new Date(s2).toISOString(), end: new Date(e2).toISOString() }); }
      return { events: out.sort((a, b) => a.start < b.start ? -1 : 1), errors: [] };
    }
    const from = new Date(); from.setHours(0, 0, 0, 0);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { const [y, m, d] = q.from.split('-').map(Number); const f = new Date(y, m - 1, d); if (!isNaN(f) && Math.abs(f - from) < 800 * 864e5) from.setTime(+f); }
    const days = Math.max(1, Math.min(31, +q.days || 14)), to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
    if ([...cache.keys()].length > 80) clearCal();
    const ck = 'cal:' + from.toDateString() + ':' + days;
    const out = await cached(ck, 5 * 60e3, async () => {
      const res = await Promise.allSettled(conf.calendars.map(c => loadCal(c, from, to)));
      const events = [], errors = [];
      res.forEach((r, i) => r.status === 'fulfilled' ? events.push(...r.value) : errors.push({ cal: conf.calendars[i].id, error: String(r.reason?.message || r.reason).slice(0, 120) }));
      events.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      return { events: events.slice(0, 400), errors };
    });
    if (out.errors?.length) { const c = cache.get(ck); if (c) c.at = Date.now() - 5 * 60e3 + 20e3; } // failed feeds: retry in 20 s, not 5 min
    return out;
  }

  /* ---------- Todoist (API v1, personal token) ---------- */
  const demoTasks = [{ id: 'd1', content: 'Reply to PwC onboarding email', priority: 4, due: 'today', overdue: false }, { id: 'd2', content: 'ICAEW CFAB: Accounting chapter 7 questions', priority: 3, due: 'today', overdue: false }, { id: 'd3', content: 'Book train to London', priority: 2, due: 'yesterday', overdue: true }, { id: 'd4', content: 'Water plants', priority: 1, due: 'today', overdue: false }];
  const TD = 'https://api.todoist.com/api/v1';
  async function todoist() {
    if (CFG.demo) return { tasks: demoTasks };
    if (!conf.todoistToken) return { error: 'no_token' };
    return cached('td', 30e3, async () => {
      const r = await get(TD + '/tasks/filter?limit=100&query=' + encodeURIComponent('today | overdue'), { headers: { Authorization: 'Bearer ' + conf.todoistToken } });
      if (r.status === 401 || r.status === 403) return { error: 'bad_token' };
      if (!r.ok) throw new Error('todoist ' + r.status);
      const j = await r.json(), list = Array.isArray(j) ? j : (j.results || j.items || []);
      const today = new Date().toLocaleDateString('en-CA');
      const tasks = list.filter(t => !t.checked && !t.is_completed).map(t => { const d = t.due?.date || ''; return { id: t.id, content: t.content, priority: t.priority || 1, due: t.due?.string || '', time: d.length > 10 ? d : '', overdue: !!d && d.slice(0, 10) < today, recurring: !!t.due?.is_recurring }; });
      tasks.sort((a, b) => (b.overdue - a.overdue) || (b.priority - a.priority) || String(a.time).localeCompare(String(b.time)));
      return { tasks };
    });
  }
  async function closeTask(id) {
    if (CFG.demo) { const i = demoTasks.findIndex(t => t.id === id); if (i >= 0) demoTasks.splice(i, 1); return true; }
    const r = await get(TD + '/tasks/' + encodeURIComponent(id) + '/close', { method: 'POST', headers: { Authorization: 'Bearer ' + conf.todoistToken } });
    cache.delete('td'); return r.ok || r.status === 204;
  }

  /* ---------- photos ---------- */
  const EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const sniff = b => b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') ? 'png' : (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') ? 'webp' : null;
  const OEXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', dng: 'image/x-adobe-dng' };
  const base = n => n.replace(/\.[a-z0-9]+$/, '');
  const origFile = n => { try { return fs.readdirSync(ORIG).find(f => base(f) === base(n)) || null; } catch { return null; } };
  const listPhotos = () => { let o = new Set(); try { o = new Set(fs.readdirSync(ORIG).map(base)); } catch {} return fs.readdirSync(PHOTOS).filter(f => /^[a-z0-9]+\.(jpg|png|webp)$/.test(f)).map(f => ({ n: f, t: fs.statSync(path.join(PHOTOS, f)).mtimeMs, o: o.has(base(f)) })).sort((a, b) => b.t - a.t); };
  const sendFile = (res, file, type, cache) => { fs.stat(file, (e, st) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache || 'public, max-age=86400' }); fs.createReadStream(file).pipe(res); }); };
  const streamTo = (req, file, max) => new Promise(resolve => { let n = 0, bad = false; const ws = fs.createWriteStream(file); req.on('data', c => { n += c.length; if (n > max && !bad) { bad = true; req.destroy(); ws.destroy(); } }); req.pipe(ws); ws.on('finish', () => resolve(bad ? 0 : n)); ws.on('error', () => resolve(0)); req.on('error', () => { ws.destroy(); resolve(0); }); req.on('close', () => { if (bad) resolve(0); }); });

  /* ---------- router ---------- */
  const handle = async function handle(req, res, url) {
    const p = url.pathname, m = req.method;
    try {
      if (p === '/api/config') {
        if (m === 'GET') return json(res, 200, pub()), true;
        if (m !== 'PUT' || !guard(req, res)) return true;
        const b = await body(req, 16384); let x; try { x = JSON.parse(b || '{}'); } catch { return json(res, 400, {}), true; }
        if (x.location === null) conf.location = null;
        else if (x.location && isFinite(x.location.lat) && isFinite(x.location.lon)) conf.location = { name: String(x.location.name || '').slice(0, 80), lat: +x.location.lat, lon: +x.location.lon };
        if (typeof x.todoistToken === 'string') { conf.todoistToken = x.todoistToken.trim().slice(0, 100); cache.delete('td'); }
        if (x.addCalendar) {
          const a = x.addCalendar, u = String(a.url || '').trim();
          if (!/^(https?|webcal):\/\//i.test(u)) return json(res, 400, { error: 'Calendar link must start with https:// or webcal://' }), true;
          if (conf.calendars.length >= 12) return json(res, 400, { error: 'Too many calendars' }), true;
          conf.calendars.push({ id: Math.random().toString(36).slice(2, 8), name: String(a.name || 'Calendar').slice(0, 40), url: u, color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#4da3ff' }); clearCal();
        }
        if (x.removeCalendar) { conf.calendars = conf.calendars.filter(c => c.id !== x.removeCalendar); clearCal(); }
        if (x.saver) { const ph = Math.round(+x.saver.photoMin), id = Math.round(+x.saver.idleMin); if (ph >= 1 && ph <= 120) conf.saver.photoMin = ph; if (id >= 1 && id <= 120) conf.saver.idleMin = id; }
        if (x.alarm) { const a = x.alarm; if (typeof a.enabled === 'boolean') conf.alarm.enabled = a.enabled; const dm = Math.round(+a.delayMin), v = Math.round(+a.volume); if (dm >= 0 && dm <= 120) conf.alarm.delayMin = dm; const ao = +a.autoOffMin; if (ao >= 0.5 && ao <= 60) conf.alarm.autoOffMin = ao; if (v >= 1 && v <= 100) conf.alarm.volume = v; }
        if (typeof x.defaultWake === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(x.defaultWake)) conf.defaultWake = x.defaultWake;
        if (Array.isArray(x.corsOrigins)) conf.corsOrigins = x.corsOrigins.slice(0, 10).map(o => { try { const u = new URL(String(o).trim()); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } }).filter(Boolean);
        if (typeof x.apiToken === 'string') conf.apiToken = x.apiToken.trim().slice(0, 100);
        if (typeof x.weatherModel === 'string' && /^[a-z0-9_]{0,40}$/.test(x.weatherModel)) { conf.weatherModel = x.weatherModel; cache.clear(); }
        if (x.location !== undefined) cache.clear();
        save(); return json(res, 200, pub()), true;
      }
      if (p === '/api/geocode' && m === 'GET') { const q = (url.searchParams.get('q') || '').trim().slice(0, 80); return json(res, 200, q.length < 2 ? [] : await geocode(q)), true; }
      if (p === '/api/weather' && m === 'GET') return json(res, 200, await weather()), true;
      if (p === '/api/calendar' && m === 'GET') return json(res, 200, await calendar(Object.fromEntries(url.searchParams))), true;
      if (p === '/api/todoist' && m === 'GET') return json(res, 200, await todoist()), true;
      if (p === '/api/todoist/close' && m === 'POST') {
        if (!guard(req, res)) return true;
        let x; try { x = JSON.parse((await body(req, 1024)) || '{}'); } catch { x = {}; }
        if (!/^[A-Za-z0-9_-]{2,40}$/.test(x.id || '')) return json(res, 400, {}), true;
        return json(res, (await closeTask(x.id)) ? 200 : 502, {}), true;
      }
      if (p === '/api/photos') {
        if (m === 'GET') return json(res, 200, listPhotos()), true;
        if (!guard(req, res)) return true;
        if (m === 'POST') {
          const b = await body(req, 80 << 20); if (!b) return json(res, 413, { error: 'too big' }), true;
          const ext = sniff(b); if (!ext) return json(res, 415, { error: 'JPEG, PNG or WebP only' }), true;
          try { if (fs.statfsSync(CFG.dataDir).bavail * fs.statfsSync(CFG.dataDir).bsize < 2e9) return json(res, 507, { error: 'Pi storage nearly full' }), true; } catch {}
          const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + '.' + ext;
          fs.writeFileSync(path.join(PHOTOS, name), b); return json(res, 200, { n: name }), true;
        }
        if (m === 'DELETE') { const n = url.searchParams.get('name') || ''; if (/^[a-z0-9]+\.(jpg|png|webp)$/.test(n)) { fs.rmSync(path.join(PHOTOS, n), { force: true }); fs.rmSync(path.join(THUMB, base(n) + '.jpg'), { force: true }); const o = origFile(n); if (o) fs.rmSync(path.join(ORIG, o), { force: true }); } return json(res, 200, {}), true; }
        return json(res, 405, {}), true;
      }
      // untouched original of a photo (stored next to the screen-size copy), streamed to disk
      if (p === '/api/photos/original' && m === 'POST') {
        if (!guard(req, res)) return true;
        const n = url.searchParams.get('name') || '', ext = (url.searchParams.get('ext') || '').toLowerCase();
        if (!/^[a-z0-9]+\.(jpg|png|webp)$/.test(n) || !fs.existsSync(path.join(PHOTOS, n))) return json(res, 404, { error: 'unknown photo' }), true;
        if (!OEXT[ext]) return json(res, 415, { error: 'unsupported original format' }), true;
        fs.mkdirSync(ORIG, { recursive: true }); const old = origFile(n); if (old) fs.rmSync(path.join(ORIG, old), { force: true });
        const dest = path.join(ORIG, base(n) + '.' + ext), size = await streamTo(req, dest, 1 << 30);
        if (!size) { fs.rmSync(dest, { force: true }); return json(res, 413, { error: 'original too big or upload failed' }), true; }
        return json(res, 200, { ok: true, bytes: size }), true;
      }
      if (p === '/api/photos/thumb' && m === 'POST') {
        if (!guard(req, res)) return true;
        const n = url.searchParams.get('name') || ''; if (!/^[a-z0-9]+\.(jpg|png|webp)$/.test(n) || !fs.existsSync(path.join(PHOTOS, n))) return json(res, 404, {}), true;
        const b = await body(req, 2 << 20); if (!b || sniff(b) !== 'jpg') return json(res, 415, {}), true;
        fs.mkdirSync(THUMB, { recursive: true }); fs.writeFileSync(path.join(THUMB, base(n) + '.jpg'), b); return json(res, 200, { ok: true }), true;
      }
      if (p.startsWith('/photos/') && m === 'GET') {
        let kind = 'img', n = p.slice(8); const mm = n.match(/^(original|thumb)\/(.+)$/); if (mm) { kind = mm[1]; n = mm[2]; }
        if (!/^[a-z0-9]+\.(jpg|png|webp)$/.test(n)) { res.writeHead(404); res.end(); return true; }
        if (kind === 'original') { const o = origFile(n); if (o) sendFile(res, path.join(ORIG, o), OEXT[o.split('.').pop()] || 'application/octet-stream'); else sendFile(res, path.join(PHOTOS, n), EXT[n.split('.')[1]]); return true; }
        if (kind === 'thumb') { const t = path.join(THUMB, base(n) + '.jpg'); sendFile(res, fs.existsSync(t) ? t : path.join(PHOTOS, n), fs.existsSync(t) ? 'image/jpeg' : EXT[n.split('.')[1]]); return true; }
        sendFile(res, path.join(PHOTOS, n), EXT[n.split('.')[1]]); return true;
      }
    } catch (e) { console.error(p, e.message); if (!res.headersSent) json(res, 502, { error: String(e.message || e).slice(0, 120) }); return true; }
    return false;
  };
  handle.getConf = () => conf;
  return handle;
};
