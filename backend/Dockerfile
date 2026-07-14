# isolated-vm (the Automation Hub Code action's sandbox) is a native module —
# it needs a C++ toolchain to build on Alpine/musl. deps/builder compile it;
# the final runtime stage only copies the already-compiled node_modules/dist,
# so the toolchain never ships in the image that actually runs.
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
EXPOSE 3001
CMD ["node", "dist/index.js"]
