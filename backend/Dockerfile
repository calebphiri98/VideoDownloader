FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages --pre -U "yt-dlp[default]"

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 5000
CMD ["node", "server.js"]
