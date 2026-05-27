# ─── Stage 1: Build React client ───
FROM node:20-alpine AS client-build

WORKDIR /build
COPY client/package*.json ./
RUN npm install --ignore-scripts
COPY client/ ./
RUN npm run build

# ─── Stage 2: Runtime ───
FROM node:20-alpine AS runtime

WORKDIR /app

# Git is required for git_clone, git_status tools
RUN apk add --no-cache git

# Copy package files and install production deps (skip optional: better-sqlite3 needs native build tools)
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional && npm install tsx

# Copy source
COPY server/ ./server/
COPY public/ ./public/

# Copy React client build from stage 1
COPY --from=client-build /build/dist ./client/dist/

# Create workspace directory and pre-clone demo dataset repo
RUN mkdir -p /app/workspace && \
    git clone --depth 1 https://github.com/foxtrotcommunications/foxtrotcommunications-avalon-public.git /app/workspace/foxtrotcommunications-avalon-public

# Copy workspace docs (auto-injected into AI system prompt)
COPY workspace/docs/ ./workspace/docs/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as non-root
RUN addgroup -g 1001 -S roundtable && \
    adduser -S roundtable -u 1001 -G roundtable && \
    chown -R roundtable:roundtable /app

USER roundtable

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node_modules/.bin/tsx", "server/index.js"]
