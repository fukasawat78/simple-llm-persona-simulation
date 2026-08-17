FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=4173 \
    ALLOW_DEMO_MODE=false

WORKDIR /app

COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node config ./config
COPY --chown=node:node public ./public
COPY --chown=node:node sample_data ./sample_data

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "server.mjs"]
