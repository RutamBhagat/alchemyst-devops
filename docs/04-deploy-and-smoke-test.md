# Deploy and Smoke Test

There are two Pulumi targets:

- `infra/pulumi/oci`: real OCI VMs running Docker Compose
- `infra/pulumi/floci`: local Floci ECS deployment using the same application images

Install Pulumi dependencies once:

```bash
npm --prefix infra/pulumi install
npm --prefix infra/pulumi run typecheck
```

For account-free Pulumi state:

```bash
export PULUMI_CONFIG_PASSPHRASE='choose-a-local-state-passphrase'
pulumi login --local
```

## OCI

### Prerequisites

- Pulumi CLI
- OCI credentials (`~/.oci/config` or another supported provider auth method); browser sessions need `oci:auth=SecurityToken` and a current token
- an OCI compartment
- an availability domain with capacity for the selected shapes

Create/configure a stack:

```bash
cd infra/pulumi/oci
pulumi stack init dev
pulumi config set oci:region '<tenancy-home-region>'
# For browser-authenticated ~/.oci/config sessions:
# pulumi config set oci:auth SecurityToken
# pulumi config set oci:configFileProfile DEFAULT
pulumi config set compartmentId '<compartment-ocid>'
pulumi config set availabilityDomain '<availability-domain>'
pulumi config set repositoryUrl 'https://github.com/RutamBhagat/alchemyst-devops.git'
pulumi config set deployRef main  # optional locally; CI uses DEPLOY_REF=<commit SHA>
```

Choose an availability domain with E2 micro quota; it is not necessarily AD-1. This tenancy's Frankfurt quota is **two in AD-3, zero in AD-1/AD-2** (checked 2026-10-07). Check your own tenancy before setting `availabilityDomain`:

```bash
oci limits resource-availability get --auth security_token \
  --compartment-id '<tenancy-ocid>' --service-name compute \
  --limit-name vm-standard-e2-1-micro-count --availability-domain '<AD-with-micro-quota>'
```

Quota availability does not guarantee physical host capacity. The stack uses two private `VM.Standard.E2.1.Micro` VMs, each with 1 GB RAM and a 50 GB boot volume, plus one public flexible load balancer fixed to 10 Mbps. Confirm your tenancy's shared free allowances are available. Pulumi discovers the newest compatible Ubuntu 24.04 Minimal x86 image. Optional pins/private SSH configuration:

```bash
pulumi config set amdImageId '<Canonical-Ubuntu-24.04-Minimal-x86-image-ocid>'
pulumi config set sshAuthorizedKey "$(cat ~/.ssh/id_ed25519.pub)"
pulumi config set sshAllowedCidr '203.0.113.10/32'
```

Deploy:

```bash
pulumi preview
pulumi up
```

Cloud-init creates 2 GiB of build-time swap, installs/enables Ubuntu's Docker Engine/Compose packages, clones the repository, checks out the configured `deployRef`/`DEPLOY_REF`, builds the role image(s) locally on each VM, and starts them. The revision must contain these changes (uncommitted local edits are not uploaded). Allow up to an hour for native compilation and model download on a micro. No application registry or `docker pull` of application images is involved. Changing the deployment ref replaces the fixed-IP VMs so cloud-init runs for the new revision.

Smoke test:

```bash
API_IP="$(pulumi stack output apiIp)"
API_URL="$(pulumi stack output apiUrl)" READY_TIMEOUT=3600 python3 ../../../deploy/smoke-test.py
```

Validation request:

```bash
curl -i -m 30 -X POST "http://${API_IP}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"bad":true}'
```

Expected: HTTP 400.

Network expectations:

- load balancer: public IP, HTTP/80 only
- iii engine + caller: private `10.10.1.11`, no public IP
- inference: private `10.10.1.12`, no public IP
- backend HTTP/80 accepts only load-balancer traffic; iii HTTP/3111 is container-only
- RPC/49134 accepts only inference-worker traffic
- `/health` returns 200 only after model loading and worker registration
- public TCP/3111 and TCP/49134 fail

Both VMs deliberately have no public SSH path. Use OCI Bastion or another private administrative path; inspect `api.compose.yaml` or `inference.compose.yaml` with Docker, and `/var/log/cloud-init-output.log` for bootstrap failures.

A local memory-limited regression test (not a substitute for OCI networking/capacity validation):

```bash
# From the repository root
npm --prefix infra/pulumi test
docker compose -p e2-test -f deploy/docker/e2-test.compose.yaml up -d --build
python3 deploy/smoke-test.py
docker run --rm --memory 768m --memory-swap 768m alchemyst/inference:local python -m unittest -v test_runtime
docker compose -p e2-test -f deploy/docker/e2-test.compose.yaml down
```

## Floci

Floci ECS is Docker-backed, so the emulator needs access to the host Docker socket. Start it:

```bash
cd infra/pulumi/floci
docker compose up -d
docker compose ps
curl -fsS http://localhost:4566/
```

Build the application images locally from the repository root. They are tagged only in the local Docker daemon and are not pushed to a registry:

```bash
cd ../../..
docker compose -f deploy/docker/build.compose.yaml build
```

Configure Pulumi:

```bash
cd infra/pulumi/floci
pulumi stack init dev
pulumi config set endpoint 'http://localhost:4566'
pulumi config set region 'us-east-1'
```

On Docker Desktop, ECS task containers reach the gateway's published RPC port through `host.docker.internal`. Override that only when using another Docker host topology:

```bash
pulumi config set gatewayHost 'host.docker.internal'
```

Deploy the ECS cluster, task definitions, and services:

```bash
pulumi preview
pulumi up
```

The gateway task publishes HTTP on localhost port `8080` and RPC on `49134`.

Smoke test:

```bash
curl -fsS -m 90 -X POST http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
```

Inspect the emulator and ECS task containers:

```bash
docker logs --tail 200 alchemyst-floci
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
```

The inference container downloads the GGUF model on first start, so its first healthy request can be substantially slower than subsequent starts when its cache is retained.
