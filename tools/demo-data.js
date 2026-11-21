'use strict';
// Canned Spotify Web API responses for DEMO=1 (no network, no login). Shapes follow the
// Feb 2026 Dev Mode API: playlist.items.total, playlist items under items.items[].item.
const mk = (n, nm) => ({ id: 'a' + n, uri: 'spotify:artist:a' + n, name: nm });
const A = [mk(1, 'Nova Harbour'), mk(2, 'The Lowlands'), mk(3, 'Kite & Compass'), mk(4, 'Marlowe Reyes')];
const ALB = [
  { id: 'b1', name: 'Static Bloom', artist: A[0] }, { id: 'b2', name: 'Orbit Lines', artist: A[1] },
  { id: 'b3', name: 'Night Shift', artist: A[2] }, { id: 'b4', name: 'Paper Lanterns', artist: A[3] },
];
const album = b => ({ id: b.id, uri: 'spotify:album:' + b.id, name: b.name, images: [], artists: [b.artist], release_date: '2025-05-02', total_tracks: 6 });
const TITLES = ['Glass Hours', 'Slow Static', 'Harbour Lights', 'Neon Quiet', 'Afterimage', 'Low Tide Radio'];
let k = 0; const tracks = [];
ALB.forEach((b, bi) => TITLES.forEach((t, ti) => { tracks.push({ id: 't' + (k++), uri: 'spotify:track:t' + (k - 1), name: t + (bi ? ' ' + ['', 'II', 'III', 'IV'][bi] : ''), artists: [b.artist], album: album(b), duration_ms: 170000 + ((bi * 7 + ti * 13) % 9) * 21000, track_number: ti + 1 }); }));
const PL = [
  { id: 'demo1', name: 'Late Night Drive', owner: { display_name: 'You' }, items: { total: 24 }, images: [], tr: tracks.slice(0, 12) },
  { id: 'demo2', name: 'Focus', owner: { display_name: 'You' }, items: { total: 18 }, images: [], tr: tracks.slice(8, 20) },
  { id: 'demo3', name: 'Release Radar', owner: { display_name: 'Spotify' }, items: { total: 30 }, images: [], tr: null },
];
const plObj = p => ({ id: p.id, uri: 'spotify:playlist:' + p.id, name: p.name, owner: p.owner, items: p.items, images: p.images });
const page = (items, total) => ({ items, total: total ?? items.length, limit: 50, offset: 0, next: null });

const SHOWS = [{ id: 's1', name: 'The Daily Build', publisher: 'Pi FM' }, { id: 's2', name: 'Long Drive Radio', publisher: 'Marlowe Reyes' }, { id: 's3', name: 'Paper Trails', publisher: 'Kite & Compass' }];
const showObj = s => ({ id: s.id, uri: 'spotify:show:' + s.id, name: s.name, publisher: s.publisher, images: [] });
const eps = []; SHOWS.forEach((s, si) => { for (let n = 5; n >= 1; n--) eps.push({ id: `e${si}${n}`, uri: `spotify:episode:e${si}${n}`, name: `${s.name} #${n}: ${['Pipelines', 'Coffee and compilers', 'Quiet hours', 'Signal and noise', 'Release day'][n - 1]}`, description: 'Episode notes for ' + n, release_date: `2026-11-${10 + n}`, duration_ms: 1800000 + n * 240000, images: [], resume_point: { fully_played: n === 3, resume_position_ms: n === 4 ? 900000 : 0 }, show: s }); });
const epTrack = e => ({ id: e.id, uri: e.uri, name: e.name, artists: [{ id: 'x', uri: 'spotify:show:' + e.show.id, name: e.show.publisher }], album: { id: e.show.id, uri: 'spotify:show:' + e.show.id, name: e.show.name, images: [] }, duration_ms: e.duration_ms, isEpisode: true });
exports.allTracks = () => tracks;
exports.tracksFor = uri => {
  const [, kind, id] = uri.split(':');
  if (kind === 'episode') { const e = eps.find(x => x.id === id); return e ? [epTrack(e)] : []; }
  if (kind === 'track') return tracks.slice(Math.max(0, tracks.findIndex(t => t.id === id)));
  if (kind === 'album') return tracks.filter(t => t.album.id === id);
  if (kind === 'playlist') { const p = PL.find(x => x.id === id); return p?.tr || tracks.slice(0, 10); }
  return [];
};
exports.nameFor = uri => { if (uri.startsWith('spotify:episode:')) return SHOWS.find(s => s.id === eps.find(e => e.id === uri.split(':')[2])?.show.id)?.name; const [, kind, id] = uri.split(':'); return (kind === 'playlist' ? PL.find(p => p.id === id)?.name : ALB.find(b => b.id === id)?.name) || 'Demo'; };

