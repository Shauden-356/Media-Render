# Media Zipper (desktop app for Windows and macOS)

A desktop app that, given a web page address:

1. **Scans the page** with a headless browser and lists its images, audio and video.
2. **Zips** the files you pick.
3. **Downloads videos**: HLS / `.m3u8` streams, direct files, and the sites yt-dlp supports (YouTube included),
   saved as **MP4 or MKV**.

Everything runs on your own computer with your own internet connection. The app starts a small server
that only this computer can reach (`127.0.0.1`) and shows it in its window. FFmpeg, ffprobe and yt-dlp are included.

## Installing (for people you share it with)
Send them to the download page, https://shauden-356.github.io/Media-Render/, or the
[latest release](https://github.com/Shauden-356/Media-Render/releases/latest). The files are:

| Computer | File |
|---|---|
| Windows 10/11 | `Media-Zipper-win-x64.exe` (installer) |
| Mac with Apple Silicon (M1 or later) | `Media-Zipper-mac-arm64.dmg` |
| Mac with Intel | `Media-Zipper-mac-x64.dmg` |

The app isn't signed with a paid Apple or Microsoft certificate, so the first launch shows a warning:
- **Windows:** "Windows protected your PC" → **More info** → **Run anyway**.
- **macOS:** open the `.dmg` and drag Media Zipper into Applications. The first time you open it, macOS says it
  can't verify the app → click **Done**, then **System Settings → Privacy & Security** → scroll down →
  **Open Anyway**.

The page scanner uses Microsoft Edge (built into Windows) or Google Chrome. If neither is installed, the app
downloads a small headless browser on first start, which takes about a minute. Until it's ready, scans fall back to a basic mode.

## Updates
The app checks for a new release when it starts and every 6 hours (also **Help → Check for Updates…**).
It downloads the new version in the background, then offers **Restart now**; choosing *Later* installs it when you quit.
- **Windows:** handled by `electron-updater` with the installer and `latest.yml` from the release.
- **Mac:** the app downloads `Media-Zipper-mac-<arch>.zip` and swaps itself in place when it quits. This needs the
  app to be in **Applications**. If it's run from the .dmg or Downloads, it offers a download link instead.
  (Apple's built-in updater only accepts apps signed with a paid developer certificate.)

Versions before 6.2.0 have no updater, so update those by hand once.

## YouTube sign-in
Usually not needed from a home connection. If YouTube says *"Sign in to confirm you're not a bot"*, open the
**YouTube** menu and pick the browser you're signed in to YouTube with, or choose an exported `cookies.txt` file.
Close that browser before downloading so its cookies can be read. Chrome on Windows encrypts its cookies in
a way yt-dlp often can't read, so use Firefox there if Chrome doesn't work.

## How a video download works ("Auto" method)
| You give it | Tries, in order |
|---|---|
| an `.m3u8` address | HLS + FFmpeg → yt-dlp |
| a direct video file | Direct file (+ FFmpeg) → yt-dlp |
| a normal web page | Browser opens it, plays the video and records the stream/file it requests, with the headers the player sent → HLS + FFmpeg / direct / DASH via yt-dlp (longest stream wins, so ads and trailers are skipped) → yt-dlp on the page itself → yt-dlp on embedded YouTube/Vimeo… players → yt-dlp on frames that hold a video player |

**Several videos on a page:** *Download video from this address* first looks through the page. If it finds more than
one video, it shows them as cards with a preview frame, title, length and resolution, and you pick one. With exactly
one it downloads it straight away; with none it runs the steps above.

**Fewer dead ends:**
- A stream link from the list that has expired (HTTP 401/403/410) is refreshed by opening its page again, then retried once.
- When a download is refused (HTTP 403 or a Cloudflare challenge), yt-dlp retries once posing as Chrome:
  `--impersonate chrome` (curl-impersonate, which copies Chrome's TLS fingerprint) for every request, plus
  `--extractor-args "generic:impersonate"`. Streams that FFmpeg is refused on get this retry too.
- The page scan starts the player (muted autoplay, its play button, a click on the player, also inside player
  frames) and waits for it to load its stream. It also finds playlists the player loads by script (XHR/fetch)
  from addresses without `.m3u8`, and stream addresses in the player's API answers (JSON).
- Pages that play DRM-protected video (Widevine/FairPlay) say so instead of trying every method.
- yt-dlp's common failures (age-restricted, private, members-only, blocked in your country, rate-limited, not started yet)
  are explained in plain words; its full output stays under **Error details**.

You can also force a method in the **Method** menu: *HLS + FFmpeg*, *yt-dlp*, *Direct file*, *FFmpeg only*.
YouTube and similar sites (Vimeo, TikTok, X, Instagram, Reddit, SoundCloud…) go straight to yt-dlp.

### Download options
| Option | What it does |
|---|---|
| **Save as: MP4** | H.264 video + AAC audio, which plays in every player (QuickTime, Windows, phones, TVs). On YouTube that means up to 1080p |
| **Save as: MKV** | The best stream in any codec (VP9/AV1, up to 4K). Plays in VLC and most modern players |
| **Save as: MP3 / M4A** | Sound only |
| **Quality** | Caps the resolution (e.g. *Up to 720p*) for yt-dlp and HLS streams |
| **Subtitles** | Embeds subtitles in your computer's language (auto-generated ones if there are no real ones) |
| **Title, thumbnail & chapters** | Embeds the title, cover image and chapter marks |
| **Skip sponsor segments** | Cuts sponsor, self-promotion and "subscribe" segments on YouTube (SponsorBlock) |

The last three apply to sites yt-dlp handles. Your choices are remembered.

When a download fails, open **Error details** under it to see why each method failed, including yt-dlp's own
output. **Copy log** copies it all, for example to paste into an issue.
When a video is ready, the app asks where to save it.

- Streams are copied (`-c copy`), not re-encoded, so conversion is fast. Only if copying is impossible for a
  direct file is it re-encoded.
- The scanned page is sent as Referer, which fixes the common "403 Forbidden" on streams.
- AES-128 encrypted HLS is handled by yt-dlp. DRM (Widevine/FairPlay) is not supported.

## Download page and releases
- **Download page:** `docs/index.html`, served by GitHub Pages at https://shauden-356.github.io/Media-Render/.
  Its buttons always point at the newest release, so the page never needs editing.
- **Publishing a new version:** raise `version` in `package.json`, commit, then
  ```
  git tag v6.0.1
  git push origin main v6.0.1
  ```
  The *Release* workflow (`.github/workflows/release.yml`) builds the three installers on GitHub and attaches them
  to a new release. That takes about 10 minutes; watch it in the repo's **Actions** tab.

## Building the app (developers)
Requires Node.js 20 or later.

```
npm install
npm start            # run from source (downloads FFmpeg + yt-dlp for this computer into vendor/)
npm run dist:mac     # dist/*.dmg for Apple Silicon and Intel
npm run dist:win     # dist/*.exe installer for Windows x64
```

Both builds work from a Mac. Building on Windows works for `dist:win`; `dist:mac` needs a Mac.
`npm run server` runs only the server (no window) at http://localhost:10000, which helps when debugging.

If `npm start` exits immediately from a VS Code terminal, run `unset ELECTRON_RUN_AS_NODE` first.
VS Code sets that variable, and it makes Electron behave like plain Node.

### Settings (environment variables, optional)
| Name | Default | Meaning |
|---|---|---|
| JOB_TIME_LIMIT_SECONDS | 21600 | Longest a single video job may run (6 h) |
| MAX_DOWNLOAD_MB | 51200 | Largest single video (50 GB) |
| MAX_CONCURRENT_JOBS | 3 | Video jobs running at once (others wait in line) |
| MAX_CONCURRENT_SCANS | 2 | Headless-browser scans at once |
| FILE_TTL_MINUTES | 120 | How long finished files wait to be saved before cleanup |
| ALLOW_TRANSCODE | 1 | Allow re-encoding as a last resort |
| CHROME_PATH | *(auto)* | Use this browser for page scans |

## Project layout
```
package.json   server.js
docs/       index.html (download page for GitHub Pages)
.github/workflows/release.yml (builds installers when a v* tag is pushed)
electron/   main.js (desktop window, menus, bundled binaries)
api/        scan.js  zip.js  jobs.js
lib/        scanner.js (Playwright)  jobs.js (job engine: HLS, direct, yt-dlp, ffmpeg)
            feed.js  hls.js  extract.js  net.js  config.js
public/     index.html
scripts/    fetch-binaries.mjs (downloads FFmpeg, ffprobe + yt-dlp into vendor/ for each platform)
desktop/hls_downloader.py   (older standalone Python tool, not part of the app)
```

## Troubleshooting
- *"This stream is encrypted"* in the notes → Auto already falls back to yt-dlp; if that fails too it is DRM.
- *Page scan finds no video* → paste the page address and press **Download video from this address**
  (lets yt-dlp try it), or pick the *yt-dlp* method.
- *"returned a web page instead of a playlist"* / *HTTP 403* → the `.m3u8` link expired or is tied to the browser that
  opened it. Paste the page address instead so the app finds a fresh link.
- *A site that worked stops working* → yt-dlp updates itself at start-up; restart the app.

## Legal
Only download media you own or have permission to save. Respect each site's terms.
