# isolated-vm (the Automation Hub Code action's sandbox) is a native module —
# it needs a C++ toolchain to build on Alpine/musl. deps/builder compile it;
# the final runtime stage only copies the already-compiled node_modules/dist,
# so the toolchain never ships in the image that actually runs.
#
# B8: base image pinned by DIGEST (not a floating tag) for reproducible
# builds — `node:22-alpine` resolved to this exact digest (node v22.23.2) at
# the time this Dockerfile was written; re-pin deliberately (not silently)
# when bumping Node. A floating `:22-alpine` tag can point at a different
# image tomorrow with no diff to review.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# B8 — hardened runtime stage: non-root, minimal writable surface.
#
# The base `node:22-alpine` image already ships an unprivileged `node` user
# (uid/gid 1000) — no new user needs to be created. `/app` (code + deps) is
# owned by `node` but the process never writes there at runtime; the ONLY
# paths this process writes to are `UPLOAD_DIR` (a dedicated volume, see
# docker-compose.yml's `gps_uploads` mount) and `/tmp` (a tmpfs mount in
# compose, for any native-module/library scratch file — nothing in this
# codebase's own src/ writes to /tmp, but this is cheap insurance against a
# dependency that does, so `read_only: true` at the compose level doesn't
# have to be re-litigated every time a new dependency is added). Combined
# with docker-compose.yml's `read_only: true` + `cap_drop: [ALL]` +
# `security_opt: [no-new-privileges:true]` + PID/CPU/memory limits, a
# compromised process has nowhere to persist a payload, cannot escalate
# privileges, and cannot exhaust the host.
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package*.json ./
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
