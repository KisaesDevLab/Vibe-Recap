# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation tini gosu curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY worker/pyproject.toml ./
COPY worker/recap ./recap
RUN pip install --upgrade pip && pip install ".[render]" \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*
COPY form-profiles /app/form-profiles
# Kokoro-82M narration model, baked in because the worker has no internet at runtime.
ARG KOKORO_BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
RUN mkdir -p /models \
 && curl -fsSL -o /models/kokoro-v1.0.onnx ${KOKORO_BASE}/kokoro-v1.0.onnx \
 && curl -fsSL -o /models/voices-v1.0.bin ${KOKORO_BASE}/voices-v1.0.bin
COPY worker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# uid 1000 matches the api container's `node` user so both can read /data/keys and blobs.
RUN mkdir -p /data /models && useradd -u 1000 -m worker \
 && chown -R worker:worker /data /models /app /ms-playwright \
 && chmod +x /usr/local/bin/docker-entrypoint.sh
ENV FORM_PROFILES_DIR=/app/form-profiles MODELS_DIR=/models
# Starts as root only to fix volume ownership, then drops to `worker` (see entrypoint).
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["python", "-m", "recap.jobs"]
