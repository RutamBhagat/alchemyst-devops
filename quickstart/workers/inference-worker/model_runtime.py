"""CPU-only quantized inference with bounded memory and one request at a time."""
import hashlib
import os
import shutil
import threading
import urllib.request
from pathlib import Path
from typing import Any

from llama_cpp import Llama
from prompting import format_prompt

MODEL_FILE = "gemma-3-270m-Q8_0.gguf"
MODEL_REVISION = "360e988e4c99209d62d171ca1a46aceb4b224791"
MODEL_SHA256 = "e00cf79514204dfe2f4d6943f277ffea7fd8a4c8e955b4b7a869cfc157694881"
MODEL_URL = f"https://huggingface.co/ggml-org/gemma-3-270m-GGUF/resolve/{MODEL_REVISION}/{MODEL_FILE}"


def model_path() -> Path:
    directory = Path(os.environ.get("MODEL_DIR", "/models/huggingface"))
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / MODEL_FILE
    if not path.exists():
        # Single streaming download: no Torch or Xet allocation spike; partial files
        # must never become a cache hit after a restart.
        partial = path.with_suffix(".part")
        with urllib.request.urlopen(MODEL_URL, timeout=120) as source, partial.open("wb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        with partial.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != MODEL_SHA256:
                partial.unlink()
                raise ValueError("Downloaded GGUF checksum mismatch")
        partial.replace(path)
    else:
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != MODEL_SHA256:
                raise ValueError("Cached GGUF checksum mismatch; remove the corrupt model file")
    return path


class InferenceRuntime:
    def __init__(self) -> None:
        self.model = Llama(
            model_path=str(model_path()), n_ctx=2048, n_batch=64,
            n_threads=1, n_threads_batch=1, use_mmap=True, verbose=False,
        )
        self.lock = threading.Lock()

    def run(self, payload: dict[str, Any]) -> dict[str, str]:
        prompt = format_prompt(payload.get("messages", []))
        with self.lock:
            # The template already supplies BOS. A string completion prompt adds
            # another BOS; token input preserves the original template exactly.
            tokens = self.model.tokenize(prompt.encode("utf-8"), add_bos=False, special=True)
            result = self.model.create_completion(
                prompt=tokens, max_tokens=256, temperature=0.0,
                stop=["<end_of_turn>", "<eos>"],
            )
        return {"text": result["choices"][0]["text"]}
