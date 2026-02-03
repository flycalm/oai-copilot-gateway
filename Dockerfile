FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build:node

FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8788

COPY --from=build /app/dist ./dist

EXPOSE 8788
CMD ["node", "dist/server.mjs"]
