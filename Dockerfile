ARG NODE_IMAGE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production SPOOL_DIR=/data
LABEL org.opencontainers.image.source="https://github.com/MartinezAye/mwds-warcon-sidecar" org.opencontainers.image.licenses="MIT" org.opencontainers.image.description="Sends MyWardogsStats samples from a self-hosted Warcon"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
