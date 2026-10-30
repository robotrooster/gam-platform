# GAM storefront image (GCP plan C, Cloud Run `gam-storefront`): the guest
# site every {slug}.gam.biz host serves. apps/storefront/server.js is plain
# node:http with an SPA fallback, so the runtime is just Node + dist/.
# Build from the repo root:  docker build -f deploy/gcp/storefront.Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY . .
# The root workspace carries the @fontsource packages the storefront imports.
RUN npm ci -w packages/shared -w apps/storefront --include-workspace-root
RUN npm run build -w packages/shared && npm run build -w apps/storefront

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/apps/storefront/server.js ./server.js
COPY --from=build /app/apps/storefront/dist ./dist
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.js"]
