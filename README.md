# Distributed Inference with Pulumi

This repository deploys the Alchemyst DevOps internship assignment as a distributed iii inference mesh with Pulumi and Docker:

- **OCI** — two private E2 micro VMs behind Oracle's free 10 Mbps flexible load balancer. Each VM boots Ubuntu 24.04 Minimal and runs Docker Compose.
- **Floci** — the local AWS-compatible target. Pulumi creates ECS resources against Floci, and Floci runs the same locally built application images as real Docker containers.

OCI: Oracle load balancer -> private nginx adapter -> iii HTTP trigger -> TypeScript caller -> Python inference worker. The nginx sidecar preserves the 1 MiB request-body limit; no public gateway VM is needed. Floci retains its local nginx ingress.

## Architecture

```text
Internet
   |
   | HTTP :80
   v
+-----------------------------+
| Oracle flexible LB, 10 Mbps |
| Public IP, HTTP health check |
+--------------+--------------+
               | private HTTP :80
               v
+-----------------------------+       +-----------------------------+
| API E2 micro 10.10.1.11     | <---- | inference E2 10.10.1.12     |
| nginx + iii engine + caller | RPC   | llama.cpp / Gemma 270M Q8   |
| No public IP                |:49134 | No public IP                |
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
  oci/                         # OCI VCN/subnets/NAT/NSGs/VMs/load balancer
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
npm --prefix infra/pulumi test

docker compose -f deploy/docker/build.compose.yaml config -q

npm --prefix quickstart/workers/caller-worker ci
npm --prefix quickstart/workers/caller-worker run build
python3 -m py_compile quickstart/workers/inference-worker/inference_worker.py
```

## OCI Compute and Images

OCI uses exactly two `VM.Standard.E2.1.Micro` VMs (AMD/x86_64, 1 GB each): iii engine + caller on one, inference on the other. Oracle's flexible load balancer is fixed at 10 Mbps minimum **and** maximum. Deploy in your tenancy's home region with these free allowances available; each boot volume is 50 GB.

Pulumi selects the newest compatible **Canonical Ubuntu 24.04 Minimal** x86 platform image. `amdImageId` can override discovery. See [OCI plan](docs/01-oci-plan.md) for the free-tier budget and model-runtime constraints.

The inference worker keeps Gemma 3 270M Q8 quantized via llama.cpp, with a 2048-token context and 256-token output cap. Its container is limited to 768 MiB, leaving RAM for the host. Requests can take minutes on the micro's shared CPU; timeouts are sized accordingly. Test the real mesh locally (AMD64, production memory limits, 0.25-vCPU inference quota):

Inference uses the checksum-pinned official `llama-cpp-python` 0.3.19 CPU wheel on a pinned Alpine image with musl, libstdc++, and libgomp. Dependency downloads require binary packages; a missing wheel fails the build instead of compiling on the micro. Local Compose selects AMD64 inference explicitly, including on ARM development hosts.

```bash
docker compose -p e2-test -f deploy/docker/e2-test.compose.yaml up -d --build
python3 deploy/smoke-test.py
docker compose -p e2-test -f deploy/docker/e2-test.compose.yaml down
```

## Container Images and Registries

Application images are built locally from this repository; there is no application-image registry dependency and no `docker push` step. CI builds/scans the images without publishing them. OCI deployments are pinned to an exact Git commit via `DEPLOY_REF`, then each replacement VM builds that revision locally during cloud-init. Floci builds once on the development machine before `pulumi up`.

The Dockerfiles still pull public base images (`ubuntu`, `nginx`, `node`, `python`) and Python/npm dependencies. Eliminating all registry/package-network access would require pre-baked OCI VM images or exported `docker save` artifacts.

## Network Invariants

- Only the OCI load balancer receives a public IP; both VMs remain private.
- Backend HTTP/80 is allowed only from the load-balancer NSG; iii HTTP/3111 stays inside the Docker network.
- RPC/49134 is allowed to the API VM only from the inference NSG.
- Public ingress is limited to load-balancer HTTP/80. SSH requires a private administrative path.
- Private workers use an OCI NAT Gateway for outbound image/package/model downloads.

## Production Hardening

CI/CD now covers build validation, vulnerability reporting, SBOM generation, manual commit-pinned deployment gated by successful CI, smoke verification, and rollback to the previous deployed commit. Remaining production hardening includes TLS, authentication/rate limiting, managed observability, secret management, least-privilege instance identities, request limits/timeouts, and immutable prebuilt application artifacts if a registry/artifact service is later accepted.

If the model were 100x larger, inference would move to GPU-backed serving such as vLLM/TGI with pre-staged weights, independent autoscaling, queueing/backpressure, and streaming. The public/private network boundary remains the same.
