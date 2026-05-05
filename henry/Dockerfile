FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
# `npm install` works without a package-lock.json. Switch to `npm ci` later
# once a lockfile is committed (faster + reproducible builds).
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
