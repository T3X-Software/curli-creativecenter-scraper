FROM mcr.microsoft.com/playwright:v1.58.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install

COPY server.js ./
ENV NODE_ENV=production

# Railway injeta PORT. A app já usa process.env.PORT
CMD ["npm", "start"]

