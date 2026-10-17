# Runner snugcode di container (Fly.io, Railway, VPS, …): daemon yang sama dengan di PC, tanpa PC.
#   docker build -t snugcode .
#   docker run -d --restart unless-stopped -v snugcode:/data -e SNUGCODE_RELAY=https://snugcode.arfak.workers.dev \
#     -e SNUGCODE_MACHINE_TOKEN=<token> -e SNUGCODE_PAIR_PIN=<pin> snugcode
# Perintah lengkap (token & PIN) dibuat aplikasi HP: Tambah mesin → Runner cloud → Server sendiri.
# Model (API key / login ChatGPT) dan login GitHub diatur dari aplikasi HP (atau env SNUGCODE_API_KEY). Platform yang menyalakan container
# saat dibutuhkan (mis. Fly.io): SNUGCODE_IDLE_EXIT=1 membuat container keluar setelah
# SNUGCODE_IDLE_MINUTES (bawaan 30) tidak dipakai.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates chromium procps curl openssh-client python3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/src
COPY package.json package-lock.json ./
COPY daemon ./daemon
COPY shared ./shared
# Dipasang sebagai paket global (bukan symlink): `snugcode update` dari HP menimpa folder yang sama.
RUN npm pack --silent && npm i -g ./snugcode-*.tgz --include=optional --no-audit --no-fund --loglevel=error \
  && rm -rf /tmp/src && mkdir -p /data && chown node:node /data
USER node
WORKDIR /home/node
ENV SNUGCODE_HOME=/data NODE_ENV=production
VOLUME /data
ENTRYPOINT ["snugcode", "cloud"]
