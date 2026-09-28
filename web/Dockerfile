# PaceLeague web app (docs/ROADMAP.md P.2). Build context: the repository root.
# The app's public settings are baked into the bundle at build time, so pass them as build args
# (Railway passes a service's variables to the build). Nothing secret belongs here.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG EXPO_PUBLIC_APP_ENV=production
ARG EXPO_PUBLIC_API_URL
ARG EXPO_PUBLIC_API_KEY
ARG EXPO_PUBLIC_PRIVACY_URL
ARG EXPO_PUBLIC_TERMS_URL
ARG EXPO_PUBLIC_SUPPORT_EMAIL
ARG EXPO_PUBLIC_EMAIL_SIGN_IN=password
ENV EXPO_PUBLIC_APP_ENV=$EXPO_PUBLIC_APP_ENV \
    EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL \
    EXPO_PUBLIC_API_KEY=$EXPO_PUBLIC_API_KEY \
    EXPO_PUBLIC_PRIVACY_URL=$EXPO_PUBLIC_PRIVACY_URL \
    EXPO_PUBLIC_TERMS_URL=$EXPO_PUBLIC_TERMS_URL \
    EXPO_PUBLIC_SUPPORT_EMAIL=$EXPO_PUBLIC_SUPPORT_EMAIL \
    EXPO_PUBLIC_EMAIL_SIGN_IN=$EXPO_PUBLIC_EMAIL_SIGN_IN \
    EXPO_NO_TELEMETRY=1 \
    CI=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY . .
RUN test -n "$EXPO_PUBLIC_API_URL" && test -n "$EXPO_PUBLIC_API_KEY" \
  && node scripts/check-client-secrets.mjs \
  && npx expo export --platform web --output-dir dist-web

FROM node:22-bookworm-slim
ENV NODE_ENV=production WEB_DIR=/srv/dist-web
WORKDIR /srv
COPY scripts/web/serve.mjs ./serve.mjs
COPY --from=build /app/dist-web ./dist-web
USER node
EXPOSE 8080
CMD ["node", "serve.mjs"]
