'use strict';
/* Handoff bloom: the phone taps the NFC tag on the monitor's bottom bezel, Spotify moves to the Pi
 * and the Music page grows out of the bottom-centre of the screen.
 *
 * Loaded by index.html (the server adds the <script> tag when it serves the page). It uses the page's own
 * globals (PG, PW, saver, route, go, setPage, hideSaver, closeSettings, setAmbient, toast, $, $$ ...) and hooks
 * two of its functions, onMsg and applyPower, so index.html itself needs no changes.
 *
 * The server pings us over the dashboard WebSocket:
 *   {type:'handoff', phase:'wake'}   screen was asleep and is waking: keep the black veil up
 *   {type:'handoff', phase:'start'}  play the animation
 *   {type:'handoff', phase:'done', ok} playback has moved, or couldn't
 *   {type:'handoff', phase:'back', ok, to} second tap: playback went back to the phone, so the bloom plays in reverse
 * From the dashboard or screensaver the Music page is revealed through a circle that grows from the bottom-centre,
 * with green ripples following the edge. From a sleeping screen it blooms out of black. Already on Music: ripples only.
 */
(() => {
  const HO_MS = 1100, HO_EASE = 'cubic-bezier(.2,.75,.2,1)';   // HO_MS: how long the bloom takes
  const st = { running: false, hold: false, holdT: 0 };

  const css = document.createElement('style');
  css.textContent = `
#pager.ho{z-index:110}
.ho-ring{position:absolute;left:50%;top:100%;z-index:20;border-radius:50%;pointer-events:none;opacity:0;will-change:transform,opacity;
  border:9px solid rgba(30,215,96,.95);box-shadow:0 0 90px 24px rgba(30,215,96,.45),inset 0 0 120px 30px rgba(30,215,96,.22)}
.ho-ring.r2,.ho-ring.r3{border-color:rgba(30,215,96,.55);box-shadow:0 0 60px 12px rgba(30,215,96,.25)}`;
  document.head.appendChild(css);
  const pager = $('#pager');
  const rings = ['r1', 'r2', 'r3'].map(c => { const d = document.createElement('div'); d.className = 'ho-ring ' + c; pager.appendChild(d); return d; });

  // Hook 1: handoff messages from the server never reach the player code.
  const baseOnMsg = onMsg;
  onMsg = m => (m && m.type === 'handoff') ? onHandoff(m) : baseOnMsg(m);

  // Hook 2: while a handoff is waking the monitor, the 3 s power poll must not lift the black veil early.
  const basePower = applyPower;
  applyPower = p => basePower(st.hold ? { ...p, sleeping: true } : p);

  function onHandoff(m) {
    if (m.phase === 'wake') { st.hold = true; clearTimeout(st.holdT); st.holdT = setTimeout(() => { st.hold = false; }, 6000); }
    else if (m.phase === 'start') bloom(m);
    else if (m.phase === 'back') bloomBack(m);
    else if (m.phase === 'done') toast(m.ok ? 'Playing on ' + (S.auth?.device_name || 'the Pi') : "Couldn't move playback. Start something in Spotify, then tap again.");
  }

  // Second tap while playing: the Music page shrinks back into the bottom-centre and the dashboard is left showing.
  function bloomBack(m) {
    const say = () => toast(m.ok ? 'Sent back to ' + m.to : "Couldn't send it back. No other Spotify device found.");
    if (!m.ok || st.running || PW.alarmActive || PW.sleeping || (PG.page === 0 && !saver.on)) return say(); // nothing to animate (or it failed): just say so
    st.running = true;
    const W = innerWidth, Hh = innerHeight, R = Math.ceil(Math.hypot(W / 2, Hh)) + 8, MS = 950, EASE = 'cubic-bezier(.65,0,.35,1)';
    closeSettings(); lastAct = Date.now(); setAmbient(false); if (saver.on) hideSaver();
    rings.forEach(r => { r.style.width = r.style.height = 2 * R + 'px'; r.style.margin = `${-R}px 0 0 ${-R}px`; });
    setPage(0, false); clearTimeout(PG.t); homeEl.classList.remove('off');   // dashboard goes underneath, Music is laid over it and shrinks away
    pager.classList.add('ho'); spotEl.classList.remove('off'); spotEl.style.background = 'var(--bg)';
    Object.assign(spotEl.style, { position: 'absolute', left: '0', top: '0', zIndex: '5' });
    const shrink = spotEl.animate([{ clipPath: `circle(${R}px at 50% 100%)` }, { clipPath: 'circle(0px at 50% 100%)' }], { duration: MS, easing: EASE, fill: 'both' });
    const ring = (el, delay, peak) => el.animate(
      [{ transform: 'scale(1)', opacity: 0 }, { transform: 'scale(.97)', opacity: peak, offset: .04 }, { transform: 'scale(.02)', opacity: peak, offset: .96 }, { transform: 'scale(.015)', opacity: 0 }],
      { duration: MS, delay, easing: EASE, fill: 'backwards' });
    ring(rings[0], 0, 1); ring(rings[1], 120, .7); ring(rings[2], 240, .45);
    const fin = () => {
      spotEl.style.position = spotEl.style.left = spotEl.style.top = spotEl.style.zIndex = spotEl.style.background = ''; shrink.oncancel = null; shrink.cancel();
      pager.classList.remove('ho'); pager.style.background = '';
      setPage(0, false); st.running = false; say();
    };
    shrink.onfinish = fin; shrink.oncancel = () => { if (st.running) fin(); };
  }

  function bloom(m) {
    clearTimeout(st.holdT); st.hold = false;
    if (st.running || PW.alarmActive) return;
    st.running = true;
    const wasAsleep = !!m.woke || PW.sleeping || $('#veil').classList.contains('on');
    const W = innerWidth, Hh = innerHeight, R = Math.ceil(Math.hypot(W / 2, Hh)) + 8;
    closeSettings(); lastAct = Date.now(); setAmbient(false);
    rings.forEach(r => { r.style.width = r.style.height = 2 * R + 'px'; r.style.margin = `${-R}px 0 0 ${-R}px`; });
    const ripple = (el, delay, peak) => el.animate(
      [{ transform: 'scale(.015)', opacity: 0 }, { transform: 'scale(.03)', opacity: peak, offset: .06 }, { transform: 'scale(.62)', opacity: peak, offset: .6 }, { transform: 'scale(1)', opacity: 0 }],
      { duration: HO_MS + 250, delay, easing: HO_EASE, fill: 'backwards' });
    const ripples = () => { ripple(rings[0], 0, 1); ripple(rings[1], 140, .8); ripple(rings[2], 280, .55); };
    if (PG.page === 1 && !saver.on && !wasAsleep) { ripples(); st.running = false; return; } // Music is already up

    // What shows outside the growing circle is the "old" screen: black if we were asleep, the photos if the screensaver was up, else the dashboard.
    if (wasAsleep) { PW.sleeping = false; $('#veil').classList.remove('on'); homeEl.classList.add('off'); pager.style.background = '#000'; }
    else if (saver.on) { homeEl.classList.add('off'); pager.style.background = 'transparent'; }
    if (route.view !== 'video') go('now');
    const lift = PG.page === 0;                       // on the dashboard: lay the Music page over it, in place, then settle onto page 2
    clearTimeout(PG.t);
    pager.classList.add('ho');                        // above the screensaver while it plays
    spotEl.classList.remove('off');
    spotEl.style.background = 'var(--bg)';            // opaque, so nothing shows through the Music page
    if (lift) Object.assign(spotEl.style, { position: 'absolute', left: '0', top: '0', zIndex: '5' });
    const grow = spotEl.animate([{ clipPath: 'circle(0px at 50% 100%)' }, { clipPath: `circle(${R}px at 50% 100%)` }], { duration: HO_MS, easing: HO_EASE, fill: 'both' });
    ripples();
    const fin = () => {
      spotEl.style.position = spotEl.style.left = spotEl.style.top = spotEl.style.zIndex = spotEl.style.background = ''; grow.oncancel = null; grow.cancel();
      pager.classList.remove('ho'); pager.style.background = '';
      hideSaver(); setPage(1, false); st.running = false;
    };
    grow.onfinish = fin; grow.oncancel = () => { if (st.running) fin(); };
  }
})();
