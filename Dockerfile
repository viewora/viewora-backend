# ── Stage 1: Build basisu from source ────────────────────────────────────────
FROM ubuntu:22.04 AS basisu-builder
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y cmake g++ git && \
    rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/BinomialLLC/basis_universal.git /tmp/bu && \
    cd /tmp/bu && \
    cmake -DCMAKE_BUILD_TYPE=Release . && \
    make -j$(nproc) basisu

# ── Stage 2: Build the Node.js app ───────────────────────────────────────────
FROM node:22 AS app-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
COPY --from=basisu-builder /tmp/bu/bin/basisu /usr/local/bin/basisu
COPY --from=app-builder /app/dist ./dist
COPY --from=app-builder /app/node_modules ./node_modules
COPY package.json start.sh ./
RUN chmod +x /usr/local/bin/basisu start.sh
CMD ["sh", "start.sh"]
