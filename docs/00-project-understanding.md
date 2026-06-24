# Project Understanding

This document captures the current understanding of the DevOps internship
assignment and the provided `quickstart` project. It is intentionally limited
to the current project state and problem statement; it does not propose a
deployment solution.

## Assignment Summary

The assignment asks for the provided `quickstart` project to be deployed as a
distributed inference system across multiple cloud VMs in a private network.

The expected final system has:

- A VPC with a private subnet.
- Worker VMs that are not directly reachable from the public internet.
- One VM per worker.
- RPC between workers over the private subnet.
- A public JSON HTTP API that dispatches requests into the worker mesh.
- Reproducible infrastructure and deployment configuration.
- Documentation that explains the architecture, API contract, redeploy steps,
  production hardening, and how the design would change for a much larger
  model.

The assignment explicitly says the quickstart README and iii quickstart docs
should be understood before provisioning anything.

## Quickstart Purpose

The `quickstart` project is a small distributed inference prototype built on
the iii backend engine. It combines two custom workers and iii engine workers:

| Component | Language / Runtime | Responsibility |
| --- | --- | --- |
| `inference-worker` | Python | Loads the language model and exposes inference through `inference::run_inference`. |
| `caller-worker` | TypeScript | Exposes the HTTP-facing function and calls the inference function over iii RPC. |
| `iii-http` | iii engine worker | Publishes the HTTP trigger type and serves REST requests. |
| `iii-state` | iii engine worker | Configured in the project, though not used by the active inference path. |
| `iii-queue` | iii engine worker | Configured in the project for queue support. |

The important ownership boundary is simple: Python owns model execution;
TypeScript owns HTTP ingress and orchestration; iii owns function registration,
trigger routing, and worker-to-worker invocation.

## Runtime Flow

The intended request path is:

```text
HTTP client
  -> POST /v1/chat/completions
  -> iii-http
  -> http::run_inference_over_http
  -> inference::get_response
  -> inference::run_inference
  -> Hugging Face Transformers model generation
  -> JSON HTTP response
```

The active code path starts in
`quickstart/workers/caller-worker/src/worker.ts`. The TypeScript worker:

- Connects to the iii engine at `process.env.III_URL`, defaulting to
  `ws://localhost:49134`.
- Registers `inference::get_response`.
- Calls `inference::run_inference` with the incoming payload.
- Registers `http::run_inference_over_http`.
- Binds `http::run_inference_over_http` to the HTTP trigger
  `POST /v1/chat/completions`.

The Python worker in
`quickstart/workers/inference-worker/inference_worker.py`:

- Connects to the iii engine at `III_URL`, defaulting to
  `ws://localhost:49134`.
- Loads `ggml-org/gemma-3-270m-GGUF`.
- Selects `gemma-3-270m-Q8_0.gguf`.
- Applies a chat template to the incoming `messages`.
- Runs `model.generate`.
- Returns the decoded generated text.

## iii Model

The iii docs describe the system in terms of three primitives:

- **Worker**: a process that contributes capabilities.
- **Function**: a callable capability registered by a worker, identified with
  names like `service::name`.
- **Trigger**: an event binding that invokes a function, such as an HTTP route.

Workers connect to the iii engine over WebSocket. The conventional connection
setting is the `III_URL` environment variable. In this project, both custom
workers default to `ws://localhost:49134`, which is correct for local
single-machine development but must be treated as an explicit deployment-time
network dependency when workers run on separate machines.

The iii docs also state that a worker can run anywhere reachable on the
network. A worker started by iii from `config.yaml`, by `iii worker start`, or
manually as a process using the SDK behaves the same once connected to the
engine.

## Current Repository State

The relevant files are:

- `devops-internship-assignment.md`
- `quickstart/README.md`
- `quickstart/config.yaml`
- `quickstart/iii.lock`
- `quickstart/workers/caller-worker/src/worker.ts`
- `quickstart/workers/caller-worker/package.json`
- `quickstart/workers/caller-worker/iii.worker.yaml`
- `quickstart/workers/inference-worker/inference_worker.py`
- `quickstart/workers/inference-worker/requirements.txt`
- `quickstart/workers/inference-worker/iii.worker.yaml`

The project is compact and does not currently include infrastructure-as-code,
systemd units, container manifests, cloud scripts, or a top-level deployment
README.

## Current Configuration Notes

`quickstart/config.yaml` configures:

- `iii-observability`
- `iii-queue`
- `iii-state`
- `iii-http`
- `inference-worker`
- `caller-worker`

The HTTP worker is configured with:

