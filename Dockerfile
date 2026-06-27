FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml tsconfig.json vite.config.ts biome.json index.html ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml tsconfig.json biome.json ./
COPY src ./src
COPY --from=build /app/dist ./dist
CMD ["bun", "run", "start"]
