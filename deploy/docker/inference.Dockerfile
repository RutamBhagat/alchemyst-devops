FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS wheels
WORKDIR /build
# One compile job fits the E2 micro; do not bake the build host's CPU into GGUF kernels.
ENV CMAKE_ARGS="-DGGML_NATIVE=OFF -DGGML_OPENMP=OFF" \
    CMAKE_BUILD_PARALLEL_LEVEL=1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake \
    && rm -rf /var/lib/apt/lists/*
COPY quickstart/workers/inference-worker/requirements.txt ./
RUN pip wheel --no-cache-dir --require-hashes -r requirements.txt --wheel-dir /wheels

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_DIR=/models/huggingface
COPY --from=wheels /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels iii-sdk==0.24.4 iii-helpers==0.24.4 llama-cpp-python==0.3.36 Jinja2==3.1.6 \
    && rm -rf /wheels \
    && useradd --create-home --uid 10001 worker \
    && mkdir -p /models/huggingface \
    && chown -R worker:worker /app /models
COPY quickstart/workers/inference-worker/*.py ./
USER worker
CMD ["python", "inference_worker.py"]
