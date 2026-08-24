# OCI Pulumi Deployment Plan

The real-cloud target is OCI. Pulumi provisions the infrastructure; Docker Compose owns the application runtime on each VM.

## Resource Model

`infra/pulumi/oci` creates:

- VCN `10.10.0.0/16`
- public gateway subnet `10.10.0.0/24`
- private worker subnet `10.10.1.0/24`
- Internet Gateway for the public subnet
- NAT Gateway for private-worker outbound traffic
- egress-only subnet security list
- gateway NSG: HTTP/80 from the internet and RPC/49134 only from the worker NSG
- worker NSG with no ingress rules
- gateway `10.10.0.10` with a public IP
- caller `10.10.1.11` without a public IP
- inference `10.10.1.12` without a public IP

## Compute Allocation

Defaults are intentionally inside OCI Always Free compute allowances:

- gateway: `VM.Standard.E2.1.Micro` (AMD, 1 GB)
- caller: `VM.Standard.E2.1.Micro` (AMD, 1 GB)
- inference: `VM.Standard.A1.Flex` (Ampere Arm), 1 OCPU / 6 GB

Shapes remain configurable per role.

## Ubuntu Minimal Image Selection

Pulumi asks OCI for Ubuntu 24.04 images compatible with each shape, sorts newest-first, then selects the Minimal family:

```text
AMD: Canonical-Ubuntu-24.04-Minimal-*
Arm: Canonical-Ubuntu-24.04-Minimal-aarch64-*
```

`amdImageId` and `armImageId` can pin explicit platform-image OCIDs.

## Runtime Bootstrap

There are no application systemd units or repository bootstrap scripts. Pulumi generates small cloud-init user data that:

1. installs `git`, `docker.io`, and `docker-compose-v2` from Ubuntu repositories;
2. clones `main` to `/opt/devops-assignment`;
3. runs the role-specific Compose file with `docker compose up -d --build`.

Docker restart policies (`unless-stopped`) keep application containers running. Docker Engine itself remains a host service provided by Ubuntu.

The three host roles use:

```text
gateway   -> deploy/docker/gateway.compose.yaml
caller    -> deploy/docker/caller.compose.yaml
inference -> deploy/docker/inference.compose.yaml
```

Worker containers connect to `ws://10.10.0.10:49134`. The inference container stores Hugging Face data in a Docker volume.

## OCI Inputs

Required stack config:

```text
oci:region
compartmentId
availabilityDomain
repositoryUrl
```

Optional:

```text
amdImageId          # x86_64 Ubuntu 24.04 Minimal image OCID
armImageId          # aarch64 Ubuntu 24.04 Minimal image OCID
gatewayShape        # default VM.Standard.E2.1.Micro
callerShape         # default VM.Standard.E2.1.Micro
inferenceShape      # default VM.Standard.A1.Flex
sshAuthorizedKey
sshAllowedCidr
```

## Why Two Subnets

A public OCI VNIC needs a subnet that allows public addresses and routes through an Internet Gateway. Workers must remain private while still reaching package registries and Hugging Face, so their subnet routes outbound traffic through the NAT Gateway.
