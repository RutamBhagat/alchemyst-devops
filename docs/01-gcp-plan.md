# GCP Deployment Plan

This document describes the recommended way to complete the DevOps internship
assignment on Google Cloud Platform using the provided `quickstart` project.

The project is a small distributed inference mesh built on iii. The Python
worker owns model inference, the TypeScript worker owns HTTP-triggered
orchestration, and the iii engine owns worker registration, trigger routing,
and RPC dispatch.

> [!NOTE]
> The key deployment invariant is that custom workers are private. Only the API
> gateway has a public endpoint, and all worker-to-worker calls flow through the
> iii engine over private networking.

## Architecture

```text
Internet
  |
  | HTTP POST /v1/chat/completions
  v
+------------------------------+
| api-gateway VM               |
| public IP: yes               |
| private IP: 10.10.0.10       |
|                              |
| reverse proxy :80            |
|   -> 127.0.0.1:3111          |
|                              |
| iii engine                   |
| - worker WebSocket :49134    |
| - iii-http REST :3111        |
+---------------+--------------+
                ^
                | ws://10.10.0.10:49134
                |
      +---------+----------+        +--------------------+
      | caller-worker VM   |        | inference-worker VM |
      | public IP: no      |        | public IP: no       |
      | TypeScript worker  |        | Python worker       |
      | registers:         |        | registers:          |
      | - inference::get_response   | - inference::run_inference
      | - http::run_inference_over_http
      +--------------------+        +--------------------+
```

The assignment's custom application workers are `caller-worker` and
`inference-worker`; each runs on its own private VM. Built-in iii runtime
workers, including `iii-http`, run with the engine on the gateway because they
are part of the iii control plane for this deployment, not custom assignment
logic.

The gateway hosts the engine to keep the assignment deployment small. The
engine's worker WebSocket port is reachable only on the private interface and
firewalled to worker VMs. In a stricter production topology, the engine could
move to a separate private VM and the gateway could become only a reverse
proxy.

## Request Flow

1. A client sends `POST /v1/chat/completions` to the gateway public IP.
2. The reverse proxy forwards the request to local `iii-http` on port `3111`.
3. `iii-http` invokes the registered `http::run_inference_over_http` trigger.
4. The TypeScript caller worker invokes `inference::get_response`.
5. `inference::get_response` invokes Python `inference::run_inference`.
6. The Python worker runs the GGUF model and returns generated text.
7. The gateway returns JSON to the client.

The caller worker owns the HTTP handler function and trigger registration.
`iii-http` owns the HTTP listener on the gateway and routes matching requests
through the engine to the registered function.

## GCP Resources

Provision these resources with Terraform:

- `google_compute_network` with `auto_create_subnetworks = false`
- `google_compute_subnetwork` such as `10.10.0.0/24`, with Private Google
  Access enabled for Google APIs
- `google_compute_router` and `google_compute_router_nat`
- `api-gateway` Compute Engine VM with one static external IP
- `caller-worker` Compute Engine VM with no external IP
- `inference-worker` Compute Engine VM with no external IP
- firewall rules for public API ingress, private iii WebSocket ingress, and IAP
  SSH

Recommended instance sizes:

| VM | Machine type | Disk | Reason |
| --- | --- | --- | --- |
| `api-gateway` | `e2-small` | 20 GB | Runs iii engine, `iii-http`, and reverse proxy. |
| `caller-worker` | `e2-small` | 20 GB | Runs the lightweight TypeScript worker. |
| `inference-worker` | `e2-standard-4` | 50 GB | Runs PyTorch, Transformers, and the small GGUF model on CPU. |

Cloud NAT is required because private workers need outbound access during
bootstrap for apt, npm, PyPI, and Hugging Face model downloads. Private Google
Access covers Google APIs and services for VMs without external IPs; Cloud NAT
covers general internet destinations.

## Firewall Rules

Use tags or service accounts to keep the rules explicit:

| Rule | Source | Target | Ports |
| --- | --- | --- | --- |
| Public API | `0.0.0.0/0` | `api-gateway` | `80` |
| iii worker RPC | private subnet or worker service accounts | `api-gateway` | `49134` |
| IAP SSH | `35.235.240.0/20` | all VMs | `22` |

Do not allow public ingress to `caller-worker` or `inference-worker`. Do not
open `49134` to the internet. Open `443` only when TLS is actually configured.

## Deployment Files To Add

Keep the implementation small and reproducible:

```text
infra/terraform/
  main.tf
  variables.tf
  outputs.tf

deploy/
  gateway/
    iii-config.yaml
    nginx.conf
  scripts/
    bootstrap-gateway.sh
    bootstrap-caller.sh
    bootstrap-inference.sh
  systemd/
    iii-engine.service
    caller-worker.service
    inference-worker.service
```

The gateway `iii-config.yaml` should run only engine-owned workers:

