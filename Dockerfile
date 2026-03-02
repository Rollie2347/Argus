FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --production

# Copy application code
COPY backend/server.js backend/agents.js ./
COPY frontend/ ./frontend/

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]
