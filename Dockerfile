# syntax=docker/dockerfile:1
# Image: us-central1-docker.pkg.dev/roundtable-public/roundtable/roundtable-core:latest
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
    apk add --no-cache --virtual .build-deps gcc g++ musl-dev python3-dev freetype-dev libpng-dev && \
    pip3 install --no-cache-dir --break-system-packages matplotlib numpy pandas && \
    apk del .build-deps

# Copy package files and local packages, install production deps
# tsx handles TypeScript at runtime — no compile step needed for local packages
ARG CACHEBUST=1
COPY package*.json ./
COPY packages/ ./packages/
RUN npm install --omit=dev --omit=optional

# TypeScript is precompiled at build time (esbuild step after the server COPY
# below) — the runtime is plain node. This removes the per-boot transpile from
# the wake path and retires the global-tsx workaround that lived here (a local
# `npm install tsx` was silently pruned against the lockfile; global installs
# were the fix — now nothing TS-aware is needed at runtime at all).

# Optional private plugins (e.g. @pendragon/tools-plaid) from Artifact Registry.
# Installed only when a PLUGINS build-arg AND a gar_token BuildKit secret are
# provided — public builds without them are unaffected. --no-save keeps
# package.json pristine; the token is read from the secret mount so it never
# lands in an image layer. See packages/README.md.
ARG PLUGINS=""
RUN --mount=type=secret,id=gar_token,required=false,uid=0 \
    if [ -n "$PLUGINS" ] && [ -s /run/secrets/gar_token ]; then \
      echo "@pendragon:registry=https://us-central1-npm.pkg.dev/roundtable-public/pendragon-npm/" > /tmp/.npmrc-plugins && \
      echo "//us-central1-npm.pkg.dev/roundtable-public/pendragon-npm/:_authToken=$(cat /run/secrets/gar_token)" >> /tmp/.npmrc-plugins && \
      npm install --omit=dev --no-save --userconfig /tmp/.npmrc-plugins $PLUGINS && \
      rm -f /tmp/.npmrc-plugins; \
    fi

# Copy server source
COPY server/ ./server/
COPY public/ ./public/

# ─── Precompile TypeScript → sibling .js (build-time, esbuild) ───
# The server tree mixes .js and .ts; transpiling each .ts to a sibling .js
# (CJS, same transform tsx applies at runtime) lets plain `node` resolve every
# extensionless require. The @pendragon plugin ships TS sources with
# `main: src/index.ts`, so its src tree gets the same treatment plus a main
# rewrite. esbuild is removed afterwards — nothing TS-aware ships at runtime.
RUN npm install -g esbuild@0.25.6 && \
    find server -name '*.ts' ! -name '*.d.ts' -print0 | \
      xargs -0 esbuild --outdir=server --outbase=server \
        --format=cjs --platform=node --target=es2022 --log-level=error && \
    if [ -d node_modules/@pendragon/tools-plaid/src ]; then \
      find node_modules/@pendragon/tools-plaid/src -name '*.ts' ! -name '*.d.ts' -print0 | \
        xargs -0 esbuild --outdir=node_modules/@pendragon/tools-plaid/src \
          --outbase=node_modules/@pendragon/tools-plaid/src \
          --format=cjs --platform=node --target=es2022 --log-level=error && \
      # main → compiled entry; drop "type": "module" so the CJS-compiled .js
      # siblings load as CJS (core consumes the plugin via require throughout —
      # node 20 cannot require() ESM). Verified: both the bare package require
      # and the deep src/domains/* requires load under plain node after this.
      sed -i -e 's#"main": "src/index.ts"#"main": "src/index.js"#' \
             -e 's#"type": "module",##' node_modules/@pendragon/tools-plaid/package.json; \
    fi && \
    npm uninstall -g esbuild

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

CMD ["node", "server/index.js"]
