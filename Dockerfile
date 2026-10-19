# Zero npm dependencies: the image is just Node + this folder.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/event.db
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
