# Bun runs the TypeScript directly, so there is no build output to carry between
# stages; the only reason to split is to keep dev dependencies out of the runtime.
FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lock* ./

RUN bun install --frozen-lockfile --production || bun install --production


FROM oven/bun:1 AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    LABEL_DIFFS_DATA=gs://monaco-dev-bucket/drug-safety-signaling-demo

COPY --from=deps /app/node_modules ./node_modules

COPY package.json tsconfig.json ./
COPY src ./src
COPY static ./static

# Reads the bucket over DuckDB's S3-compatible path, so the container needs only the
# HMAC pair at run time:
#   docker run -e LABEL_DIFFS_HMAC_KEY_ID -e LABEL_DIFFS_HMAC_SECRET -p 8000:8000 <image>
# Mount a local copy at /app/data and pass --data ./data to read from disk instead.
EXPOSE 8000

USER bun

CMD ["bun", "run", "src/server.ts"]
