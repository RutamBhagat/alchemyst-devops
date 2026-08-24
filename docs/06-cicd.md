# Registry-Free CI/CD

The production pipeline deliberately does not use OCIR, Docker Hub, GHCR, or another application-image registry.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

- Pulumi TypeScript typecheck
- caller TypeScript install/build
- Python syntax check
- Docker Compose validation
- real local builds of all four images
- an additional `linux/arm64` inference build, matching OCI A1
- Trivy HIGH/CRITICAL vulnerability reports
- CycloneDX SBOM artifacts for each application image
- optional OCI `pulumi preview` on same-repository pull requests

The security scan is currently advisory (`exit-code: 0`) so existing upstream findings are visible without making the assignment unusable. Tighten it to a blocking policy once the initial findings are triaged.

## Deployment version

OCI deploys a Git revision rather than an image tag. The workflow supplies:

```text
DEPLOY_REF=<exact commit SHA>
```

Pulumi embeds that ref in cloud-init. Each VM clones the repository, checks out that exact ref in detached-HEAD mode, and builds its role images locally. A `DEPLOY_REF` change changes instance metadata; Pulumi is configured to replace the fixed-IP instances so cloud-init runs for the new revision.

This is more reproducible than following `main`, but it is not equivalent to an immutable prebuilt image digest: public base images/packages still have to be fetched at build time. The Docker base-image references are digest-pinned to reduce that variability.

## Production deployment

`.github/workflows/deploy-oci.yml` runs only after the `CI` workflow succeeds on `main`, unless manually dispatched. Automatic deployment is additionally gated by repository variable `ENABLE_OCI_DEPLOY=true`.

The deployment:

1. reads the previous `deployedRef` stack output,
2. runs `pulumi up` with the successful CI commit as `DEPLOY_REF`,
3. waits for a real `/v1/chat/completions` request to succeed,
4. verifies invalid input returns HTTP 400,
5. verifies public TCP/49134 is closed,
6. attempts the previous `deployedRef` automatically if smoke verification fails.

Manual `workflow_dispatch` accepts `deploy_ref`, so a known-good commit can be redeployed explicitly.

## GitHub configuration

Use GitHub environments `production-preview` and `production`. Put cloud credentials in environment secrets so deployment protection/approval rules can gate access.

Required secrets:

```text
PULUMI_ACCESS_TOKEN
OCI_TENANCY_OCID
OCI_USER_OCID
OCI_FINGERPRINT
OCI_PRIVATE_KEY
OCI_REGION
```

Recommended repository/environment variables:

```text
PULUMI_STACK=dev
ENABLE_OCI_PREVIEW=true
ENABLE_OCI_DEPLOY=true
```

The Pulumi stack itself still owns non-secret deployment configuration such as `compartmentId`, `availabilityDomain`, and `repositoryUrl`.
