import os
import threading
from typing import Any

from iii import InitOptions, register_worker
from iii_helpers.observability import Logger
from model_runtime import InferenceRuntime

# Register only after the model is ready; /health must not report a loading worker.
runtime = InferenceRuntime()
iii = register_worker(
    os.environ.get("III_URL", "ws://localhost:49134"),
    InitOptions(worker_name="inference-worker"),
)
logger = Logger()


def run_inference_handler(payload: dict[str, Any]) -> dict[str, str]:
    result = runtime.run(payload)
    logger.info(f"inference::run_inference generated {len(result['text'])} characters")
    return result


iii.register_function("inference::run_inference", run_inference_handler)
iii.register_function("inference::health", lambda _: {"ready": True})
print("Inference worker started - listening for calls")
# Keep the main thread alive: interpreter shutdown otherwise closes executor
# pools while the SDK's non-daemon event loop is still serving requests.
threading.Event().wait()
