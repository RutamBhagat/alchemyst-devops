# Deploy And Smoke Test

This guide deploys the assignment stack into a throwaway Google Cloud project,
then verifies the public API and the private worker network.

> [!IMPORTANT]
> Use a new throwaway project, not an existing project. Budgets are alerts, not
> hard spending caps. Keep the test short, then follow
> [05-teardown.md](./05-teardown.md).

## What Terraform Creates

`infra/terraform` creates:

- one custom VPC and one private subnet in `us-central1`
- Cloud Router and Cloud NAT for private VM outbound access
- one public `e2-micro` API gateway VM
- one private `e2-micro` caller worker VM
- one private `e2-medium` inference worker VM
- firewall rules for public HTTP, IAP SSH, and private worker RPC

The deployment invariant is that only `alchemyst-devops-api-gateway` has an
external IP address. The caller and inference workers must stay private.

## Install CLIs

Install these locally, or use Cloud Shell if they are already available there:

- Google Cloud CLI: <https://docs.cloud.google.com/sdk/docs/install-sdk>
- Terraform CLI: <https://developer.hashicorp.com/terraform/install>
- Git: <https://git-scm.com/downloads>

Verify the tools:

```bash
gcloud --version
terraform version
git --version
```

Authenticate with Google Cloud:

```bash
gcloud init
gcloud auth application-default login
```

`gcloud init` signs in and creates a local CLI configuration. The application
default login gives Terraform local credentials for the Google provider.

## Set Variables

Choose a billing account you are allowed to use:

```bash
gcloud billing accounts list
```

Set the deployment variables:

```bash
export PROJECT_ID="alchemyst-test-$(date +%s)"
export BILLING_ACCOUNT_ID="PASTE-YOUR-BILLING-ACCOUNT-ID"
export REPO_URL="https://github.com/RutamBhagat/alchemyst-devops.git"
export REGION="us-central1"
export ZONE="us-central1-a"
```

`REPO_URL` must point at a repository URL that the Compute Engine startup
scripts can clone.

## Create The Throwaway Project

```bash
gcloud projects create "$PROJECT_ID" --name="alchemyst-test"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
gcloud config set project "$PROJECT_ID"
```

Enable the APIs used by this guide:

```bash
gcloud services enable \
  compute.googleapis.com \
  iap.googleapis.com \
  cloudbilling.googleapis.com \
  serviceusage.googleapis.com
```

Optional dashboard budget:

1. Open Billing.
2. Go to Budgets & alerts.
3. Create a budget scoped only to this project.
4. Use a small amount such as `$1`.
5. Add thresholds at 50%, 90%, and 100%.

Treat the budget as a warning system only.

## Deploy

From the repository root:

```bash
terraform -chdir=infra/terraform init

terraform -chdir=infra/terraform apply -auto-approve \
  -var="project_id=$PROJECT_ID" \
  -var="repository_url=$REPO_URL"
```

The startup scripts clone the repository on each VM, check out `main`, install
runtime dependencies, and start the systemd services.

## Check VM Shape

```bash
gcloud compute instances list \
  --filter='name~alchemyst-devops' \
  --format='table(name,status,machineType.basename(),networkInterfaces[0].networkIP,networkInterfaces[0].accessConfigs[0].natIP)'
```

Expected result:

- `alchemyst-devops-api-gateway` has a `natIP`
- `alchemyst-devops-caller-worker` has a blank `natIP`
- `alchemyst-devops-inference-worker` has a blank `natIP`

If either worker has a public IP, stop and inspect Terraform before testing the
API.

## Check Services

Use IAP SSH so port `22` does not need to be open to the public internet:

```bash
gcloud compute ssh alchemyst-devops-api-gateway \
  --tunnel-through-iap \
  --zone "$ZONE" \
  --command "systemctl is-active iii-engine nginx; sudo journalctl -u iii-engine -u nginx -n 80 --no-pager"

gcloud compute ssh alchemyst-devops-caller-worker \
  --tunnel-through-iap \
  --zone "$ZONE" \
  --command "systemctl is-active caller-worker; sudo journalctl -u caller-worker -n 80 --no-pager"

gcloud compute ssh alchemyst-devops-inference-worker \
  --tunnel-through-iap \
  --zone "$ZONE" \
  --command "systemctl is-active inference-worker; sudo journalctl -u inference-worker -n 80 --no-pager"
```

All three service checks should print `active`. If a service is not active, use
the journal output from that VM as the first failure point.

## Smoke Test The API

Get the public gateway IP:

```bash
export API_IP="$(terraform -chdir=infra/terraform output -raw api_ip)"
```

Send an inference request:

```bash
curl -fsS -m 90 \
  -X POST "http://${API_IP}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
```

Expected shape:

```json
{"text":"..."}
```

Check request validation:

```bash
curl -i -m 30 \
  -X POST "http://${API_IP}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"bad":true}'
```

Expected result: HTTP `400`, because the TypeScript worker requires
`messages[]` objects with `role` and `content`.

## Network Checks

Worker-to-gateway RPC should work over the private subnet:

```bash
gcloud compute ssh alchemyst-devops-caller-worker \
  --tunnel-through-iap \
  --zone "$ZONE" \
  --command "timeout 5 bash -c '</dev/tcp/10.10.0.10/49134' && echo reachable"
```

Public access to the gateway RPC port should fail:

```bash
nc -vz -w 3 "$API_IP" 49134
```

Port `49134` is intentionally allowed only from worker-tagged VMs to the
gateway. Public ingress is limited to HTTP port `80`.

## Capture Submission Evidence

Before tearing down the project, save the terminal output for:

- `gcloud compute instances list`
- the successful API `curl`
- the invalid request returning HTTP `400`
- each service status and recent journal command
- the private RPC connectivity check
- the failed public `49134` check

Then immediately run the teardown guide.
