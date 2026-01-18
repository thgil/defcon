FROM node:20-slim

WORKDIR /app

# Copy package files for all workspaces
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies (including dev for tsx)
RUN npm ci --include=dev

# Copy source code
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Expose port
EXPOSE 8080

# Start server
CMD ["npm", "run", "start", "-w", "@defcon/server"]
