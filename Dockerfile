# syntax=docker/dockerfile:1

ARG NODE_VERSION=20.11.1

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV CI=true \
    npm_config_loglevel=warn
COPY package*.json ./

FROM base AS development-deps
RUN npm ci

FROM development-deps AS build
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts

EXPOSE 3000
CMD ["npm", "run", "start:prod"]
