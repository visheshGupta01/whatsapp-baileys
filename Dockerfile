FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY supabase ./supabase
COPY README.md ./

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
