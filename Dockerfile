FROM node:22-slim

WORKDIR /app

# Install backend dependencies
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy application code
COPY backend/*.js ./backend/
COPY backend/.env.example ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend

EXPOSE 8080

CMD ["node", "server.js"]
