# syntax=docker/dockerfile:1
FROM node:22.23.4-slim

# Fixed local OCR runtime; English only. No runtime model downloads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && test -r /usr/share/tesseract-ocr/5/tessdata/eng.traineddata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (including devDependencies for build)
COPY package.json package-lock.json* ./
RUN npm ci --strict-ssl=true

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Remove devDependencies after build
RUN npm prune --omit=dev

# Create data directory for token storage
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
