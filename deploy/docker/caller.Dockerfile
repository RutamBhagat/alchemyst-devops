FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY quickstart/workers/caller-worker/package*.json ./
RUN npm ci
COPY quickstart/workers/caller-worker/tsconfig.json ./
COPY quickstart/workers/caller-worker/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
CMD ["node", "dist/worker.js"]
