# ================================================
# Build Stage
# ================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* pnpm-lock.yaml* ./

# Install dependencies
RUN npm install

# Copy source code
COPY backend/src ./src
COPY backend/tsconfig.json ./

# Build TypeScript
RUN npm run build

# ================================================
# Production Stage
# ================================================
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install --production

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Create database directory
RUN mkdir -p /app/data

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/healthz', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Expose port
EXPOSE 8000

# Start application
CMD ["node", "dist/index.js"]
