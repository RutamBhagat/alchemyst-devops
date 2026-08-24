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
- OCI credentials (`~/.oci/config` or another supported provider auth method)
- an OCI compartment
- an availability domain with capacity for the selected shapes

Create/configure a stack:

```bash
cd infra/pulumi/oci
pulumi stack init dev
pulumi config set oci:region ap-mumbai-1
pulumi config set compartmentId '<compartment-ocid>'
pulumi config set availabilityDomain '<availability-domain>'
pulumi config set repositoryUrl 'https://github.com/RutamBhagat/alchemyst-devops.git'
```

The defaults use `VM.Standard.E2.1.Micro` for gateway/caller and `VM.Standard.A1.Flex` at 1 OCPU / 6 GB for inference. Pulumi discovers the newest compatible Ubuntu 24.04 Minimal images. Optional explicit pins:

```bash
pulumi config set amdImageId '<Canonical-Ubuntu-24.04-Minimal-x86-image-ocid>'
pulumi config set armImageId '<Canonical-Ubuntu-24.04-Minimal-aarch64-image-ocid>'
pulumi config set sshAuthorizedKey "$(cat ~/.ssh/id_ed25519.pub)"
pulumi config set sshAllowedCidr '203.0.113.10/32'
```

Deploy:

```bash
pulumi preview
pulumi up
```

Cloud-init installs Ubuntu's Docker Engine/Compose packages, clones the repository, builds the role image(s) locally on each VM, and starts them. No application registry or `docker pull` of application images is involved.

Smoke test:

```bash
API_IP="$(pulumi stack output apiIp)"
curl -fsS -m 90 -X POST "http://${API_IP}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
```

Validation request:

```bash
curl -i -m 30 -X POST "http://${API_IP}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"bad":true}'
```

Expected: HTTP 400.

Network expectations:

- gateway: private `10.10.0.10` + public IP
- caller: private `10.10.1.11`, no public IP
- inference: private `10.10.1.12`, no public IP
- public TCP/80 succeeds
- public TCP/49134 fails

If gateway SSH was enabled, inspect its containers with:

```bash
ssh ubuntu@"$API_IP" 'sudo docker compose -f /opt/devops-assignment/deploy/docker/gateway.compose.yaml ps; sudo docker compose -f /opt/devops-assignment/deploy/docker/gateway.compose.yaml logs --tail=100'
```

Workers deliberately have no public SSH path; use OCI Bastion or another private administrative path if worker inspection is required.

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
