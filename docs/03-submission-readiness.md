# Submission Readiness

## Implemented

- Pulumi TypeScript replaces Terraform.
- OCI is the real-cloud target with VCN, public/private subnets, Internet/NAT gateways, NSGs, and three compute instances.
- OCI defaults to two `VM.Standard.E2.1.Micro` VMs plus one `VM.Standard.A1.Flex` VM at 1 OCPU / 6 GB.
- OCI image discovery explicitly selects Ubuntu 24.04 Minimal for x86_64 and Arm64.
- Only the OCI gateway can receive a public IP; RPC/49134 is restricted to the worker NSG.
- Application services are Dockerized; there are no application systemd units or bootstrap scripts.
- OCI cloud-init installs Docker/Compose, clones the repo, and starts a role-specific Compose file.
- A second Pulumi stack targets Floci ECS; Floci launches the same locally built application images as real Docker containers.
- No application Docker registry is required.

## Local Verification Gate

```bash
npm --prefix infra/pulumi install
npm --prefix infra/pulumi run typecheck
docker compose -f deploy/docker/build.compose.yaml config -q
npm --prefix quickstart/workers/caller-worker ci
npm --prefix quickstart/workers/caller-worker run build
python3 -m py_compile quickstart/workers/inference-worker/inference_worker.py
git diff --check
```

A stronger local gate also builds the four application images:

```bash
docker compose -f deploy/docker/build.compose.yaml build
```

## Real Deployment Gate

Capture evidence from OCI:

1. `pulumi up` succeeds from `infra/pulumi/oci`.
2. `pulumi stack output apiIp` returns the gateway public IP.
3. The inference curl returns `{ "text": "..." }`.
4. An invalid request returns HTTP 400.
5. OCI confirms caller/inference VNICs have no public IPs.
6. Public access to gateway RPC/49134 fails.
7. The role containers are running on all three VMs.
8. `pulumi destroy` removes the stack cleanly.

Floci is the local container/IaC compatibility target; it does not prove OCI capacity or OCI-specific networking in a tenancy.
