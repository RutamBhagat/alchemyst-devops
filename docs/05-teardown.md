# Teardown

Use this guide immediately after the smoke test, or sooner if deployment fails.
The stack is Terraform-managed, so the first cleanup path is `terraform destroy`.

> [!CAUTION]
> These commands delete cloud resources. Check `PROJECT_ID` before running them.

## Required Variables

Run from the repository root with the same variables used during deployment:

```bash
export PROJECT_ID="alchemyst-test-REPLACE-ME"
export REPO_URL="https://github.com/RutamBhagat/alchemyst-devops.git"
export REGION="us-central1"
export ZONE="us-central1-a"

gcloud config set project "$PROJECT_ID"
```

## Destroy Terraform Resources

```bash
terraform -chdir=infra/terraform destroy -auto-approve \
  -var="project_id=$PROJECT_ID" \
  -var="repository_url=$REPO_URL"
```

This is the primary cleanup path because Terraform created the VPC, subnet,
Cloud NAT, firewall rules, public IP address, and VMs.

## Verify Resources Are Gone

Each command should return no matching resources:

```bash
gcloud compute instances list --filter='name~alchemyst-devops'
gcloud compute disks list --filter='name~alchemyst-devops'
gcloud compute addresses list --filter='name~alchemyst-devops'
gcloud compute routers list --filter='name~alchemyst-devops'
gcloud compute firewall-rules list --filter='name~alchemyst-devops'
gcloud compute networks list --filter='name=alchemyst-devops-vpc'
```

If all commands are empty, skip to [Stop Billing](#stop-billing).

## Manual Cleanup

Use this section only if Terraform destroy fails or leaves named resources
behind. Delete dependents before deleting the network.

Delete VMs:

```bash
gcloud compute instances delete \
  alchemyst-devops-api-gateway \
  alchemyst-devops-caller-worker \
  alchemyst-devops-inference-worker \
  --zone "$ZONE" --quiet
```

Delete the reserved public IP:

```bash
gcloud compute addresses delete alchemyst-devops-api-ip \
  --region "$REGION" --quiet
```

Delete Cloud NAT and the router:

```bash
gcloud compute routers nats delete alchemyst-devops-nat \
  --router alchemyst-devops-router \
  --region "$REGION" --quiet

gcloud compute routers delete alchemyst-devops-router \
  --region "$REGION" --quiet
```

Delete firewall rules:

```bash
gcloud compute firewall-rules delete \
  alchemyst-devops-allow-api-http \
  alchemyst-devops-allow-iap-ssh \
  alchemyst-devops-allow-worker-rpc \
  --quiet
```

Delete the subnet and VPC:

```bash
gcloud compute networks subnets delete alchemyst-devops-private \
  --region "$REGION" --quiet

gcloud compute networks delete alchemyst-devops-vpc --quiet
```

Run the verification commands again after manual cleanup.

## Stop Billing

After Terraform cleanup succeeds, unlink billing from the throwaway project:

```bash
gcloud billing projects unlink "$PROJECT_ID"
```

Unlinking billing disables billing for the project and stops billable
resources/services from continuing to run. Already-accrued charges can still
post later.

## Delete The Project

Delete the throwaway project after billing is unlinked:

```bash
gcloud projects delete "$PROJECT_ID" --quiet
```

Project deletion stops billing and resource usage, then keeps the project in a
recovery window before permanent deletion.

Dashboard equivalent:

1. Open Billing.
2. Go to My projects.
3. Select the project row and disable billing.
4. Open IAM & Admin.
5. Go to Manage resources.
6. Select the project.
7. Delete it and enter the project ID when prompted.

## Emergency Stop

If cleanup is blocked and costs must stop immediately, unlink billing first:

```bash
gcloud billing projects unlink "$PROJECT_ID"
```

Then delete the project:

```bash
gcloud projects delete "$PROJECT_ID" --quiet
```

This is a hard stop for the throwaway project. Use `terraform destroy` first
when it is available, because it records a clean Terraform-managed teardown.
