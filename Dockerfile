FROM node:20-alpine

WORKDIR /app

# 审计应用为纯静态前端 + 零依赖 Node 服务，无需 npm install
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY tests ./tests
COPY scripts ./scripts
COPY verify ./verify

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
