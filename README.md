# Pi dashboard: Spotify page (iteration 1)

Touchscreen Spotify page for the Pi 5. Audio and Connect run through **Spotify Soloist** (Spotify's official headless client), so the Pi shows up as a normal device in the Spotify app on your phone and can play lossless. This page is the controller and browser on top.

```
phone Spotify app --(Connect)--> Soloist --PipeWire--> USB DAC --> Zeppelin aux
                                    ^ ws://127.0.0.1:9090
touchscreen (Chromium) <--> server.js --(Web API)--> search, playlists, library
```

## Install on the Pi

1. Create a Soloist API key at developer.spotify.com (Soloist section). Needs Premium.
2. Create a Web API app at developer.spotify.com/dashboard. Add redirect URI `http://127.0.0.1:8080/auth/callback`. Copy the Client ID.
3. (Optional, for videos) create a free YouTube Data API v3 key.
4. On the Pi: `bash install.sh --kiosk` (it asks for the three keys; Enter skips one).
5. Pair once from your phone's Spotify app (pick the device named `Pi`), set quality to Lossless for it, then tap "Sign in to Spotify" in Library on the Pi's screen.

Try it without a Pi: `node tools/mock-soloist.js &` then `DEMO=1 node server.js`, open http://127.0.0.1:8080.

## What works

- Now Playing: art, seek, volume, shuffle, repeat, queue, like, "Play here". Follows whatever device controls it, including your phone.
- Search (songs, albums, artists, playlists) with an on-screen keyboard; Library (playlists, Liked Songs, albums); album and artist pages.
- Casting: nothing to build. Phone > device picker > `Pi`.
- Video: finds the official video on YouTube, plays it muted and locked to Soloist's clock. Use +/- to nudge sync per track.

## Home dashboard (iteration 2)

- Pages: **Dashboard** (clock, weather, calendar, Todoist) and **Music** side by side. Swipe left on the dashboard for music, swipe right starting on the left rail (or tap Home) to come back.
- Screensaver: photos fade every 5 minutes (change in Setup). Touch wakes to the dashboard. After 3 idle minutes it goes back to photos, unless music is playing on the Pi, in which case it shows Now Playing with the rail hidden and dimmed.
- Anti burn-in: the whole UI drifts a few pixels every minute (every 20 s in the music view), the rail and bar hide when idle on music, and the screen dims slightly.
- Setup from your phone: `http://<pi-ip>:8080/setup.html` (location, calendars, Todoist token, timings) and `/photos.html` (upload photos; they're shrunk on the phone first). Needs `HOST=0.0.0.0` in the env file, which lets anyone on your Wi-Fi control playback.
- Weather: Open-Meteo serving Met Office models (UKV 2 km over the UK). Free for non-commercial use, no key, attribution shown.
- Calendars: any ICS link (Google "secret address in iCal format", Outlook "publish calendar"). Google refreshes these feeds slowly.
- Todoist: personal API token; shows today and overdue, tick to complete.
- After updating run `npm install` once (new dependency: node-ical), then `systemctl --user restart pi-dashboard`.

## Sleep, wake and alarm (iteration 3)

- `POST /api/sleep` blanks the screen (black overlay, then real display power off) until the time in the body, then turns it back on. The schedule is saved, so a restart or reboot doesn't lose it.
- Body (JSON, form or plain text all work): `{"wake": "2026-11-22T07:00:00+00:00"}`. Accepted: ISO 8601 with offset or `Z` (what Shortcuts' Format Date gives when you pick ISO 8601 with time), the same without an offset (read as the Pi's local time), `2026-11-22 07:00`, a date alone (uses the default wake time), a time alone like `07:00` or `7:00 am` (next occurrence), Unix seconds/ms, and Shortcuts' long text dates. Wake times in the past or more than 48 h away are refused. Optional `"alarm": false` skips that morning's alarm. `{"minutes": 2}` is for testing.
- `POST /api/wake` wakes immediately. `GET /api/power` shows the state.
- Alarm: 15 minutes after the scheduled wake (change in Setup) a soft chime fades in over ~90 s and a swipe-to-dismiss screen appears. It stops by itself after 2 minutes (Setup) or when you drag the slider across. No snooze, on purpose.
- Display off uses, in order: `DISPLAY_OFF_CMD`/`DISPLAY_ON_CMD` from the env file if you set them, `wlr-randr` (Wayland), `xset dpms` (X11), then the official Pi display backlight. If none works the screen still goes fully black, just with the backlight on. Not tested on real hardware.
- The Pi's timezone must be right (`timedatectl`) because offset-less times are read as Pi-local.
- Optional API token in Setup; then send `Authorization: Bearer <token>`.
- iOS: Shortcuts automation, Sleep Focus turns on (or Time of Day), run a shortcut with Get Contents of URL (POST, JSON) to `http://<pi-ip>:8080/api/sleep`.

## Known limits (checked against Spotify's docs, Nov 2026)

- **Lossless** is up to 24-bit/44.1 kHz and only through Soloist. The dashboard can't read the live stream format, so it doesn't claim one. Check the quality setting in the Spotify app.
- **Soloist builds expire after 90 days.** A weekly timer refreshes it. If audio stops, run `soloist-update`.
- **Soloist's WebSocket has no authentication.** It binds to 127.0.0.1 and the dashboard only forwards a fixed set of commands from same-origin pages. The dashboard binds to 127.0.0.1 too; set `HOST=0.0.0.0` in the env file only on a network you trust.
- **Spotify's Web API (Dev Mode, since Feb 2026)** caps search at 10 per type, hides track lists for playlists you don't own or collaborate on (Play still works), has no artist top tracks, and needs the app owner on Premium.
- **Spotify's own music videos** aren't exposed to third-party clients or Soloist, hence the YouTube approach. Some uploads block embedding.
- Bluetooth to the Zeppelin is lossy. Use a USB DAC into its aux input to keep the chain clean (the Pi 5 has no headphone jack).
- Not tested on real hardware yet. Soloist's output was only exercised through a mock built from its documented WebSocket API.

## Companion app (PWA)

`public/app/` is an installable phone app: Home (weather, calendar, Todoist), Music (controls, queue, play on the Pi / send back to phone) and Pi (sleep, wake, test alarm, add photos, setup links). It is plain static files, so it can be served two ways.

**1. From the Pi itself (simplest).** Open `https://<pi-https-address>/app/` on the phone, Share, Add to Home Screen. Same origin, so no CORS and no address screen. If you have set an API token, sleep and wake need it, so use way 2 or the connect screen.

**2. Hosted on GitHub Pages.** `.github/workflows/pages.yml` publishes `public/app` on every push to `main` (Settings, Pages, Source: GitHub Actions; free Pages needs a public repo, and the app contains no secrets). Then:
1. In Dashboard setup, set an **API token** and add the Pages address (e.g. `https://noaharram.github.io`) under **Allowed app addresses**.
2. Open the Pages URL on the phone, enter the Pi's HTTPS address and the token, then Add to Home Screen.

Cross-origin requests are refused unless the origin is allow-listed **and** the token is sent (REST and the WebSocket via `?token=`). Same-origin behaviour is unchanged.

**The Pi needs an HTTPS address.** An HTTPS page cannot call `http://192.168.x.x` (mixed content), and a service worker needs a secure context. Pick one:
- **Tailscale Serve** (private, recommended): install Tailscale on the Pi and phone, then `sudo tailscale serve --bg 8080`. You get `https://<pi>.<tailnet>.ts.net`, reachable only on your tailnet.
- **Cloudflare Tunnel** (public URL, so set the token): `cloudflared tunnel --url http://localhost:8080` for a quick test, or a named tunnel with your own domain for a permanent address.

Icons are generated, not committed: run `python3 tools/make-icons.py` (needs Pillow) before serving `/app/` from the Pi. The Pages workflow does this itself.

## Photos: originals, 4K copies, shuffle

Uploads (from `/photos.html` or the companion app) keep three files per photo under `~/.pi-dashboard/`:
- `originals/` the untouched file you picked (any size, up to 1 GB; JPEG, PNG, WebP, HEIC, TIFF, etc.). Tap a photo in the grid to open its original.
- `photos/` a screen copy, at most 3840px on the long edge at JPEG quality 95, which is what the slideshow shows.
- `thumbs/` small thumbnails for the upload grid.

Uploads stop if the Pi has less than 2 GB free. The slideshow plays from a shuffled deck: every photo once per round in random order, never the same photo twice in a row, kept across screensaver sessions, and new uploads are slotted in at random.
