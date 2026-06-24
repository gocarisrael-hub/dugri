# Dugri runs as a small Node service: Express serves the static site/ AND the
# word-collection API. Data persists to DATA_DIR (a Railway volume, e.g. /data).
FROM node:20-alpine
WORKDIR /app

# Install server deps first (better layer caching)
COPY server/package*.json ./server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)

COPY server/ ./server/
COPY site/ ./site/

ENV NODE_ENV=production
# Railway sets $PORT; set a volume + DATA_DIR=/data in the Railway dashboard.
EXPOSE 3000
CMD ["node", "server/index.js"]
