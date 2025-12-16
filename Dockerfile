# ══════════════════════════════════════════════════════════════════════════════
# PRE-MAYHEM - PRODUCTION DOCKERFILE
# ══════════════════════════════════════════════════════════════════════════════
# For Railway deployment. Treasury keypair must be mounted as volume.

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Production stage
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data and public directories
RUN mkdir -p data public logs

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose status API port
EXPOSE 3001

# Health check (optional, for monitoring)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/status || exit 1

# Start command
CMD ["node", "dist/index.js"]
