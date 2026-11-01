# The Playwright image already contains Chromium + all its system libraries.
# The tag MUST match the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

# FFmpeg for remuxing, python3 because the yt-dlp release file is a Python zipapp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/ytdlp \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/ytdlp/yt-dlp \
 && chmod a+rx /opt/ytdlp/yt-dlp \
 && chown -R pwuser:pwuser /opt/ytdlp

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    YTDLP_PATH=/opt/ytdlp/yt-dlp \
    JOBS_DIR=/tmp/mz-jobs

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

# Chromium runs with --no-sandbox (see lib/scanner.js), so a normal user is fine.
USER pwuser
EXPOSE 10000
CMD ["node", "server.js"]