exports.handle = (req, res, url, sub, json) => {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  if (sub === 'search') {
    const m = x => x.toLowerCase().includes(q);
    return json(res, 200, {
      tracks: page(tracks.filter(t => m(t.name) || m(t.artists[0].name)).slice(0, 10)),
      albums: page(ALB.filter(b => m(b.name) || m(b.artist.name)).map(album)),
      artists: page(A.filter(a => m(a.name)).map(a => ({ ...a, images: [] }))),
      playlists: page(PL.filter(p => m(p.name)).map(plObj)),
      shows: page(SHOWS.filter(s => m(s.name) || m(s.publisher)).map(showObj)),
    });
  }
  if (sub === 'me') return json(res, 200, { id: 'demo', display_name: 'Demo' });
  if (sub === 'me/playlists') return json(res, 200, page(PL.map(plObj)));
  if (sub === 'me/tracks') return json(res, 200, page(tracks.slice(0, 20).map(t => ({ added_at: '2026-01-01', track: t })), 20));
  if (sub === 'me/albums') return json(res, 200, page(ALB.map(b => ({ album: album(b) }))));
  if (sub === 'me/library/contains') return json(res, 200, (url.searchParams.get('uris') || '').split(',').map((_, i) => i % 2 === 0));
  if (sub === 'me/library') return json(res, 200, {});
  if (sub === 'me/shows') return json(res, 200, page(SHOWS.map(s => ({ show: showObj(s) }))));
  let m;
  if ((m = sub.match(/^shows\/(\w+)\/episodes$/))) return json(res, 200, page(eps.filter(e => e.show.id === m[1]).map(({ show, ...e }) => e)));
  if ((m = sub.match(/^shows\/(\w+)$/))) { const s = SHOWS.find(x => x.id === m[1]); return s ? json(res, 200, showObj(s)) : json(res, 404, {}); }
  if ((m = sub.match(/^playlists\/(\w+)\/items$/))) {
    const p = PL.find(x => x.id === m[1]);
    if (!p?.tr) return json(res, 403, { error: { status: 403, message: 'Forbidden' } });
    return json(res, 200, page(p.tr.map(t => ({ item: t }))));
  }
  if ((m = sub.match(/^playlists\/(\w+)$/))) { const p = PL.find(x => x.id === m[1]); return p ? json(res, 200, plObj(p)) : json(res, 404, {}); }
  if ((m = sub.match(/^albums\/(\w+)$/))) { const b = ALB.find(x => x.id === m[1]); return b ? json(res, 200, { ...album(b), tracks: page(tracks.filter(t => t.album.id === b.id)) }) : json(res, 404, {}); }
  if ((m = sub.match(/^artists\/(\w+)\/albums$/))) return json(res, 200, page(ALB.filter(b => b.artist.id === m[1]).map(album)));
  if ((m = sub.match(/^artists\/(\w+)$/))) { const a = A.find(x => x.id === m[1]); return a ? json(res, 200, { ...a, images: [] }) : json(res, 404, {}); }
  if ((m = sub.match(/^tracks\/(\w+)$/))) { const t = tracks.find(x => x.id === m[1]); return t ? json(res, 200, t) : json(res, 404, {}); }
  json(res, 404, {});
};
