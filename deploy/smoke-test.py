"""Verify the public HTTP contract and inference readiness (stdlib only)."""
import argparse
import json
import os
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("API_URL", "http://localhost:3111/v1/chat/completions")
HEALTH_URL = API_URL.rsplit("/v1/chat/completions", 1)[0] + "/health"


def read_response(response):
    data = response.read().decode()
    try:
        return response.status, json.loads(data)
    except ValueError:
        return response.status, data


def request(url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=240) as response:
            return read_response(response)
    except urllib.error.HTTPError as response:
        return read_response(response)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--readiness-only", action="store_true")
    args = parser.parse_args()
    deadline = time.monotonic() + int(os.environ.get("READY_TIMEOUT", "600"))
    while True:
        try:
            status, body = request(HEALTH_URL)
            if status == 200 and body == {"ready": True}:
                break
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise AssertionError("Inference did not become healthy")
        time.sleep(5)

    if args.readiness_only:
        print("PASS inference readiness")
        raise SystemExit(0)

    for payload in [{}, {"bad": True}, {"messages": None}, {"messages": "text"},
                    {"messages": [{"role": "tool", "content": "x"}]},
                    {"messages": [{"role": "user", "content": 1}]},
                    {"messages": [{"role": "user"}]}, []]:
        status, body = request(API_URL, payload)
        assert status == 400, (payload, status, body)
        assert body == {"error": "Request body must contain messages with role and content strings."}

    status, _ = request(API_URL, {"unused": "x" * 1048576})
    assert status == 413, status

    # Empty messages is still schema-valid but invalid for the Gemma template.
    status, _ = request(API_URL, {"messages": []})
    assert status == 500, status

    started = time.monotonic()
    status, body = request(API_URL, {"messages": [{"role": "user", "content": "The capital of France is"}]})
    assert status == 200, (status, body)
    assert set(body) == {"text"} and isinstance(body["text"], str) and body["text"].strip(), body
    print(f"PASS health, 8 invalid requests, 1 MiB body limit, empty messages, real inference ({time.monotonic() - started:.2f}s): {body}")
