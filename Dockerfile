FROM node:20-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy package manifests and install production dependencies
COPY package.json ./
RUN npm install --production

# Copy application source code and public assets
COPY . .

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "src/app.js"]
