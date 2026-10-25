# =============================================================================
# NyaySetu API
#
# WHY A DOCKERFILE AND NOT A BUILDPACK
#   Nixpacks and Render's Node builder both infer what to do, and the inference is
#   where deployments break: package.json says node >=20, which one builder
#   resolved to 26.10.0 and another failed on outright. A Dockerfile removes the
#   guessing — the same image builds on Railway, Render, Fly or a laptop, and the
#   Node version is a fact rather than a resolution.
#
# BUILD CONTEXT
#   This expects the build context to be THIS directory, not the repository root.
#   On Railway that means Root Directory = backend; on Render, rootDir: backend.
#   Nothing outside backend/ is needed to build the API.
# =============================================================================

# Pinned to a major, not to >=20. Slim rather than alpine: the project builds no
# native modules, but bcryptjs and pdfkit on musl is an avoidable class of problem
# for the sake of thirty megabytes.
FROM node:22-slim AS build

WORKDIR /app

# Dependencies first, as their own layer. Source changes far more often than the
# lockfile, so this layer survives almost every rebuild.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# tsc emits JavaScript; copyAssets carries the things tsc does not compile — the
# inline email logo and the BNS section reference the API reads at runtime.
RUN npm run build

# Drop the dev dependencies rather than reinstalling in the runtime stage, which
# would need the lockfile resolved twice.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime ----
FROM node:22-slim AS runtime

# Unprivileged. The node image ships a `node` user for this; nothing here needs
# root, and a container that runs as root is one exploit away from being a host.
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Where encrypted blobs land when Pinata is not configured. Created and owned
# here, because the process cannot create it as a non-root user at runtime.
RUN mkdir -p /app/storage/blobs && chown -R node:node /app/storage

USER node

# The platform sets PORT and the app reads it. Declared for documentation and for
# `docker run -p`; it is not what binds the port.
EXPOSE 4000

# No npm in the entrypoint: npm forwards signals poorly, and a container that does
# not stop on SIGTERM is one the platform kills instead — which interrupts the
# sweep jobs mid-write rather than letting them finish.
CMD ["node", "dist/index.js"]
