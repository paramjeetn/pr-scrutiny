FROM node:22-alpine

WORKDIR /app

# Install all deps (including devDeps for tsc)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

# Prune devDeps after build
RUN npm prune --omit=dev

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/server.js"]
