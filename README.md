# Distributed Inference on GCP

This repository contains a reproducible deployment for the Alchemyst DevOps internship assignment. It runs the provided `quickstart` iii project as a small distributed inference mesh on Google Cloud: a public API gateway accepts JSON requests, a TypeScript worker orchestrates the request, and a Python worker runs the GGUF model inference.

> [!IMPORTANT]
> The deployment invariant is that only the API gateway has a public endpoint. The custom workers have no external IP addresses and connect to the iii engine over private subnet networking.

## Architecture

```text
Internet
  |
  | POST /v1/chat/completions
  v
+----------------------------------+
| api-gateway VM                   |
| public IP: yes                   |
| private IP: 10.10.0.10           |
|                                  |
| nginx :80                        |
|   -> iii-http 127.0.0.1:3111     |
|                                  |
| iii engine WebSocket :49134      |
+----------------+-----------------+
                 ^
                 | ws://10.10.0.10:49134
       +---------+----------+      +----------------------+
       | caller-worker VM   |      | inference-worker VM  |
       | public IP: no      |      | public IP: no        |
       | TypeScript worker  |      | Python worker        |
       | registers:         |      | registers:           |
       | inference::        |      | inference::          |
       |   get_response     |      |   run_inference      |
       | http::             |      +----------------------+
       |   run_inference_   |
       |   over_http        |
       +--------------------+
```

Request flow:

1. `nginx` receives the public HTTP request on the gateway.
2. `iii-http` invokes `http::run_inference_over_http`.
3. The TypeScript caller invokes `inference::get_response`.
4. The caller invokes Python `inference::run_inference` through iii RPC.
5. The Python worker returns `{ "text": "..." }` and the gateway sends it as JSON.

## API

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
  "text": "Hello! I am ready to help."
}
```

Curl:

```bash
curl -X POST "http://$(terraform -chdir=infra/terraform output -raw api_ip)/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

## Repository Layout

```text
quickstart/
  config.yaml                         # local iii config with relative worker paths
  workers/caller-worker/              # TypeScript HTTP/RPC worker
  workers/inference-worker/           # Python model worker

infra/terraform/
  main.tf                             # VPC, subnet, NAT, firewall rules, VMs
  variables.tf
  outputs.tf

deploy/
  gateway/                            # iii engine config and nginx reverse proxy
  scripts/                            # Compute Engine startup scripts
  systemd/                            # one service per runtime process
```

## Deploy From Scratch

Prerequisites:

- A GCP project with billing enabled.
- `gcloud` authenticated locally.
- Terraform installed locally.
- This repository pushed to a Git URL reachable from the VMs.

Enable the Compute Engine API:

```bash
gcloud config set project <project-id>
gcloud services enable compute.googleapis.com
```

Deploy:

```bash
cd infra/terraform
terraform init
terraform apply \
  -var="project_id=<project-id>" \
  -var="repository_url=https://github.com/<user>/<repo>.git"
```

The startup scripts clone `repository_url` on each VM, check out `main`, install the required runtime, install iii `0.11.0` on the gateway, and start the systemd services.

Check service status through IAP:

```bash
gcloud compute ssh alchemyst-devops-api-gateway \
  --tunnel-through-iap \
  --zone us-central1-a \
  --command "systemctl status iii-engine nginx"

gcloud compute ssh alchemyst-devops-caller-worker \
  --tunnel-through-iap \
  --zone us-central1-a \
  --command "systemctl status caller-worker"

gcloud compute ssh alchemyst-devops-inference-worker \
  --tunnel-through-iap \
  --zone us-central1-a \
  --command "systemctl status inference-worker"
```

Destroy:

```bash
terraform -chdir=infra/terraform destroy \
  -var="project_id=<project-id>" \
  -var="repository_url=https://github.com/<user>/<repo>.git"
```

## Network Checks

Expected properties after `terraform apply`:

- `caller-worker` and `inference-worker` have no external IP addresses.
- Public HTTP to the gateway on port `80` succeeds.
- Public access to gateway port `49134` fails.
- Worker VMs can reach `10.10.0.10:49134` over the private subnet.
- SSH access is available only through IAP source range `35.235.240.0/20`.

Useful checks:

```bash
gcloud compute instances list

gcloud compute ssh alchemyst-devops-caller-worker \
  --tunnel-through-iap \
  --zone us-central1-a \
  --command "timeout 5 bash -c '</dev/tcp/10.10.0.10/49134' && echo reachable"
```

## Local Verification

The lightweight checks do not start the model:

```bash
cd quickstart/workers/caller-worker
npm install
npm run build

cd ../inference-worker
python3 -m py_compile inference_worker.py
```

End-to-end local inference requires iii, the Python dependencies, and the model download:

```bash
cd quickstart
iii --config config.yaml
```

Then run both workers with `III_URL=ws://localhost:49134` and send the same curl request to `http://localhost:3111/v1/chat/completions`.

## Production Hardening

Before production, I would add:

- TLS termination with a managed certificate or Caddy.
- Authentication and rate limiting on the public API.
- Request body limits and generation timeouts tuned from real latency data.
- Structured logs, metrics, and traces exported outside the VM.
- Prebuilt images instead of dependency installation in startup scripts.
- Least-privilege service accounts instead of broad default VM permissions.
- Secret Manager for secrets and non-public runtime configuration.
- Dependency lock discipline for Python packages.

## If The Model Were 100x Larger

The main change would be to treat inference as a dedicated serving tier instead of a Python worker running raw `transformers.generate` on CPU. I would move inference to GPU instances or GKE GPU nodes, pre-bake or pre-mount model weights, and use a model server such as vLLM or Text Generation Inference. The API/caller tier would stay lightweight and scale separately.

I would also add queueing, backpressure, and streaming responses so large-model latency does not tie up request threads. The network rule stays the same: model workers remain private, and only the gateway is public.
