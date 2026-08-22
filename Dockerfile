FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl wget unzip ca-certificates git jq \
      ffmpeg mediainfo python3 ripgrep tree && \
    rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# The runner spawns this CLI under the Claude Agent SDK.
RUN npm install -g @anthropic-ai/claude-code@latest

# node:24 already has user "node" with UID 1000; rename to "claude" (matches the NFS-mounted homes' ownership).
RUN usermod -l claude -d /home/claude -m node && groupmod -n claude node
USER 1000

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/claude/.bun/bin:$PATH"

WORKDIR /app
COPY --chown=claude:claude package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build --chown=claude:claude /app/dist ./dist

ENV NODE_ENV=production

# No ENTRYPOINT/CMD: the operator Deployment and every person Pod set
# `command` explicitly (dist/operator/index.js vs dist/runner/index.js).
