# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
COPY AGENTS.md ./
COPY extensions ./extensions
COPY config.example.yaml ./

# 运行数据：SQLite + 模型规范版；wg 配置由 compose 挂载 /etc/wireguard
RUN mkdir -p /data && chmod 700 /data
VOLUME ["/data"]

EXPOSE 60380
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js", "--config", "/app/config/config.yaml"]
