# Dugri runs as a small Node service: Express serves the static site/ AND the
# word-collection API. Data persists to DATA_DIR (a Railway volume, e.g. /data).
#
# The API also renders order PREVIEWS and full order PDFs by spawning the Python
# generator (generator/preview.py -> render_page/build), which needs Python 3 +
# Pillow + headless Chromium + the theme assets under resources/. So the image
# bundles that whole pipeline, not just the Node server.
FROM node:20-alpine
WORKDIR /app

# --- Preview/generator runtime: Python 3, Pillow, headless Chromium, fonts -----
# py3-pillow (community repo) avoids a heavy C build toolchain. Chromium ships the
# headless browser the generator screenshots SVG through. font-noto-hebrew +
# ttf-dejavu give the browser real glyph coverage (the card text itself uses the
# theme fonts embedded as base64 @font-face, but system fonts are a safety net
# and Chromium needs some installed to boot cleanly).
RUN apk add --no-cache \
      python3 \
      py3-pillow \
      chromium \
      font-noto-hebrew \
      ttf-dejavu

# Guarantee a stable chromium path regardless of the package's binary name, then
# expose a tiny wrapper that always injects the container-required flags. Running
# Chromium as root in a container needs --no-sandbox, and --disable-dev-shm-usage
# avoids crashes from the small default /dev/shm. Routing CHROME through this
# wrapper means every generator entrypoint (render_page.py, render_card.py AND
# build.py's board render) gets the flags, even the ones that build the argv
# themselves.
RUN test -e /usr/bin/chromium-browser \
      || ln -s "$(command -v chromium || echo /usr/lib/chromium/chrome)" /usr/bin/chromium-browser \
    && printf '#!/bin/sh\nexec /usr/bin/chromium-browser --no-sandbox --disable-dev-shm-usage "$@"\n' \
      > /usr/local/bin/chrome-headless \
    && chmod +x /usr/local/bin/chrome-headless

# Install server deps first (better layer caching)
COPY server/package*.json ./server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)

COPY server/ ./server/
COPY site/ ./site/

# The generator + only the theme assets the preview/order path reads at runtime:
# generator code, recipes, themes.json, the shared word-font pool, and each
# theme's clean/ background SVGs + fonts/ (the heavy filled/ reference exports are
# excluded via .dockerignore, so this stays lean).
COPY generator/ ./generator/
COPY resources/canva/templates/ ./resources/canva/templates/

ENV NODE_ENV=production
# CHROME -> the flag-injecting wrapper; PYTHON is what server/index.js spawns.
ENV CHROME=/usr/local/bin/chrome-headless \
    PYTHON=python3
# Railway sets $PORT; set a volume + DATA_DIR=/data in the Railway dashboard.
EXPOSE 3000
CMD ["node", "server/index.js"]
