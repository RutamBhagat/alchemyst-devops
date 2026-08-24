# Distributed Inference with Pulumi

This repository deploys the Alchemyst DevOps internship assignment as a three-node iii inference mesh. Infrastructure is now defined in Pulumi with two targets:

- **OCI** — the real cloud deployment. The API gateway is public; caller and inference workers run without public IPs in a private subnet and use a NAT gateway for outbound package/model downloads.
- **Floci** — a local AWS-compatible deployment for repeatable development and CI. Floci's EC2 implementation launches real Docker-backed instances and the Pulumi AWS provider is pointed at `http://localhost:4566`.

The application topology is unchanged: nginx -> iii HTTP trigger -> TypeScript caller -> Python inference worker.

## Architecture

```text
Internet / localhost
        |
        | HTTP :80
        v
+-------------------------+
| API gateway             |
| 10.10.0.10              |
| nginx -> iii            |
+------------+------------+
             | private RPC :49134
             v
+-------------------------+       +-------------------------+
| caller worker           | ----> | inference worker        |
| 10.10.1.11              | RPC   | 10.10.1.12              |
| no public IP            |       | no public IP            |
+-------------------------+       +-------------------------+
```

## API

```http
POST /v1/chat/completions
Content-Type: application/json
```

```json
{
  "messages": [
    {"role": "user", "content": "Say hello in one sentence."}
  ]
}
```

Expected response shape:

```json
{"text":"..."}
```

For OCI:

```bash
API_IP="$(cd infra/pulumi/oci && pulumi stack output apiIp)"
curl -fsS -m 90 -X POST "http://${API_IP}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

For Floci, EC2 security-group publishing maps guest port `80` to a host port in Floci's configured range. The deploy guide shows how to read that port from the Floci logs and issue the same request against localhost.

## Repository Layout

```text
infra/pulumi/
  package.json
  common.ts                    # provider-neutral user-data assembly
  oci/                         # real OCI VCN/subnets/NAT/NSGs/instances
  floci/                       # AWS Pulumi program + Floci Docker Compose

deploy/
  gateway/                     # iii and nginx configuration
  scripts/                     # provider-neutral VM bootstrap scripts
  systemd/                     # runtime services
quickstart/
  workers/caller-worker/       # TypeScript RPC/HTTP worker
  workers/inference-worker/    # Python GGUF inference worker
```

Terraform has been removed. Both targets use the same bootstrap and service files, with `REPOSITORY_URL` and `III_URL` injected by Pulumi user data.

## Deploy

See [Deploy and smoke test](docs/04-deploy-and-smoke-test.md) for OCI and Floci instructions, and [Teardown](docs/05-teardown.md) for cleanup.

Minimal local validation:

```bash
npm --prefix infra/pulumi install
npm --prefix infra/pulumi run typecheck

cd quickstart/workers/caller-worker
npm ci
npm run build

python3 -m py_compile ../inference-worker/inference_worker.py
```

## Network Invariants

- Only the API gateway receives a public endpoint.
- Caller and inference workers have no public IPs.
- Worker RPC to gateway port `49134` is allowed only from the worker security group/NSG.
- Public ingress is limited to gateway HTTP port `80`; SSH is disabled by default on OCI unless `sshAllowedCidr` is configured.
- OCI private workers use a NAT gateway for outbound dependencies without becoming publicly addressable.

## Portability Note

OCI defaults to the Always Free compute mix: gateway and caller use AMD `VM.Standard.E2.1.Micro`; inference uses Ampere `VM.Standard.A1.Flex` at 1 OCPU / 6 GB. The A1 worker uses an ARM-compatible Ubuntu image and resolves the pinned direct Python dependencies from `requirements.in` instead of forcing the committed x86_64 lock file. Floci on Apple Silicon follows the same ARM dependency path.

## Production Hardening

Before production: TLS, authentication/rate limiting, managed observability, immutable images, secret management, least-privilege instance identities, request limits/timeouts, and a production model-serving layer rather than bootstrap-time dependency/model downloads.

If the model were 100x larger, inference would move to a GPU-backed serving tier (for example vLLM/TGI) with pre-staged weights, independent autoscaling, queueing/backpressure, and streaming. The public/private network boundary would remain the same.
