# Multi-stage build for smaller image size
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci --only=production && npm cache clean --force

# Production stage
FROM node:20-alpine AS production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S minecraft -u 1001 -G nodejs

# Set working directory
WORKDIR /app

# Copy dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY --chown=minecraft:nodejs package*.json ./
COPY --chown=minecraft:nodejs *.js ./
COPY --chown=minecraft:nodejs config-example.json ./

# Create config directory and set proper permissions
RUN mkdir -p /app/config && chown -R minecraft:nodejs /app

# Switch to non-root user
USER minecraft

# Expose the Minecraft proxy port
EXPOSE 25565

# Health check to ensure the service is running
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD timeout 3 nc -z localhost 25565 || exit 1

# Use the long-running server by default for production stability
CMD ["node", "reverse-proxy-server-long.js"]