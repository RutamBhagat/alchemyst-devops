import hashlib
import importlib.util
import io
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from jinja2 import TemplateError, UndefinedError
from prompting import format_prompt
from model_runtime import InferenceRuntime, MODEL_FILE, model_path


class PromptTests(unittest.TestCase):
    def test_original_prompt_bytes(self):
        self.assertEqual(format_prompt([{"role": "user", "content": " hello "}]),
                         "<bos><start_of_turn>user\nhello<end_of_turn>\n<start_of_turn>model\n")
        self.assertEqual(format_prompt([{"role": "system", "content": " Be brief. "},
                                        {"role": "user", "content": " Hi "}]),
                         "<bos><start_of_turn>user\n Be brief. \n\nHi<end_of_turn>\n<start_of_turn>model\n")
        self.assertEqual(format_prompt([{"role": "user", "content": "a"},
                                        {"role": "assistant", "content": " b "},
                                        {"role": "user", "content": "c"}]),
                         "<bos><start_of_turn>user\na<end_of_turn>\n<start_of_turn>model\nb<end_of_turn>\n<start_of_turn>user\nc<end_of_turn>\n<start_of_turn>model\n")
        self.assertEqual(format_prompt([{"role": "user", "content": ""}]),
                         "<bos><start_of_turn>user\n<end_of_turn>\n<start_of_turn>model\n")
        self.assertEqual(format_prompt([{"role": "user", "content": [{"type": "text", "text": "a"}, {"type": "image"}]}]),
                         "<bos><start_of_turn>user\na<start_of_image><end_of_turn>\n<start_of_turn>model\n")

    def test_original_rejections(self):
        for messages in [None, []]:
            with self.subTest(messages=messages), self.assertRaises(UndefinedError):
                format_prompt(messages)
        for messages in [[{"role": "assistant", "content": "a"}],
                         [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]]:
            with self.subTest(messages=messages), self.assertRaisesRegex(TemplateError, "roles must alternate"):
                format_prompt(messages)
        with self.assertRaisesRegex(TemplateError, "Invalid content type"):
            format_prompt([{"role": "user", "content": None}])


class ModelTests(unittest.TestCase):
    def test_atomic_checked_download_and_cache(self):
        data = b"small gguf fixture"
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict("os.environ", {"MODEL_DIR": directory}), \
             patch("model_runtime.MODEL_SHA256", hashlib.sha256(data).hexdigest()), \
             patch("model_runtime.urllib.request.urlopen", return_value=io.BytesIO(data)) as download:
            result = model_path()
            self.assertEqual(result.read_bytes(), data)
            self.assertFalse(result.with_suffix(".part").exists())
            self.assertEqual(model_path(), result)
            download.assert_called_once()

    def test_corruption_is_not_a_cache_hit(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"MODEL_DIR": directory}):
            path = Path(directory) / MODEL_FILE
            with patch("model_runtime.urllib.request.urlopen", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "Downloaded GGUF checksum mismatch"):
                    model_path()
            self.assertFalse(path.exists())
            path.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "Cached GGUF checksum mismatch"):
                model_path()

    def test_bounded_serial_generation(self):
        active = 0
        peak = 0
        def generate(**kwargs):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            time.sleep(0.01)
            active -= 1
            return {"choices": [{"text": "answer"}]}
        with patch("model_runtime.model_path", return_value=Path("model.gguf")), \
             patch("model_runtime.Llama") as llama:
            llama.return_value.create_completion.side_effect = generate
            llama.return_value.tokenize.return_value = [2, 105, 777]
            runtime = InferenceRuntime()
            args = llama.call_args.kwargs
            self.assertEqual((args["n_ctx"], args["n_batch"], args["n_threads"]), (2048, 64, 1))
            payload = {"messages": [{"role": "user", "content": "hello"}]}
            results = []
            threads = [threading.Thread(target=lambda: results.append(runtime.run(payload))) for _ in range(3)]
            for thread in threads: thread.start()
            for thread in threads: thread.join()
            self.assertEqual(peak, 1)
            self.assertEqual(results, [{"text": "answer"}] * 3)
            self.assertEqual(llama.return_value.create_completion.call_args.kwargs["max_tokens"], 256)
            self.assertEqual(llama.return_value.create_completion.call_args.kwargs["prompt"], [2, 105, 777])
            self.assertEqual(llama.return_value.tokenize.call_args.kwargs, {"add_bos": False, "special": True})
            # Formatting errors must happen before touching the model.
            with self.assertRaises(UndefinedError): runtime.run({})
            self.assertEqual(llama.return_value.create_completion.call_count, 3)


class WorkerLifecycleTests(unittest.TestCase):
    def test_model_ready_before_registration_and_main_stays_alive(self):
        order = []
        client = Mock()
        client.register_function.side_effect = lambda name, handler: order.append(name)
        runtime = Mock()
        runtime.run.return_value = {"text": "answer"}
        logger = Mock()
        sdk = SimpleNamespace(
            register_worker=Mock(side_effect=lambda *a: order.append("connect") or client),
            InitOptions=Mock(),
        )
        helpers = SimpleNamespace(Logger=Mock(return_value=logger))
        with patch.dict(sys.modules, {"iii": sdk, "iii_helpers.observability": helpers}), \
             patch("model_runtime.InferenceRuntime", side_effect=lambda: order.append("model") or runtime), \
             patch("threading.Event") as event:
            event.return_value.wait.side_effect = lambda: order.append("wait")
            spec = importlib.util.spec_from_file_location("worker_under_test", Path(__file__).with_name("inference_worker.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertEqual(order, ["model", "connect", "inference::run_inference", "inference::health", "wait"])
            self.assertEqual(client.register_function.call_args_list[1].args[1]({}), {"ready": True})
            self.assertEqual(module.run_inference_handler({"messages": []}), {"text": "answer"})
            logger.info.assert_called_once()


if __name__ == "__main__":
    unittest.main()