```yaml
workers:
  - name: iii-observability
    config:
      enabled: true
      service_name: iii
      exporter: memory
      logs_enabled: true
      logs_console_output: true

  - name: iii-http
    config:
      port: 3111
      host: 127.0.0.1
      default_timeout: 30000
      concurrency_request_limit: 1024
      cors:
        allowed_origins:
          - "*"
        allowed_methods:
          - GET
          - POST
          - OPTIONS
```

The docs expose `default_timeout` as an `iii-http` setting. Keep the value
explicit, then raise it only if local verification times out after the inference
token limit has been reduced.

Start the engine with:

```bash
iii --config /opt/iii/iii-config.yaml
```

Start both custom workers with:

```bash
III_URL=ws://10.10.0.10:49134
```

Do not rely on the checked-in `quickstart/config.yaml` to launch the custom
workers in GCP because its `worker_path` entries are absolute paths from another
machine.

## Code Adjustments Before Deploying

Make these small source fixes before provisioning:

1. Verify the installed iii engine version and SDK versions locally. The
   TypeScript and Python SDKs are pinned to `0.11.0`, while `iii.lock` lists
   engine workers at `0.12.0`. Keep engine and SDK minor versions aligned
   unless iii release notes confirm that the specific mix is supported.
2. Normalize the inference result. The Python worker currently returns a plain
   string, while the TypeScript worker spreads the result into an object. Return
   a JSON object such as `{ "text": result }` from Python, and make the
   TypeScript HTTP handler return that object directly as the response body.
   The public API should return `{ "text": "..." }`, not a nested
   `{ "result": { "text": "..." } }` shape.
3. Lower `max_new_tokens` from `32000` to a CPU-friendly value like `256` or
   `512`.
4. Set `III_URL` only through systemd environment configuration in deployment.
   The localhost fallback is fine for local development but not for remote VMs.

## Implementation Order

Use this order so failures identify the broken invariant quickly:

> [!IMPORTANT]
> Do not run `terraform apply` until local
> `POST /v1/chat/completions` works end-to-end and returns the documented JSON
> shape.

1. Prove the app locally with the quickstart flow: start the engine, start both
   workers with `III_URL=ws://localhost:49134`, and test
   `POST /v1/chat/completions`.
2. Validate the Terraform shape.
3. Deploy to GCP.
4. Prove network isolation.
5. Prove the public JSON API response.

## API Contract

Endpoint:

```text
POST /v1/chat/completions
Content-Type: application/json
```

Request:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Say hello in one sentence."
    }
  ]
}
```

Response:

```json
{
  "text": "Hello! I am ready to help with your request."
}
```

Example curl:

```bash
curl -X POST "http://$(terraform -chdir=infra/terraform output -raw api_ip)/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

## Redeploy From Scratch

1. Create or select a GCP project and enable billing.
2. Authenticate locally:

   ```bash
   gcloud auth application-default login
   gcloud config set project <project-id>
   ```

3. Enable required APIs:

   ```bash
   gcloud services enable compute.googleapis.com
   ```

4. Provision infrastructure:

   ```bash
   cd infra/terraform
   terraform init
   terraform apply
   ```

5. Wait for startup scripts to finish on all three VMs.
6. Check service status through IAP SSH:

   ```bash
   gcloud compute ssh api-gateway --tunnel-through-iap --zone <zone> --command "systemctl status iii-engine"
   gcloud compute ssh caller-worker --tunnel-through-iap --zone <zone> --command "systemctl status caller-worker"
   gcloud compute ssh inference-worker --tunnel-through-iap --zone <zone> --command "systemctl status inference-worker"
   ```

7. Send the curl request from the API contract section.

## Verification Checklist

- `caller-worker` and `inference-worker` have no external IP addresses.
- Public requests to the gateway on `80` succeed.
- Public requests to gateway port `49134` fail.
- From worker VMs, `nc -vz 10.10.0.10 49134` succeeds.
- Gateway logs show the HTTP request.
- Caller worker logs show `inference::get_response`.
- Inference worker logs show model generation.

## Production Hardening

Before production, add:

- TLS with a managed certificate or Caddy automatic HTTPS.
- Authentication and rate limiting on the public API.
- Request size limits and timeouts at the reverse proxy.
- Structured logs and metrics exported outside the VM.
- Dependency locks for Python and Node.
- Prebuilt VM images instead of installing dependencies in startup scripts.
- Least-privilege service accounts.
- Secret Manager for secrets and configuration that should not live in Terraform
  state.

## If The Model Were 100x Larger

The architecture should change around the inference tier:

- Move inference to GPU instances or a GKE GPU node pool.
- Pre-bake model weights into images or attach a prepared disk.
- Use a model server such as vLLM or Text Generation Inference instead of raw
  `transformers.generate`.
- Add queueing and backpressure so API requests do not overload inference.
- Scale caller/API workers separately from inference workers.
- Add streaming responses if generation latency becomes user-visible.

The network invariant stays the same: model workers remain private, and only the
gateway is public.
