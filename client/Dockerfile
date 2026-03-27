# Stage 1: build frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY client/package*.json ./client/
RUN npm ci && cd client && npm ci
COPY . .
RUN npm run build
# Stage 2: runtime backend + static frontend
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY --from=builder /app/client/build ./client/build
EXPOSE 3001
CMD ["npm", "start"]
