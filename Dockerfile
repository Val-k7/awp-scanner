# AWP scanner — runs the Playwright client in a container that already bundles a
# WORKING Chromium + all its system libraries. This is the easiest way to run on
# NixOS (avoids the non-FHS dynamic-linking issues of Playwright's downloaded
# browser): the official Playwright image ships the browser under
# /ms-playwright and sets PLAYWRIGHT_BROWSERS_PATH, so no host Chromium is needed.
#
# The scanner DIALS OUT to the Worker over a WebSocket (no inbound port needed);
# the exposed 8080 is only a local /healthz for ops checks.
#
# The image tag MUST match the `playwright` npm version in package.json (^1.49).
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install only the npm dependency (playwright). No lockfile is shipped, so use
# `npm install`. Browsers are already present in the base image.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
# SCAN_TOKEN (and optional WORKER_WS_URL) are injected at run time — never bake
# secrets into the image.
EXPOSE 8080

# Drop to the non-root user the Playwright image provides.
USER pwuser

CMD ["node", "src/client.js"]
