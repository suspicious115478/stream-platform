// ===============================================================
// stream-platform / server.js
//
// Flow:
//   1) POST /api/upload        -> save uploaded video file to disk
//   2) POST /api/streams       -> start looping that file with ffmpeg,
//                                  pushing it as RTMP into an in-process
//                                  media server (node-media-server),
//                                  which auto-transmuxes it to HLS
//                                  (.m3u8 + .ts segments) on disk.
//   3) GET  /streams/live/:key/index.m3u8  -> the playable HLS URL
//   4) DELETE /api/streams/:key -> stop the loop
//
// IMPORTANT: only stream your own uploaded content. Do not use this
// to relay/rebroadcast third-party copyrighted streams (e.g. YouTube).
// ===============================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const NodeMediaServer = require('node-media-server');

const PORT = process.env.PORT || 3000;
const RTMP_PORT = process.env.RTMP_PORT || 1935;      // internal only, not exposed by Render
const NMS_HTTP_PORT = process.env.NMS_HTTP_PORT || 8000; // internal only

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MEDIA_DIR = path.join(__dirname, 'media');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------
// 1. In-process RTMP -> HLS media server
// ---------------------------------------------------------------
const nms = new NodeMediaServer({
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: NMS_HTTP_PORT,
    mediaroot: MEDIA_DIR,
    allow_origin: '*'
  },
  trans: {
    ffmpeg: ffmpegPath,
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=4:hls_list_size=6:hls_flags=delete_segments]',
        dash: false
      }
    ]
  }
});
nms.run();

// ---------------------------------------------------------------
// 2. Express app (this is the ONLY port Render exposes publicly)
// ---------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // needed on Render so req.protocol reports "https" correctly
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve the HLS output that node-media-server writes into MEDIA_DIR
// e.g. GET /streams/live/<key>/index.m3u8
app.use('/streams', express.static(MEDIA_DIR));

// Serve the upload/manage dashboard UI (public/index.html) at "/"
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const id = uuidv4();
      cb(null, `${id}${path.extname(file.originalname) || '.mp4'}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB cap, adjust as needed
});

// key -> { ffmpegProcess, filePath, startedAt }
const runningStreams = new Map();

// -----------------------------------------------------------------
// POST /api/upload  (multipart/form-data, field name: "video")
// -----------------------------------------------------------------
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No video file uploaded (field name must be "video").' });
  }
  res.json({
    success: true,
    fileId: req.file.filename,
    path: req.file.path,
    size: req.file.size
  });
});

// -----------------------------------------------------------------
// POST /api/streams   body: { fileId: "<returned from upload>" }
// Starts an ffmpeg loop that pushes the uploaded file into the local
// RTMP ingest as app=live, streamKey=<generated>. NMS auto-transmuxes
// to HLS. Returns the public m3u8 URL.
// -----------------------------------------------------------------
app.post('/api/streams', (req, res) => {
  const { fileId } = req.body;
  if (!fileId) {
    return res.status(400).json({ success: false, message: 'fileId is required (from /api/upload response).' });
  }

  const filePath = path.join(UPLOAD_DIR, fileId);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'Uploaded file not found.' });
  }

  const streamKey = uuidv4().split('-')[0];
  const rtmpTarget = `rtmp://127.0.0.1:${RTMP_PORT}/live/${streamKey}`;

  // -stream_loop -1  => loop the input file forever
  // -re              => read input at native frame rate (needed for "live" pacing)
  // -c copy           => no re-encode (fast, cheap) - requires the upload to
  //                      already be a reasonably standard mp4/h264+aac file.
  //                      Swap to re-encode args below if inputs are inconsistent.
  const args = [
    '-stream_loop', '-1',
    '-re',
    '-i', filePath,
    '-c', 'copy',
    '-f', 'flv',
    rtmpTarget
  ];

  const proc = spawn(ffmpegPath, args);

  proc.stderr.on('data', (d) => {
    // ffmpeg logs progress to stderr; uncomment to debug
    // console.log(`[ffmpeg ${streamKey}]`, d.toString());
  });

  proc.on('exit', (code) => {
    console.log(`[stream ${streamKey}] ffmpeg exited with code ${code}`);
    runningStreams.delete(streamKey);
  });

  runningStreams.set(streamKey, { proc, filePath, startedAt: new Date().toISOString() });

  // NMS needs a moment to create the HLS files after the first RTMP packets arrive
  const m3u8Path = `/streams/live/${streamKey}/index.m3u8`;

  res.json({
    success: true,
    streamKey,
    m3u8Url: `${req.protocol}://${req.get('host')}${m3u8Path}`,
    note: 'It can take a few seconds for the .m3u8 file to appear after this call.'
  });
});

// -----------------------------------------------------------------
// GET /api/streams  -> list currently running loops
// -----------------------------------------------------------------
app.get('/api/streams', (req, res) => {
  const list = Array.from(runningStreams.entries()).map(([key, v]) => ({
    streamKey: key,
    filePath: v.filePath,
    startedAt: v.startedAt,
    m3u8Url: `${req.protocol}://${req.get('host')}/streams/live/${key}/index.m3u8`
  }));
  res.json({ success: true, count: list.length, streams: list });
});

// -----------------------------------------------------------------
// DELETE /api/streams/:key  -> stop the loop
// -----------------------------------------------------------------
app.delete('/api/streams/:key', (req, res) => {
  const entry = runningStreams.get(req.params.key);
  if (!entry) {
    return res.status(404).json({ success: false, message: 'Stream not found or already stopped.' });
  }
  entry.proc.kill('SIGKILL');
  runningStreams.delete(req.params.key);
  res.json({ success: true, message: 'Stream stopped.' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', runningStreams: runningStreams.size, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Stream platform HTTP server listening on ${PORT}`);
  console.log(`   RTMP ingest (internal only): rtmp://127.0.0.1:${RTMP_PORT}/live/<key>`);
  console.log(`   HLS output served at: /streams/live/<key>/index.m3u8`);
});
