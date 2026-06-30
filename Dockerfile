# ---- build stage ------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----------------------------------------------------------
FROM node:22-slim AS runner
ENV NODE_ENV=production
# git + certs: the bundled Claude Code runtime expects them available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY public ./public
# data dir owned by the non-root user so the named volume inherits write access
RUN mkdir -p /app/data && chown -R node:node /app/data

# Run as non-root: required for the Agent SDK's bypassPermissions mode.
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
