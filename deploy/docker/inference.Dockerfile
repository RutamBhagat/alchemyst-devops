FROM python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface
WORKDIR /app

COPY quickstart/workers/inference-worker/requirements.in ./requirements.in
RUN python -m pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu torch==2.12.1 \
    && grep -v '^torch==' requirements.in > /tmp/requirements-no-torch.txt \
    && python -m pip install --no-cache-dir -r /tmp/requirements-no-torch.txt \
    && rm /tmp/requirements-no-torch.txt

COPY quickstart/workers/inference-worker/inference_worker.py ./inference_worker.py
RUN mkdir -p /models/huggingface

CMD ["python", "inference_worker.py"]
