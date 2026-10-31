# 反骨 · 每日辩题 —— 部署镜像
# 零依赖 Node，无需 npm install；数据落在 /app/data（挂卷即可持久化）

FROM node:20-alpine

WORKDIR /app

# 只拷运行所需文件
COPY server.js package.json ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
# 容器里只需要参与者端口；运营端口留给内网或另开实例
ENV ADMIN_PORT=0
# 想持久化就挂一个卷到 /data，并把 DATA_DIR 指过去
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
