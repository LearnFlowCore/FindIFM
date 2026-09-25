FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY src ./src

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=10000 \
  OPEN_BROWSER=0 \
  YANDEX_BROWSER_PATH=/usr/bin/chromium \
  DATA_ROOT=/var/data \
  DOWNLOADS_PATH=/var/data/exports

EXPOSE 10000
CMD ["node", "src/server.js"]
