# my-jizhang 家庭记账本镜像
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

COPY server.mjs ./
COPY public ./public

RUN mkdir -p /data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server.mjs"]
