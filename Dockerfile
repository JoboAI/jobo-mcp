FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV JOBO_API_URL=https://connect.jobo.world
ENV OAUTH_AUTH_SERVER_URL=https://enterprise.jobo.world
# Distinct host from the analytics server (mcp.jobo.world) — the resource URL is
# the OAuth audience, so the two must not share one.
ENV MCP_RESOURCE_URL=https://jobs-mcp.jobo.world
ENV PORT=3002

EXPOSE 3002

CMD ["node", "dist/index.js"]
