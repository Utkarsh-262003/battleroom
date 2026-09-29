FROM node:22.23.2-bookworm-slim

WORKDIR /battleroom

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

# The commit this image was built from, shown on /healthz so the
# pipeline can check the live site runs what it just deployed.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "app.js"]