FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc rolldown.config.ts ./
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build:client && npm prune --omit=dev

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY package.json ./
COPY src ./src
# named volume は初回マウント時にイメージ側ディレクトリの所有権を引き継ぐため、
# node ユーザーで init / 書き込みできるよう VOLUME 宣言より前に所有権を設定する。
# bind mount の場合はホスト側の所有権合わせが運用者の責任（docs/ops.md 参照）。
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["node", "src/cli/main.ts"]
CMD ["serve", "--data", "/data", "--port", "3000", "--hostname", "0.0.0.0"]
