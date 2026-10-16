FROM node:24-alpine

# 统计「今日」按北京时间算
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_FILE=/app/data/app.db

WORKDIR /app
# 零依赖，直接拷代码
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "server.js"]
