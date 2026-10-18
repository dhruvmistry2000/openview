# Node 22 is required for the read-only session listing (node:sqlite).
FROM node:22-bookworm-slim

WORKDIR /app

COPY server.mjs index.html ./
COPY css ./css
COPY js ./js
COPY logo ./logo
COPY lib ./lib

# 0.0.0.0 is required when Docker publishes a port into this container.
# Compose uses host networking and overrides HOST (see docker-compose.yml).
ENV HOST=0.0.0.0 \
    PORT=8080 \
    OPENCODE_URL=http://127.0.0.1:4096 \
    OPENCODE_DB=/data/opencode/opencode.db

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
