# Frontend: Vite SPA (static files served with `serve`)

FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN pnpm exec vite build

FROM node:20-bookworm-slim

WORKDIR /app
RUN npm install -g serve@14

COPY --from=builder /app/dist/public ./dist/public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/',res=>process.exit(res.statusCode>=200&&res.statusCode<400?0:1)).on('error',()=>process.exit(1))"

CMD ["serve", "-s", "dist/public", "-l", "3000"]
