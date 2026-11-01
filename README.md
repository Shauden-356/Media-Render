# Media Zipper (Render version, with video downloader)

A website + backend that, given a page address:

1. **Scans the page** with a headless browser (Playwright) and lists its images, audio and video.
2. **Zips** the files you pick.
3. **Downloads videos** — HLS / `.m3u8` streams and direct files — and converts them to **MP4 or MKV**
   using **FFmpeg**, **yt-dlp** and a Playwright "sniffer" that finds the real stream address.

Everything runs in one Docker container on Render.

## Deploy on Render (no local setup needed)
1. Push the contents of this folder to a GitHub repo (`Dockerfile` must be in the top level).
2. Render dashboard → **New → Blueprint** → pick the repo (it reads `render.yaml`).
   Or **New → Web Service** → Runtime **Docker**, instance type **Standard (2 GB)**, health check `/healthz`.
3. When asked for `APP_PASSWORD`, set one. Without it, anyone who finds the URL can use your server's bandwidth.
   The browser shows a login box; the username can be anything.
4. Deploy, then open the `onrender.com` address.

Free/Starter instances (512 MB) will crash when Chromium starts. Use **Standard** or larger.

## How a video download works ("Auto" method)
| You give it | Tries, in order |
|---|---|
| an `.m3u8` address | HLS + FFmpeg → yt-dlp |
| a direct video file | Direct file (+ FFmpeg) → yt-dlp |
| a normal web page | Playwright opens it, plays the video and records the stream/file it requests → HLS + FFmpeg / direct (longest stream wins, so ads and trailers are skipped) → yt-dlp on the page itself |

You can also force a method in the **Method** menu: *HLS + FFmpeg*, *yt-dlp*, *Direct file*, *FFmpeg only*.

Downloads run as **background jobs**: the page shows progress, and the finished file is available for
`FILE_TTL_MINUTES` (default 20) before being deleted. Nothing needs one long HTTP request, so
hour-long videos work.

- Streams are copied (`-c copy`), not re-encoded, so conversion is fast. Only if copying is impossible for a
  direct file is it re-encoded (disable with `ALLOW_TRANSCODE=0`).
- Referer is sent automatically (the scanned page), which fixes the common "403 Forbidden" on streams.
- AES-128 encrypted HLS is handled by yt-dlp. DRM (Widevine/FairPlay) is not supported by anything legitimate.

## Environment variables
| Name | Default | Meaning |
|---|---|---|
| APP_PASSWORD | *(none)* | Turns on a password prompt for the whole site |
| JOB_TIME_LIMIT_SECONDS | 3600 | Longest a single video job may run |
| MAX_DOWNLOAD_MB | 2048 | Largest single video |
| MAX_CONCURRENT_JOBS | 2 | Video jobs running at once (others wait in line) |
| MAX_CONCURRENT_SCANS | 2 | Headless-browser scans at once |
| FILE_TTL_MINUTES | 20 | How long finished files are kept |
| SCAN_BUDGET_MS | 55000 | Time allowed for a page scan |
| ZIP_TIME_LIMIT_SECONDS | 52 | Longest a zip build may run (`render.yaml` sets 300) |
| ALLOW_TRANSCODE | 1 | Allow re-encoding as a last resort |
| ALLOW_FFMPEG_DIRECT | 1 | Allow the "FFmpeg only" method (see security) |
| JOBS_DIR | /tmp/mz-jobs | Where temporary files live |

## API
- `POST /api/scan` `{url}` → `{page,title,items,streams,notes}`
- `POST /api/zip` `{urls,page}` → zip file
- `POST /api/jobs` `{url,page?,method?,container?,name?}` → `{id,...}` (`method`: auto|hls|direct|ytdlp|ffmpeg; `container`: mp4|mkv)
- `GET /api/jobs/:id` → `{status,stage,percent,error,filename,size,method,notes}` (`status`: queued|running|done|error|cancelled)
- `GET /api/jobs/:id/file` → the finished video (supports resume)
- `DELETE /api/jobs/:id` → cancel

## Project layout
```
Dockerfile  render.yaml  package.json  server.js
api/    scan.js  zip.js  jobs.js
lib/    scanner.js (Playwright)  jobs.js (job engine: HLS, direct, yt-dlp, ffmpeg)
        feed.js  hls.js  extract.js  net.js  config.js
public/ index.html
desktop/hls_downloader.py   (no time limit; run on your own PC with FFmpeg installed)
```

## Keeping it working
- **Playwright version:** the `playwright` version in `package.json` and the tag in the `Dockerfile`
  (`mcr.microsoft.com/playwright:v1.49.1-noble`) must always match. Change both together.
- **yt-dlp** updates itself at start-up and once a day. If a site stops working, use
  *Manual Deploy → Clear build cache & deploy* to pull the newest build.
- **Disk:** big videos are written to the instance's temporary disk. For multi-GB videos attach a persistent
  disk (see the commented block in `render.yaml`) and set `JOBS_DIR` to it.

## Troubleshooting
- *"This stream is encrypted"* in the notes → Auto already falls back to yt-dlp; if that fails too it is DRM.
- *Page scan finds no video* → paste the page address and press **Download video from this address**
  (lets yt-dlp try it), or pick the *yt-dlp* method.
- *HTTP 403 on segments* → the site checks Referer/cookies/signed URLs that expire; scan the page again and retry immediately.
- *"Sign in to confirm you're not a bot"* (YouTube) → yt-dlp needs a logged-in session. In a private browser
  window, sign in to YouTube, export cookies for youtube.com in Netscape `cookies.txt` format (e.g. the
  "Get cookies.txt LOCALLY" extension), then close that window without signing out. On Render add it as a
  **Secret File** named `cookies.txt` and set `YTDLP_COOKIES=/etc/secrets/cookies.txt`. Running locally you can
  instead set `YTDLP_COOKIES_FROM_BROWSER=chrome` (or firefox, edge…). Re-export if it starts failing again.
- *Out of memory / scan crashes* → lower `MAX_CONCURRENT_SCANS` to 1 or upgrade the instance.

## Security notes
- Node-fetched requests (scan, zip, HLS segments, direct files) refuse private/internal addresses on every redirect.
- **yt-dlp and "FFmpeg only" open addresses themselves** and do not apply that check to redirects or segments.
  Keep `APP_PASSWORD` set; if the site will be public, set `ALLOW_FFMPEG_DIRECT=0` and remove `ytdlp` from the allowed methods in `api/jobs.js`.

## Legal
Only download media you own or have permission to save. Respect each site's terms.
