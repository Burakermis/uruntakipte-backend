# Backend imajı: API (server.js) ve worker (queue/worker-process.js) AYNI imajı
# kullanır, yalnızca komut değişir:
#   API:    node server.js
#   Worker: node queue/worker-process.js
#
# Taban imaj Playwright'ın resmi imajı: Chromium ve sistem kitaplıkları hazır.
# SÜRÜM, package.json/package-lock'taki `playwright` ile BİREBİR aynı olmalı —
# aksi halde Playwright kendi Chromium sürümünü bulamaz. Playwright'ı yükseltirsen
# bu etiketi de değiştir.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=4000

WORKDIR /app

# Bağımlılıklar kaynak koddan önce: kod değişince katman önbelleği bozulmaz.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# H&M gibi "pencereli" tarayıcı isteyen markalar için sanal ekran başlatır
# (bkz. scraper/browserFetch.js launchBrowser 'headed').
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh && chown -R pwuser:pwuser /app

# Root olmadan çalış (Chromium'u ele geçiren biri konteynerde root olmasın).
USER pwuser

EXPOSE 4000

# Yalnızca API için anlamlı; worker'ın portu yok (compose'ta kapatılır).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
