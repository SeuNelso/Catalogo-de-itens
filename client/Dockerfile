# Build do frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Servir frontend
FROM node:20-alpine
WORKDIR /app
RUN npm install -g serve
COPY --from=frontend-builder /app/build ./build
EXPOSE 3000
CMD ["serve", "-s", "build", "-l", "3000"]
