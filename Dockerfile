# syntax=docker/dockerfile:1.7
ARG PLAYWRIGHT_VERSION=1.62.1

FROM node:24-bookworm-slim AS frontend-builder
WORKDIR /app
RUN npm install --global pnpm@10.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY bridge/package.json bridge/package.json
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY frontend frontend
RUN pnpm --dir frontend run build

FROM rust:1.97.1-bookworm AS rust-builder
WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
       build-essential \
       ca-certificates \
       clang \
       libayatana-appindicator3-dev \
       libdbus-1-dev \
       libgbm-dev \
       libgtk-3-dev \
       libclang-dev \
       libpipewire-0.3-dev \
       librsvg2-dev \
       libssl-dev \
       libwayland-dev \
       libwebkit2gtk-4.1-dev \
       libx11-dev \
       libxcursor-dev \
       libxdo-dev \
       libxi-dev \
       libxinerama-dev \
       libxrandr-dev \
       pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock build.rs tauri.conf.json ./
COPY src src
COPY icons icons
COPY capabilities capabilities
COPY bridge bridge
COPY --from=frontend-builder /app/frontend/dist frontend/dist
RUN cargo build --release

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runtime
ENV SCREEN_AGENT_BIND_ADDR=0.0.0.0 \
    SCREEN_AGENT_PORT=8787 \
    SCREEN_AGENT_HOTKEY= \
    SCREEN_AGENT_RUNTIME=/data/runtime \
    SCREEN_AGENT_CHATGPT_HEADLESS=true \
    SCREEN_AGENT_IMAGE_HEADLESS=true \
    SCREEN_AGENT_BROWSER_HEADLESS=true \
    GDK_BACKEND=x11 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER root
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
       dbus-x11 \
       libayatana-appindicator3-1 \
       libpipewire-0.3-0 \
       libwebkit2gtk-4.1-0 \
       libxdo3 \
       librsvg2-2 \
       tini \
       xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 screenagent \
    && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/screenagent screenagent
WORKDIR /app
COPY --from=rust-builder /app/target/release/screen-agent /usr/local/bin/screen-agent
COPY --from=frontend-builder /app/frontend/dist frontend/dist
COPY bridge/index.mjs bridge/image-upload.mjs bridge/package.json bridge/package-lock.json bridge/
COPY bridge/rustproxyhub bridge/rustproxyhub
RUN cd bridge \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && mkdir -p /data/runtime/captures /tmp/runtime-screen-agent \
    && chown -R screenagent:screenagent /app /data/runtime /tmp/runtime-screen-agent
ENV HOME=/home/screenagent \
    XDG_RUNTIME_DIR=/tmp/runtime-screen-agent
USER screenagent
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1920x1080x24", "/usr/local/bin/screen-agent"]