```yaml
port: 3111
host: 127.0.0.1
default_timeout: 30000
```

The engine WebSocket default used by the SDK examples and project code is:

```text
ws://localhost:49134
```

The checked-in `worker_path` values in `quickstart/config.yaml` are absolute
paths from another machine:

```text
/Users/anuran/Alchemyst/hiring/may-2026/devops/quickstart/workers/...
```

That means the current `config.yaml` is not portable as-is.

There is also a version mismatch in the current files:

- `caller-worker/package.json` uses `iii-sdk` version `0.11.0`.
- `inference-worker/requirements.txt` uses `iii-sdk==0.11.0`.
- `quickstart/iii.lock` lists `iii-http` and `iii-state` at `0.12.0`.

The iii install docs say engine and SDK patch versions may differ, but the
minor version should generally stay aligned unless release notes say otherwise.

## Model and Inference Notes

The Python worker uses Hugging Face Transformers with GGUF support:

```python
tokenizer = AutoTokenizer.from_pretrained(model_id, gguf_file=gguf_file)
model = AutoModelForCausalLM.from_pretrained(model_id, gguf_file=gguf_file)
```

Context7 docs for Transformers confirm that `gguf_file` is the documented way
to load a GGUF checkpoint through `AutoTokenizer` and `AutoModelForCausalLM`.
They also confirm that chat messages should be converted with
`apply_chat_template` before generation.

The current worker sets a custom `tokenizer.chat_template` inline. The payload
is expected to contain `messages`, and those messages are expected to follow the
chat-template assumptions, including alternating user/assistant turns after an
optional system message.

## Current HTTP Contract

The quickstart README describes the HTTP endpoint as:

```text
POST /v1/chat/completions
```

The current TypeScript handler expects the iii HTTP trigger payload to contain
a `body` object, and then forwards `payload.body` to `inference::get_response`.

The body is expected to include:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "..."
    }
  ]
}
```

The current HTTP response shape is:

```json
{
  "result": {
    "...": "result from inference::get_response"
  }
}
```

`inference::get_response` currently returns the Python inference result spread
into an object and adds a `success` string. Since the Python worker returns a
plain string, the exact runtime behavior of spreading that value should be
verified before relying on the final JSON shape.

## Important Invariants

The central runtime invariant is:

> Every callable function exists only while the worker that registered it is
> connected to the iii engine.

That means:

- `inference::run_inference` exists only while the Python worker is connected.
- `inference::get_response` and `http::run_inference_over_http` exist only
  while the TypeScript worker is connected.
- The HTTP trigger can only be registered when the `http` trigger type exists,
  which requires `iii-http` to be running.
- Worker-to-worker calls are routed through the iii engine, not through direct
  HTTP calls between the custom workers.

For the assignment, the important network invariant is:

> Workers should communicate over private networking, and only the public API
> endpoint should be reachable from the internet.

## External Docs Consulted

The following current docs were used to understand the project:

- iii install docs: `https://iii.dev/docs/install`
- iii quickstart: `https://iii.dev/docs/quickstart`
- iii worker docs: `https://iii.dev/docs/creating-workers/workers`
- iii function docs: `https://iii.dev/docs/creating-workers/functions`
- iii trigger docs: `https://iii.dev/docs/creating-workers/triggers`
- iii deployment docs: `https://iii.dev/docs/using-iii/deployment`
- Context7 library docs for `/iii-hq/iii`
- Context7 library docs for `/huggingface/transformers`

Key iii documentation points:

- Workers connect to the engine over WebSocket using `III_URL`.
- Functions are registered with IDs like `service::name`.
- HTTP endpoints are created by binding a function to the `http` trigger type.
- The engine exposes SDK WebSocket traffic on port `49134`.
- The REST API is served on port `3111` when `iii-http` is enabled.
- The engine does not terminate TLS; production deployments place a reverse
  proxy in front of it when TLS is needed.

## Open Current-State Questions

These are not solution decisions, only facts that need verification before a
deployment can be considered complete:

- Whether the deployed engine version should be aligned to SDK `0.11.x` or the
  SDK dependencies should be aligned to engine worker `0.12.x`.
- Whether `iii-http` should remain on loopback behind a front-door proxy or bind
  to a private interface.
- Whether the assignment expects the API gateway VM to run iii engine plus
  `iii-http`, or whether the gateway is a separate reverse proxy in front of an
  internal engine/API host.
- Whether the Python worker's `max_new_tokens=32000` is intentional for a
  CPU-only small-model deployment.
- Whether the final API response should preserve the current quickstart shape
  or be normalized into a clearer JSON schema.
