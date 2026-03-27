# Build do frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

# Build da aplicação final
FROM node:20-alpine
WORKDIR /app

# Instalar dependências do backend
COPY package*.json ./
RUN npm ci --only=production

# Copiar código do backend
COPY server/ ./server/

# Copiar frontend buildado para ser servido pelo Express
COPY --from=frontend-builder /app/client/build ./server/public

EXPOSE 3001

CMD ["node", "server/index.js"]
