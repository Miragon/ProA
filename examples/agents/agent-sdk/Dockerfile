# The ProA Agent SDK worker as an image (README.md). Not built or run by ProA's CI.
#   docker build -t proa-agent-sdk-worker examples/agents/agent-sdk
#   docker run --rm --network host -e PROA_TOKEN -e ANTHROPIC_API_KEY \
#     proa-agent-sdk-worker --project nordwind-handel --model claude-sonnet-5-5
# (ProA's local mode accepts only localhost Host headers, hence the host network.)
# Same Node as ProA's image; Node runs the TypeScript source directly (type stripping).
FROM node:24.21.0-trixie-slim

WORKDIR /app
# package.json pins the direct dependencies exactly; there is no lockfile, so
# transitive versions resolve at build time. The SDK's optional dependency
# for this platform carries the Claude Code binary.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src

USER node
ENTRYPOINT ["node", "src/worker.ts"]
