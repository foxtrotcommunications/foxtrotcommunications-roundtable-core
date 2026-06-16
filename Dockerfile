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
# Python + matplotlib/numpy for charting and data analysis
RUN apk add --no-cache git python3 py3-pip && \
    pip3 install --no-cache-dir --break-system-packages matplotlib numpy pandas

# Copy package files and .npmrc for @pendragon scoped registry, install production deps
COPY package*.json .npmrc ./
ARG NPM_TOKEN
RUN if [ -n "$NPM_TOKEN" ]; then \
      echo "//us-central1-npm.pkg.dev/roundtable-public/pendragon-npm/:_authToken=$NPM_TOKEN" >> .npmrc; \
    fi && \
    npm ci --omit=dev --omit=optional && \
    npm install tsx && \
    sed -i '/_authToken/d' .npmrc

# Copy source
COPY server/ ./server/
COPY public/ ./public/

# Copy React client build from stage 1
COPY --from=client-build /build/dist ./client/dist/

# Create workspace directory
RUN mkdir -p /app/workspace

# Copy immutable platform documentation (read-only AI reference)
COPY .roundtable/ ./.roundtable/

# Copy workspace docs (auto-injected into AI system prompt)
COPY workspace/docs/ ./workspace/docs/
COPY workspace/uploads/ ./workspace/uploads/

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
