FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

COPY server/package.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund

COPY server/server.js ./server.js
RUN chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production
ENV PORT=3210
ENV MAX_CONCURRENT_RENDERS=1

EXPOSE 3210

CMD ["npm", "start"]
