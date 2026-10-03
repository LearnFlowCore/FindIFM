FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# The image contains the complete project package. Local-only files are
# excluded by .dockerignore (dependencies, data, logs and Windows output).
COPY . .

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=10000 \
  OPEN_BROWSER=0 \
  CAPTCHA_STRATEGY=manual \
  YANDEX_BROWSER_PATH=/usr/bin/chromium \
  DATA_ROOT=/tmp/findifm \
  DOWNLOADS_PATH=/tmp/findifm/exports

EXPOSE 10000
CMD ["node", "src/server.js"]
