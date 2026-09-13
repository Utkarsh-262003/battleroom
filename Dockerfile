FROM node:22.23.2-bookworm-slim

WORKDIR /battleroom

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "app.js"]