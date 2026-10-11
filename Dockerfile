FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY backend ./backend
COPY public ./public
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "backend/server.js"]
