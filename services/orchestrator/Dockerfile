# syntax=docker/dockerfile:1
# Brayz Orchestrator — Cloud Run image. Built from the REPO ROOT as context so
# the @brayz/* workspace packages resolve:
#   docker build -f services/orchestrator/Dockerfile -t <tag> .
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
# Clean tree has no dist yet — build packages in dependency order, then the service.
RUN npm run build -w @brayz/config -w @brayz/shared -w @brayz/ai -w @brayz/orchestrator
# Drop dev deps (tsc/tsx/vitest) from the runtime tree; keeps @brayz/* workspace links.
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
# Cloud Run sends traffic to $PORT (default 8080); the app reads ORCHESTRATOR_PORT.
ENV ORCHESTRATOR_PORT=8080
WORKDIR /app
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "services/orchestrator/dist/main.js"]
