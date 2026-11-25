# syntax=docker/dockerfile:1
# Brayz API — Cloud Run image. Built from the REPO ROOT as context:
#   docker build -f services/api/Dockerfile -t <tag> .
FROM node:20-slim AS build
WORKDIR /app
# Prisma needs OpenSSL present to pick its query-engine at generate time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci
# Generate the Prisma client (the @brayz/db build needs the generated types).
RUN npm run db:generate
# Build in dependency order: config/shared/db first, then carriers/ai/pos, then the API.
RUN npm run build -w @brayz/config -w @brayz/shared -w @brayz/db -w @brayz/carriers -w @brayz/ai -w @brayz/pos -w @brayz/billing -w @brayz/api
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV API_PORT=8080
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "services/api/dist/main.js"]
