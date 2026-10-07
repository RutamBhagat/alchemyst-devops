# Submission Readiness

## Implemented

- Pulumi TypeScript replaces Terraform.
- OCI has public/private subnets, Internet/NAT gateways, NSGs, two private E2 micro VMs, and a public 10 Mbps flexible load balancer.
- iii engine + caller share one `VM.Standard.E2.1.Micro`; quantized inference runs on the other.
- OCI image discovery selects Ubuntu 24.04 Minimal x86 images using the correct OCI version label.
- Only the load balancer receives a public IP; backend HTTP/80 and RPC/49134 are restricted to source NSGs; iii HTTP/3111 is container-only.
- Application services are Dockerized; there are no application systemd units or bootstrap scripts.
- OCI cloud-init installs Docker/Compose, checks out an exact `DEPLOY_REF`, and starts a role-specific Compose file.
- GitHub Actions validates builds, reports container vulnerabilities, produces CycloneDX SBOMs, previews Pulumi when enabled, deploys successful `main` revisions, smoke-tests them, and can roll back to the previous deployed commit.
- A second Pulumi stack targets Floci ECS; Floci launches the same locally built application images as real Docker containers.
- No application Docker registry is required.

## Local Verification Gate

```bash
npm --prefix infra/pulumi install
npm --prefix infra/pulumi run typecheck
npm --prefix infra/pulumi test
docker compose -f deploy/docker/build.compose.yaml config -q
npm --prefix quickstart/workers/caller-worker ci
npm --prefix quickstart/workers/caller-worker run build
python3 -m py_compile quickstart/workers/inference-worker/inference_worker.py
git diff --check
```

CI also builds the application images, runs Python runtime regressions, and executes `deploy/smoke-test.py` against `e2-test.compose.yaml` under the production container memory limits.

## Real Deployment Gate

Capture evidence from OCI:

1. `pulumi up` succeeds from `infra/pulumi/oci`.
2. `pulumi stack output apiIp` returns the load balancer public IP.
3. The inference curl returns `{ "text": "..." }`.
4. An invalid request returns HTTP 400.
5. OCI confirms caller/inference VNICs have no public IPs.
6. Public access to backend HTTP/3111 and RPC/49134 fails.
7. The role containers are running on both VMs; the load-balancer backend is healthy.
8. `pulumi destroy` removes the stack cleanly.

Floci is the local container/IaC compatibility target; it does not prove OCI capacity or OCI-specific networking in a tenancy.
