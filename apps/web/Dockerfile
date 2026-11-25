# syntax=docker/dockerfile:1
# Brayz web (Next.js admin portal + marketing) — Cloud Run image. Built from the
# REPO ROOT as context:  docker build -f apps/web/Dockerfile -t <tag> .
#
# NEXT_PUBLIC_* are inlined into the client bundle at BUILD time, so the API URL
# and auth mode are passed as build args (not runtime env).
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build -w @brayz/shared

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_MODE=dev
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE \
    NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
RUN npm run build -w @brayz/web

FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
# Next.js standalone output (rooted at the monorepo via outputFileTracingRoot).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# Next's standalone server.js is CommonJS, but the monorepo root package.json is
# "type": "module" — mark the server's dir CommonJS so Node doesn't load it as ESM.
RUN printf '{"type":"commonjs"}\n' > apps/web/package.json
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
