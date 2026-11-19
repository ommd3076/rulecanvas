FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4178 RULECANVAS_HOST=0.0.0.0
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/node_modules ./node_modules
USER node
EXPOSE 4178
CMD ["node", "src/start-hosted.mjs"]
