FROM node:24-bookworm-slim

WORKDIR /app
ARG COMMIT_SHA=local
ENV NODE_ENV=production \
    COMMIT_SHA=${COMMIT_SHA} \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/reflex.sqlite

# The application uses only Node.js built-ins; no npm install is needed.
COPY package.json server.mjs ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY public/ ./public/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "server.mjs"]
