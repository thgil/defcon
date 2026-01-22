FROM node:20-slim

WORKDIR /app

# Copy package files for all workspaces
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies (including dev for tsx and vite)
RUN npm ci --include=dev

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/client ./packages/client

# Build client (includes music and sound assets from public/)
RUN npm run build -w @defcon/client

# Set static directory for server
ENV STATIC_DIR=/app/packages/client/dist

# Expose port
EXPOSE 8080

# Start server
CMD ["npm", "run", "start", "-w", "@defcon/server"]
