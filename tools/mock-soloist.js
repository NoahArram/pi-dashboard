'use strict';
// Minimal stand-in for Spotify Soloist's WebSocket API, for developing without a Pi.
// Implements the documented commands/events: auth_state, playback_state, position_sync,
// track_changed, playback_changed, volume_changed, options_changed, queue_changed.
const { WebSocketServer } = require('ws');
const D = require('./demo-data');
const PORT = +process.env.MOCK_PORT || 9090;
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

const ent = t => ({
  uri: t.uri, entity_type: t.isEpisode ? 'episode' : 'track',
  decorations: {
    identity: { name: t.name },
    visual_identity: { cover: t.album.images.length ? [{ url: t.album.images[0].url, size: 'large' }] : [] },
    parent: { entity: { uri: t.album.uri, entity_type: 'album', decorations: { identity: { name: t.album.name } } } },
    creators: t.artists.map(a => ({ entity: { uri: a.uri, entity_type: 'artist', decorations: { identity: { name: a.name } } } })),
    playback: { duration_ms: t.duration_ms, content_ratings: [] },
  },
});
let list = D.allTracks(), idx = 0, status = 'paused', pos = 0, anchor = Date.now(), volume = 60;
let opts = { shuffle: false, repeat: 'off', playback_speed: 1, modes: {} };
let ctx = { uri: 'spotify:playlist:demo1', entity_type: 'playlist', decorations: { identity: { name: 'Late Night Drive' } } };
const now = () => pos + (status === 'playing' ? Date.now() - anchor : 0);
const posObj = () => ({ position_ms: Math.round(now()), timestamp_ms: Date.now(), speed: status === 'playing' ? 1 : 0 });
let active = process.env.IDLE !== '1';
const snap = () => ({ type: 'playback_state', status, item: ent(list[idx]), context: ctx, position: posObj(), volume, is_active: active, options: opts, available_actions: { pause: {}, seek: {} } });
const queue = () => ({ type: 'queue_changed', previous: list.slice(0, idx).reverse().slice(0, 10).map(t => ({ uid: t.uri, source: 'context', item: ent(t) })), upcoming: list.slice(idx + 1, idx + 11).map(t => ({ uid: t.uri, source: 'context', item: ent(t) })) });
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const all = o => wss.clients.forEach(c => send(c, o));
function setTrack(i) { idx = (i + list.length) % list.length; pos = 0; anchor = Date.now(); all({ type: 'track_changed', item: ent(list[idx]) }); all({ type: 'position_sync', position: posObj() }); all(queue()); }
setInterval(() => { if (status === 'playing' && now() >= list[idx].duration_ms) setTrack(idx + 1); }, 500);

wss.on('connection', ws => {
  send(ws, { type: 'auth_state', logged_in: process.env.UNPAIRED !== '1', is_active: active, device_name: 'Pi' });
  send(ws, snap());
  ws.on('message', d => {
    const m = JSON.parse(d); if (m.type !== 'command') return send(ws, { type: 'error', message: 'bad type' });
    const ok = () => send(ws, { type: 'command_result', command: m.command });
    switch (m.command) {
      case 'get_auth_state': return send(ws, { type: 'auth_state', logged_in: true, is_active: active, device_name: 'Pi' });
      case 'get_state': return send(ws, snap());
      case 'get_queue': return send(ws, queue());
      case 'play': {
        if (m.uri) {
          const g = D.tracksFor(m.uri); if (g.length) { list = g; ctx = m.uri.startsWith('spotify:episode:') ? { uri: g[0].album.uri, entity_type: 'show', decorations: { identity: { name: g[0].album.name } } } : { uri: m.uri, entity_type: m.uri.split(':')[1], decorations: { identity: { name: D.nameFor(m.uri) } } }; all({ type: 'context_changed', context: ctx }); idx = Math.max(0, g.findIndex(t => t.uri === m.uri)); setTrack(idx); }
        }
        pos = now(); anchor = Date.now(); status = 'playing'; all({ type: 'playback_changed', status }); all({ type: 'position_sync', position: posObj() }); return ok();
      }
      case 'pause': pos = now(); status = 'paused'; all({ type: 'playback_changed', status }); all({ type: 'position_sync', position: posObj() }); return ok();
      case 'skip_next': setTrack(idx + 1); return ok();
      case 'skip_prev': if (now() > 3000) setTrack(idx); else setTrack(idx - 1); return ok();
      case 'seek': pos = m.position_ms; anchor = Date.now(); all({ type: 'position_sync', position: posObj() }); return ok();
      case 'set_volume': volume = m.volume; all({ type: 'volume_changed', volume }); return ok();
      case 'set_shuffle': opts = { ...opts, shuffle: m.enabled }; all({ type: 'options_changed', options: opts }); return ok();
      case 'set_repeat_context': if (m.enabled) opts = { ...opts, repeat: 'context' }; else if (opts.repeat === 'context') opts = { ...opts, repeat: 'off' }; all({ type: 'options_changed', options: opts }); return ok();
      case 'set_repeat_track': if (m.enabled) opts = { ...opts, repeat: 'track' }; else if (opts.repeat === 'track') opts = { ...opts, repeat: 'off' }; all({ type: 'options_changed', options: opts }); return ok();
      case 'add_to_queue': { const t = D.allTracks().find(x => x.uri === m.uri); if (t) { list.splice(idx + 1, 0, t); all(queue()); } return ok(); }
      case 'deactivate': active = false; all({ type: 'device_changed', is_active: false, device_name: 'Pi' }); return ok();
      case 'activate': active = true; all({ type: 'device_changed', is_active: true, device_name: 'Pi' }); return ok();
      default: return ok();
    }
  });
});
console.log('mock soloist on ws://127.0.0.1:' + PORT);
