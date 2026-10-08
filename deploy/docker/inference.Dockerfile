FROM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322 AS wheels
WORKDIR /build
# The official CPU wheel links musl. Never fall back to compiling on a micro.
COPY quickstart/workers/inference-worker/requirements.txt ./
RUN pip download --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt --dest /wheels

FROM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_DIR=/models/huggingface
COPY --from=wheels /wheels /wheels
RUN apk add --no-cache libstdc++ libgomp \
    && pip install --no-cache-dir --no-index --find-links=/wheels iii-sdk==0.24.4 iii-helpers==0.24.4 llama-cpp-python==0.3.19 Jinja2==3.1.6 \
    && rm -rf /wheels \
    && adduser -D -u 10001 worker \
    && mkdir -p /models/huggingface \
    && chown -R worker:worker /app /models
COPY quickstart/workers/inference-worker/*.py ./
USER worker
CMD ["python", "inference_worker.py"]
