# Single-stage Node 20 image — express + static frontend + Gemini.
FROM node:20-alpine

WORKDIR /app

# Files v repu jsou na úrovni root (GitHub web upload je flat) — přesun do struktury.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

RUN mkdir -p public
COPY server.js ./
COPY index.html ./public/index.html

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
