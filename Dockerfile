# ---- build stage: compile better-sqlite3 native addon ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# build tools needed to compile better-sqlite3
# -o Acquire::Check-Valid-Until=false + Check-Date=false: the build host's clock
# can be skewed (seen ~3.5h fast), which otherwise makes apt reject the repo
# Release files as "not valid yet".
RUN apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime stage: slim image, no compilers ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY public ./public

# data that must persist lives here; mounted as a volume at runtime
# (db + generated lantern images). templates ship in the image but can be
# overridden by a mounted folder too.
RUN mkdir -p /app/public/lanterns

EXPOSE 3000
# simple healthcheck hitting the /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
