FROM node:20-alpine AS runtime

WORKDIR /app

# Git is required for git_clone, git_status tools
RUN apk add --no-cache git

# Copy package files and install production deps
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY server/ ./server/
COPY public/ ./public/

# Create workspace directory
RUN mkdir -p /app/workspace

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
