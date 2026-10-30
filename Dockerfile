# GAM API image (GCP plan B1) — one image, three Cloud Run roles:
#   gam-api        node dist/index.js            (RUN_SCHEDULER=0)
#   gam-scheduler  node dist/index.js            (crons on, internal only)
#   gam-migrate    node dist/db/migrate.js       (Cloud Run job, before rollout)
#
# The layout mirrors the Mac's: /app/apps/api with src/, dist/, migrations
# and the geo/census/
# elections data the metrics pages read relative to dist/; /app/legal for the
# FlexPay/FlexDeposit terms. glibc base (bookworm), never alpine: the
# @napi-rs/canvas prebuilts are glibc builds. No bundler — pdfjs-dist needs an
# intact node_modules.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY . .

FROM base AS build
# tsc -b over the API outgrows Node's default ~2 GB heap.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm ci -w packages/shared -w apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api

FROM base AS runtime
RUN npm ci --omit=dev -w packages/shared -w apps/api && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
# ts-node is a dev dependency, so the migrate runner and ops CLIs run
# compiled; migrate.js reads its .sql files from beside itself.
COPY apps/api/src/db/migrations apps/api/dist/db/migrations
ENV NODE_ENV=production \
    PORT=8080 \
    LOG_TO_STDOUT=1 \
    SKIP_SCHEMA_DUMP=1
WORKDIR /app/apps/api
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
