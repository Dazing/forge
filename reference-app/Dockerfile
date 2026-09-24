# Multi-stage build for the reference app.
# Stage 1: build client + server.
# Stage 2: runtime with only production deps and built artifacts.

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY index.html ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/index.html ./
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
