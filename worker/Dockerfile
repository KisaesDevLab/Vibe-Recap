# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation tini \
 && rm -rf /var/lib/apt/lists/*
COPY worker/pyproject.toml ./
COPY worker/recap ./recap
RUN pip install --upgrade pip && pip install ".[render]" \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*
COPY form-profiles /app/form-profiles
RUN mkdir -p /data /models && useradd -r -u 1001 worker && chown -R worker:worker /data /models /app /ms-playwright
USER worker
ENV FORM_PROFILES_DIR=/app/form-profiles MODELS_DIR=/models
ENTRYPOINT ["tini", "--"]
CMD ["python", "-m", "recap.jobs"]
