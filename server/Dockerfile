# PaceLeague API. Build context: the repository root (it needs db/ for migrations and legal/ for
# the Privacy Policy and Terms pages).
FROM node:22-bookworm-slim AS build
WORKDIR /srv
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/build.mjs ./
COPY server/src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /srv/dist ./dist
COPY db/platform ./db/platform
COPY db/migrations ./db/migrations
COPY db/templates ./db/templates
COPY legal ./legal
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/main.js"]
