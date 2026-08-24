# Distributed Inference with Pulumi

This repository deploys the Alchemyst DevOps internship assignment as a three-role iii inference mesh with Pulumi and Docker:

- **OCI** — the real cloud deployment. Pulumi creates a public gateway VM plus private caller/inference VMs. Each VM boots Ubuntu 24.04 Minimal and runs its role with Docker Compose.
- **Floci** — the local AWS-compatible target. Pulumi creates ECS resources against Floci, and Floci runs the same locally built application images as real Docker containers.

The application flow is unchanged: nginx -> iii HTTP trigger -> TypeScript caller -> Python inference worker.

## Architecture

```text
Internet
   |
   | HTTP :80
   v
+-----------------------------+
| OCI gateway 10.10.0.10      |
| Docker: nginx + iii engine  |
+--------------+--------------+
               | private RPC :49134
               v
+-----------------------------+       +-----------------------------+
| caller 10.10.1.11           | ----> | inference 10.10.1.12        |
| Docker, no public IP        | RPC   | Docker, no public IP        |
+-----------------------------+       +-----------------------------+
```

Floci uses the same four application images through its Docker-backed ECS emulator. The local API is published at `http://localhost:8080`.

## API

```http
POST /v1/chat/completions
Content-Type: application/json
```

```json
{"messages":[{"role":"user","content":"Say hello in one sentence."}]}
```

Expected response shape:

```json
{"text":"..."}
```

OCI:

```bash
API_IP="$(cd infra/pulumi/oci && pulumi stack output apiIp)"
curl -fsS -m 90 -X POST "http://${API_IP}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

Floci:

```bash
curl -fsS -m 90 -X POST http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

## Repository Layout

```text
infra/pulumi/
  common.ts                    # minimal OCI cloud-init generation
  oci/                         # OCI VCN/subnets/NAT/NSGs/VMs
  floci/                       # Floci ECS Pulumi program + emulator Compose
deploy/
  docker/                      # Dockerfiles and per-role Compose files
  gateway/                     # iii and nginx configuration
quickstart/
  workers/caller-worker/       # TypeScript caller
  workers/inference-worker/    # Python GGUF inference
```

Terraform and the application-level systemd units/bootstrap scripts have been removed. OCI user data only installs Git + Docker/Compose, clones the repository, and starts the role Compose file. Floci does not boot nested VMs; its ECS emulator launches the locally built Docker images directly.

## Deploy

See [Deploy and smoke test](docs/04-deploy-and-smoke-test.md), [Registry-free CI/CD](docs/06-cicd.md), and [Teardown](docs/05-teardown.md).

Minimal local validation:

```bash
npm --prefix infra/pulumi install
npm --prefix infra/pulumi run typecheck

docker compose -f deploy/docker/build.compose.yaml config -q

npm --prefix quickstart/workers/caller-worker ci
npm --prefix quickstart/workers/caller-worker run build
python3 -m py_compile quickstart/workers/inference-worker/inference_worker.py
```

## OCI Compute and Images

The default OCI allocation is:

- gateway: `VM.Standard.E2.1.Micro` (AMD/x86_64, 1 GB)
- caller: `VM.Standard.E2.1.Micro` (AMD/x86_64, 1 GB)
- inference: `VM.Standard.A1.Flex` (Arm64, 1 OCPU / 6 GB)

Pulumi selects the newest compatible **Canonical Ubuntu 24.04 Minimal** platform image. AMD uses the `Canonical-Ubuntu-24.04-Minimal-*` family and A1 uses `Canonical-Ubuntu-24.04-Minimal-aarch64-*`. Explicit image OCIDs can override discovery.

## Container Images and Registries

Application images are built locally from this repository; there is no application-image registry dependency and no `docker push` step. CI builds/scans the images without publishing them. OCI deployments are pinned to an exact Git commit via `DEPLOY_REF`, then each replacement VM builds that revision locally during cloud-init. Floci builds once on the development machine before `pulumi up`.

The Dockerfiles still pull public base images (`ubuntu`, `nginx`, `node`, `python`) and Python/npm dependencies. Eliminating all registry/package-network access would require pre-baked OCI VM images or exported `docker save` artifacts.

## Network Invariants

- Only the OCI gateway receives a public IP.
- Caller and inference OCI VMs remain private.
- RPC/49134 is allowed to the gateway only from the worker NSG.
- Public ingress is limited to gateway HTTP/80 unless gateway SSH is explicitly enabled.
- Private workers use an OCI NAT Gateway for outbound image/package/model downloads.

## Production Hardening

CI/CD now covers build validation, vulnerability reporting, SBOM generation, commit-pinned deployment, smoke verification, and rollback to the previous deployed commit. Remaining production hardening includes TLS, authentication/rate limiting, managed observability, secret management, least-privilege instance identities, request limits/timeouts, and immutable prebuilt application artifacts if a registry/artifact service is later accepted.

If the model were 100x larger, inference would move to GPU-backed serving such as vLLM/TGI with pre-staged weights, independent autoscaling, queueing/backpressure, and streaming. The public/private network boundary remains the same.
