'use strict';
// Sleep/wake schedule, alarm state and display power. Driven by an HTTP API so an iOS Shortcut can call it.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');

module.exports = function init({ CFG, json, readJson, writeJson, sameOrigin, getConf }) {
  const STATE = path.join(CFG.dataDir, 'state.json');
  let st = { sleeping: false, until: null, alarmAt: null, alarmActive: false, ...readJson(STATE, {}) };
  const save = () => writeJson(STATE, st);
  const timers = {};
  const arm = (slot, ts, fn) => { clearTimeout(timers[slot]); const d = ts - Date.now(); timers[slot] = setTimeout(() => (d > 2 ** 30 ? arm(slot, ts, fn) : fn()), Math.min(Math.max(d, 0), 2 ** 30)); };
  const disarm = slot => clearTimeout(timers[slot]);

  /* ---------- display power ---------- */
  const run = (cmd, args, env) => new Promise(ok => execFile(cmd, args, { timeout: 6000, env: { ...process.env, ...env } }, (e, so) => ok({ e, so: String(so || '') })));
  function dispEnv() {
    const uid = process.getuid ? process.getuid() : 1000, dir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`, env = { XDG_RUNTIME_DIR: dir };
    try { const w = fs.readdirSync(dir).filter(f => /^wayland-\d+$/.test(f)).sort(); if (w.length) env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || w[0]; } catch {}
    try { if (fs.readdirSync('/tmp/.X11-unix').includes('X0')) { env.DISPLAY = process.env.DISPLAY || ':0'; env.XAUTHORITY = process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority'); } } catch {}
    return env;
  }
  // Tries, in order: your own command (DISPLAY_OFF_CMD / DISPLAY_ON_CMD), wlr-randr (Wayland), xset dpms (X11), the official Pi display's backlight.
  async function displayPower(on) {
    const custom = on ? process.env.DISPLAY_ON_CMD : process.env.DISPLAY_OFF_CMD;
    if (custom) { const r = await run('sh', ['-c', custom]); return r.e ? 'custom-failed' : 'custom'; }
    const env = dispEnv();
    if (env.WAYLAND_DISPLAY) {
      const l = await run('wlr-randr', [], env);
      if (!l.e) { let ok = false; for (const o of l.so.split('\n').filter(x => x && !/^\s/.test(x)).map(x => x.split(' ')[0])) { const r = await run('wlr-randr', ['--output', o, on ? '--on' : '--off'], env); if (!r.e) ok = true; } if (ok) return 'wlr-randr'; }
    }
    if (env.DISPLAY) { const r = await run('xset', ['dpms', 'force', on ? 'on' : 'off'], env); if (!r.e) return 'xset'; }
    try { let ok = false; for (const d of fs.readdirSync('/sys/class/backlight')) { try { fs.writeFileSync(`/sys/class/backlight/${d}/bl_power`, on ? '0' : '1'); ok = true; } catch {} } if (ok) return 'backlight'; } catch {}
    return 'none';
  }

  /* ---------- date parsing (made for what iOS Shortcuts sends) ---------- */
  const fmt = ts => new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  function nextTime(h, m, now) { const d = new Date(now); d.setHours(h, m, 0, 0); if (+d <= now + 10e3) d.setDate(d.getDate() + 1); return +d; }
  // Accepts: ISO 8601 with offset or Z (what Shortcuts' "ISO 8601" Format Date gives, e.g. 2026-11-22T07:00:00+00:00), the same without an offset
  // (read as the Pi's local time), "2026-11-22 07:00", date-only (uses your default wake time), time-only ("07:00", "7:00 am": next occurrence),
  // Unix seconds or milliseconds, and Shortcuts' medium/long text ("22 Nov 2026 at 07:00").
  function parseWake(v, now, defWake) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number' || /^\d{9,13}(\.\d+)?$/.test(String(v).trim())) { const n = +v; return n > 1e11 ? n : n * 1000; }
    const s = String(v).trim().replace(/[  ]/g, ' ').replace(/(\d{2}:\d{2}(?::\d{2})?)\s(\d{2}:?\d{2})$/, '$1+$2'); // a '+' in an un-encoded form body arrives as a space
    let m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
    if (m) { let h = +m[1]; const mi = +m[2], ap = (m[3] || '').toLowerCase(); if (ap.startsWith('p') && h < 12) h += 12; if (ap.startsWith('a') && h === 12) h = 0; if (h > 23 || mi > 59) return NaN; return nextTime(h, mi, now); }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) { const [h, mi] = (defWake || '07:00').split(':').map(Number); return +new Date(+m[1], +m[2] - 1, +m[3], h, mi, 0); }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/); // no offset: Pi local time
    if (m) return +new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    let t = Date.parse(s); if (isNaN(t)) t = Date.parse(s.replace(/\s+at\s+/i, ' ').replace(/,/g, ''));
    return t;
  }
  const falsy = v => v === false || /^(false|0|no|off|skip)$/i.test(String(v ?? '').trim());

  /* ---------- state machine ---------- */
  function schedule() {
    disarm('wake'); disarm('alarm');
    if (st.sleeping && st.until) arm('wake', st.until, wake);
    if (st.alarmAt && !st.alarmActive) arm('alarm', st.alarmAt, fireAlarm);
  }
  function wake() { disarm('off'); st.sleeping = false; st.until = null; save(); displayPower(true).then(r => console.log('display on via', r)); }
  const autoOffMs = () => Math.max(0.2, Number.isFinite(+getConf().alarm?.autoOffMin) ? +getConf().alarm.autoOffMin : 2) * 60e3;
  function endAlarm() { disarm('alarmEnd'); st.alarmActive = false; st.alarmAt = null; st.alarmStarted = null; save(); }
  function fireAlarm() { st.alarmActive = true; st.alarmStarted = Date.now(); save(); arm('alarmEnd', st.alarmStarted + autoOffMs(), endAlarm); }
  function sleep(wakeTs, alarm) {
    const c = getConf(), a = c.alarm || {};
    st.sleeping = true; st.until = wakeTs; st.alarmActive = false;
    st.alarmAt = (a.enabled !== false && alarm !== false) ? wakeTs + Math.max(0, Number.isFinite(+a.delayMin) ? +a.delayMin : 15) * 60e3 : null;
    save(); schedule();
    disarm('off'); timers.off = setTimeout(() => displayPower(false).then(r => console.log('display off via', r)), 4000); // lets the UI go black first
  }
  if (st.sleeping) { if (!st.until || st.until <= Date.now()) wake(); else displayPower(false); }
  if (st.alarmAt && !st.alarmActive && st.alarmAt <= Date.now()) { if (Date.now() - st.alarmAt < 30 * 60e3) fireAlarm(); else { st.alarmAt = null; save(); } }
  if (st.alarmActive) { if (st.alarmStarted && st.alarmStarted + autoOffMs() > Date.now()) arm('alarmEnd', st.alarmStarted + autoOffMs(), endAlarm); else endAlarm(); }
  schedule();

  /* ---------- http ---------- */
  const view = () => ({ sleeping: st.sleeping, until: st.until, alarmAt: st.alarmAt, alarmActive: st.alarmActive, now: Date.now() });
  const tokenOk = (req, url) => { const t = getConf().apiToken; if (!t) return true; const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); return [h, req.headers['x-token'], url.searchParams.get('token')].includes(t); };
  async function readInput(req, url) {
    const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > 8192) break; ch.push(c); }
    const raw = Buffer.concat(ch).toString('utf8').trim(), ct = (req.headers['content-type'] || '').toLowerCase(), o = Object.fromEntries(url.searchParams);
    if (raw) {
      if (ct.includes('json') || /^[{[]/.test(raw)) { try { const j = JSON.parse(raw); if (j && typeof j === 'object' && !Array.isArray(j)) Object.assign(o, j); else o.wake = j; } catch { o.wake = raw; } }
      else if (ct.includes('x-www-form-urlencoded') || /^\w+=/.test(raw)) Object.assign(o, Object.fromEntries(new URLSearchParams(raw)));
      else o.wake = raw.replace(/^"|"$/g, '');
    }
    return o;
  }
  handle.wakeNow = wake;                 // used by /api/handoff to bring the screen back
  handle.isSleeping = () => st.sleeping;
  handle.tokenOk = tokenOk;
  return handle;
  async function handle(req, res, url) {
    const p = url.pathname, m = req.method;
    if (!['/api/power', '/api/sleep', '/api/wake', '/api/alarm/dismiss', '/api/alarm/test'].includes(p)) return false;
    try {
      if (p === '/api/power' && m === 'GET') return json(res, 200, view()), true;
      if (m !== 'POST') return json(res, 405, { error: 'use POST' }), true;
      if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' }), true;
      if (p.startsWith('/api/alarm/')) {
        if (req.headers['x-dash'] !== '1') return json(res, 403, { error: 'bad origin' }), true;
        if (p.endsWith('dismiss')) { disarm('alarm'); endAlarm(); } else fireAlarm();
        return json(res, 200, view()), true;
      }
      if (!tokenOk(req, url)) return json(res, 401, { error: 'bad or missing token' }), true;
      if (p === '/api/wake') { wake(); return json(res, 200, { ok: true, ...view() }), true; }
      const inp = await readInput(req, url), now = Date.now(), c = getConf();
      const raw = inp.wake ?? inp.wake_at ?? inp.wakeAt ?? inp.time ?? inp.datetime ?? inp.date ?? inp.until;
      let ts;
      if (raw === undefined && inp.minutes !== undefined) ts = now + Math.round(+inp.minutes) * 60e3;
      else if (raw === undefined) ts = nextTime(...(c.defaultWake || '07:00').split(':').map(Number), now);
      else ts = parseWake(raw, now, c.defaultWake);
      if (!isFinite(ts)) return json(res, 400, { error: `Couldn't read "${String(raw).slice(0, 60)}" as a date and time. Use ISO 8601 like 2026-11-22T07:00:00+00:00, or just 07:00.` }), true;
      if (ts < now + 20e3) return json(res, 400, { error: 'Wake time is in the past', got: new Date(ts).toISOString() }), true;
      if (ts > now + 48 * 3600e3) return json(res, 400, { error: 'Wake time is more than 48 hours away', got: new Date(ts).toISOString() }), true;
      sleep(ts, 'alarm' in inp ? !falsy(inp.alarm) : undefined);
      return json(res, 200, { ok: true, sleeping: true, wake: new Date(ts).toISOString(), wakeLocal: fmt(ts), alarm: st.alarmAt ? new Date(st.alarmAt).toISOString() : null, alarmLocal: st.alarmAt ? fmt(st.alarmAt) : null }), true;
    } catch (e) { console.error(p, e.message); if (!res.headersSent) json(res, 500, { error: String(e.message).slice(0, 100) }); return true; }
  }
};
