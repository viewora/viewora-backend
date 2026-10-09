# ── Stage 1: Build the Node.js app ───────────────────────────────────────────
# basisu is NOT built here — this Dockerfile only builds the API service, which
# never calls the basisu binary (only src/worker.ts does, via tile-processor.ts,
# and the worker deploys separately through nixpacks.toml's aptPkgs).
# Official Docker Hub "node" images via AWS's public mirror — Railway's shared
# builders were hitting Docker Hub's anonymous pull limit (429 Too Many
# Requests), failing every deploy before the build even started.
FROM public.ecr.aws/docker/library/node:22 AS app-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=app-builder /app/dist ./dist
COPY start.sh ./
RUN chmod +x start.sh
CMD ["sh", "start.sh"]
