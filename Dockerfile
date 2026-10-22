FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ARG RELEASE_VERSION=development
ARG DATA_CONTRACT=development
LABEL org.opencontainers.image.source="https://github.com/dabiao996/dbtv" \
      org.opencontainers.image.version=$RELEASE_VERSION \
      io.dbtv.data-contract=$DATA_CONTRACT
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Prisma CLI must remain available: the selected connector is generated on startup.
RUN npm ci --ignore-scripts
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/release.json ./release.json
COPY --from=build /app/deploy ./deploy
COPY --from=build /app/.generated/install-clients ./.generated/install-clients
COPY scripts ./scripts
RUN mkdir -p /app/data && chmod +x /app/scripts/start.sh
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["npm", "start"]
