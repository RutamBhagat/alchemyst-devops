# Registry-Free CI/CD

The production pipeline deliberately does not use OCIR, Docker Hub, GHCR, or another application-image registry.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

- Pulumi TypeScript typecheck and mocked two-micro/load-balancer regression
- caller TypeScript install/build
- Python syntax check
- deployment CI-gate regressions
- Docker Compose validation
- real local builds of all four images
- Python prompt/cache/serialized-generation regressions
- real inference and HTTP contract smoke tests with E2 container memory limits and a 0.25-vCPU inference quota
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

`.github/workflows/deploy-oci.yml` runs only through manual `workflow_dispatch`. CI still runs automatically on pull requests and pushes to `main`; successful CI never deploys automatically.

Before running Pulumi, the workflow resolves `deploy_ref` to an exact commit SHA and requires its latest `ci.yml` push run on `main` to have completed successfully. Missing, pending, skipped, or failed CI blocks deployment. Both the checked-out infrastructure and `DEPLOY_REF` use that verified SHA, so a moving ref cannot change the deployment after verification.

The deployment:

1. reads the previous `deployedRef` stack output,
2. runs `pulumi up` with the manually selected, CI-verified commit as `DEPLOY_REF`,
3. waits for `/health` to verify the loaded inference worker (up to an hour for initial micro builds),
4. runs the shared smoke test: real inference, invalid input HTTP 400, the 1 MiB body limit, and the existing empty-messages failure contract,
5. verifies public TCP/49134 is closed,
6. attempts the previous `deployedRef` automatically if smoke verification fails.

To deploy or roll back, open **Actions → Deploy OCI → Run workflow** and enter a known-good commit SHA or tag as `deploy_ref`. The revision must have passed CI on `main`. Select a workflow branch containing the verification helper.

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
```

The Pulumi stack itself still owns non-secret deployment configuration such as `compartmentId`, `availabilityDomain`, and `repositoryUrl`.
