# Submission Readiness Review

> [!IMPORTANT]
> This repository is close to a strong submission, but it should not be presented
> as fully verified until a real GCP deployment has returned an inference result
> through the public JSON API and the worker logs show the iii RPC chain.

## Verdict

The solution is architecturally aligned with the assignment. Terraform provisions
a private GCP network, the two custom worker VMs have no external IP addresses,
only the gateway exposes HTTP, and both workers connect to the iii engine through
the private subnet.

The main remaining gap is evidence. The README documents the expected API shape
and sample response, but the rubric gives the most credit for an observed
end-to-end request:

```text
HTTP client
  -> nginx on api-gateway
  -> iii-http
  -> http::run_inference_over_http
  -> inference::get_response
  -> inference::run_inference
  -> JSON response
```

Submit as fully complete only after capturing that deployed response and the
corresponding worker logs.

## What Looks Ready

- Network hygiene is strong: public ingress is limited to gateway port `80`,
  SSH is constrained to IAP, and worker RPC to `49134` is limited to worker VM
  tags.
- The workers are split across separate VMs instead of being co-located on the
  gateway.
- `iii-http` is bound to `127.0.0.1` on the gateway and exposed publicly only
  through nginx.
- The TypeScript worker preserves the required call path from the HTTP trigger
  to `inference::get_response`, then to Python `inference::run_inference`.
- The README includes the architecture diagram, curl command, redeploy steps,
  network checks, production hardening notes, and larger-model discussion.

## Gaps Before Submission

1. Add real deployed evidence.

   The README currently has a sample response, but reviewers need proof that the
   public API returned a model result through the worker mesh. Add a short
   verification section with the actual `curl` output and logs from both custom
   workers.

2. Run Terraform and GCP checks in an environment with the tools installed.

   During review, `terraform` and `gcloud` were not available locally, so
   `terraform validate`, `terraform apply`, and cloud network checks could not
   be executed from this workspace.

3. Verify iii engine and SDK version compatibility.

   The deployment installs iii `0.12.0`, while both SDK dependencies are pinned
   to `0.11.0`. Either prove that exact mix works in deployment or align the
   versions before submitting.

4. Tighten runtime reproducibility if time allows.

   Python dependencies are mostly unpinned, and the caller worker bootstrap uses
   `npm install` instead of `npm ci`. This is not the central assignment
   invariant, but it can cost reproducibility points.

## Checks Already Run

These local checks passed:

```bash
npm ci
npm run build
python3 -m py_compile quickstart/workers/inference-worker/inference_worker.py
bash -n deploy/scripts/bootstrap-gateway.sh
bash -n deploy/scripts/bootstrap-caller.sh
bash -n deploy/scripts/bootstrap-inference.sh
```

`npm ci` also reported dependency audit findings. Treat those as production
hardening work, not an assignment blocker.

A local `iii --config quickstart/config.yaml` smoke test started the engine and
showed the worker manager listening on `0.0.0.0:49134`. That supports the
private-VM RPC design, but it was run with local iii `0.19.7`, not the deployed
`0.12.0`, so it does not prove deployed behavior.

## Final Submission Checklist

Run these from an environment with Terraform and the Google Cloud SDK installed:

```bash
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform apply \
  -var="project_id=<project-id>" \
  -var="repository_url=https://github.com/<user>/<repo>.git"
```

Then prove the public API:

```bash
curl -X POST "http://$(terraform -chdir=infra/terraform output -raw api_ip)/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

Collect service and worker evidence:

```bash
gcloud compute ssh alchemyst-devops-api-gateway \
  --tunnel-through-iap \
  --zone us-central1-a \
  --command "systemctl status iii-engine nginx"

gcloud compute ssh alchemyst-devops-caller-worker \
  --tunnel-through-iap \
  --zone us-central1-a \
  --command "journalctl -u caller-worker -n 50 --no-pager"

gcloud compute ssh alchemyst-devops-inference-worker \
  --tunnel-through-iap \
  --zone us-central1-a \
  --command "journalctl -u inference-worker -n 50 --no-pager"

gcloud compute instances list
```

## Recommendation

If submitted as-is, frame it as an incomplete but well-designed solution with a
clear deployment plan. If the GCP deployment is verified and the README includes
the actual response plus worker logs, the solution should be good enough to send
to the interviewer.
