# Multi-stage build for Next.js
# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Disable telemetry during runtime
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Create data directory for history storage
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# Switch to non-root user
USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
