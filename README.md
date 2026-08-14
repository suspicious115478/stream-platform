# stream-platform

Upload a video file → it loops as a "live" RTMP feed internally → auto-transmuxed
to HLS → you get a public `.m3u8` URL to plug into your ScreenRent website's
video player (e.g. hls.js).

⚠️ Only stream content you own or have rights to. Do not point this at
third-party sources like YouTube — that is a copyright/ToS violation regardless
of the technical pipeline used.

## How it works

```
[your uploaded mp4] --ffmpeg loop--> [RTMP :1935 internal] --node-media-server-->
   [HLS files on disk: media/live/<key>/index.m3u8 + segment .ts files]
   --Express static-->  https://yourapp.onrender.com/streams/live/<key>/index.m3u8
```

The RTMP port (1935) is **never exposed publicly** — Render only routes traffic
to the single `PORT` your Express app listens on. ffmpeg talks to the media
server over `127.0.0.1` inside the same process/container.

## Local setup

```bash
npm install
npm start
```

Requires `ffmpeg-static` (bundles a working ffmpeg binary automatically — no
manual ffmpeg install needed, works on Render too).

## API

### 1. Upload a video
```
POST /api/upload
Content-Type: multipart/form-data
field: video=<file>
```
Response:
```json
{ "success": true, "fileId": "abc123.mp4", "path": "...", "size": 12345678 }
```

### 2. Start the loop / live stream
```
POST /api/streams
Content-Type: application/json
{ "fileId": "abc123.mp4" }
```
Response:
```json
{
  "success": true,
  "streamKey": "9f2a1c3d",
  "m3u8Url": "https://yourapp.onrender.com/streams/live/9f2a1c3d/index.m3u8",
  "note": "It can take a few seconds for the .m3u8 file to appear after this call."
}
```
Wait ~3-5 seconds after this call before hitting the `m3u8Url` — HLS needs a
couple of segments to exist before the playlist is valid.

### 3. List running streams
```
GET /api/streams
```

### 4. Stop a stream
```
DELETE /api/streams/:streamKey
```

## Playing the m3u8 on your main ScreenRent site

```html
<video id="player" controls></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
  const video = document.getElementById('player');
  const url = 'https://yourapp.onrender.com/streams/live/9f2a1c3d/index.m3u8';
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url; // Safari plays HLS natively
  }
</script>
```

## Deploying to Render (testing)

1. Push this folder to a new GitHub repo.
2. Render → New → Web Service → connect repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env var `PORT` is auto-provided by Render — no need to set it.
6. **Free tier will sleep after 15 min idle**, which kills any running ffmpeg
   loop and the disk is ephemeral (uploaded files disappear on redeploy/restart).
   Fine for testing; for real usage move to a paid persistent instance and
   consider mounting a persistent disk for `uploads/` and `media/`.

## Known limitations / things to harden before production

- **`-c copy`** in the ffmpeg command doesn't re-encode (fast + cheap), but it
  assumes uploaded files are already reasonably standard H.264/AAC mp4. If
  users upload odd formats/codecs, switch to re-encoding, e.g.:
  ```
  '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-f', 'flv', rtmpTarget
  ```
  (slower, more CPU, but far more reliable across arbitrary uploads).
- No auth on `/api/upload` or `/api/streams` yet — add an auth check (reuse
  your existing Firebase auth token verification) before exposing this
  publicly.
- No cleanup job for old uploaded files / orphaned HLS folders — add a cron
  or TTL cleanup for production.
- One process per running stream — for 20+ concurrent streams, monitor
  CPU/RAM and consider a beefier instance or a queue.
