# Use the root of the workspace as the build context
FROM node:20-slim

WORKDIR /app

# 1. Copy the root workspace config and ALL package manifests
# This allows npm to handle hoisting and symlinking correctly
COPY package*.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/

# 2. Install dependencies for the entire workspace
# This will link @aegis-m2m/client into the @aegis-m2m/cli node_modules
RUN npm ci

# Playwright bundles only the Node driver in npm — browsers live under ~/.cache/ms-playwright.
# Without this step the daemon fails on boot when BrowserManager tries to launch Chromium.
#
# Omit `--with-deps`: it runs `apt-get` on Debian and can fail in Docker Desktop with GPG /
# "invalid signature" mirror errors while downloading browsers works fine via Playwright CDN.
# If Chromium exits at runtime with missing shared-library errors, rebuild after fixing apt,
# or base this image on `mcr.microsoft.com/playwright:<version>-jammy`.
RUN npx playwright install chromium

# 3. Copy the actual source code for all packages
COPY packages/ ./packages/

# 4. Expose the daemon port
EXPOSE 23447

# 5. Hub daemon: entry is main.ts (replaces legacy cli.ts)
CMD ["npx", "tsx", "packages/cli/src/main.ts", "--port", "23447"]