# Etapa de build: aquí sí hacen falta python3/make/g++ para compilar better-sqlite3
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# Etapa final: imagen limpia, sin toolchain de compilación, sin usuario root
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app ./
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
