# Teardown

## OCI

From the configured OCI Pulumi project:

```bash
cd infra/pulumi/oci
pulumi destroy
```

Destroying the compute instances also removes their locally built Docker images/containers and the inference cache stored on their boot volumes.

Then verify the stack has no managed resources:

```bash
pulumi stack --show-urns
```

If destroy fails, inspect OCI resources tagged `project=alchemyst-devops`. Delete compute instances before network dependencies, then subnets/NSGs/route tables/gateways, then the VCN.

Pulumi does not manage the OCI compartment or tenancy billing configuration.

## Floci

Destroy the emulated ECS resources first:

```bash
cd infra/pulumi/floci
pulumi destroy
```

Then stop/remove Floci:

```bash
docker compose down --remove-orphans
```

Inspect any surviving Floci-created Docker containers before manual cleanup:

```bash
docker ps -a --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Labels}}'
```

Locally built application images are intentionally outside Pulumi state. Remove them only if desired:

```bash
docker image rm \
  alchemyst/iii-engine:local \
  alchemyst/gateway-proxy:local \
  alchemyst/caller:local \
  alchemyst/inference:local
```
