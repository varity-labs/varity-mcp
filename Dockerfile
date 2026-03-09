FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy built dist/
COPY dist ./dist

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

EXPOSE 3100

CMD ["node", "dist/index.js", "--transport", "http", "--port", "3100"]
