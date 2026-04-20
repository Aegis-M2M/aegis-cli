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

# 3. Copy the actual source code for all packages
COPY packages/ ./packages/

# 4. Expose the daemon port
EXPOSE 23447

# 5. Updated command to point to the new nested entry point
# Using 'daemon' instead of 'start' to match your latest CLI logic
CMD ["npx", "tsx", "packages/cli/src/cli.ts", "daemon", "--port", "23447"]