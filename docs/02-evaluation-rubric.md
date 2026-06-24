# Evaluation Rubric

This rubric translates the DevOps internship assignment into concrete review
criteria. It is meant to help reviewers grade submissions consistently while
keeping the assignment's central invariant visible:

> [!IMPORTANT]
> Only the API endpoint is public. Custom workers stay private, and inference
> requests reach the model through the iii RPC path.

## Scoring Summary

| Area | Points |
| --- | ---: |
| End-to-end correctness | 30 |
| Network hygiene | 25 |
| Reproducibility | 25 |
| Documentation and operational clarity | 15 |
| Production thinking | 5 |
| **Total** | **100** |

Award partial credit for incomplete submissions when the repository clearly
shows the intended design and the remaining gap is easy to identify.

## 1. End-to-End Correctness (30 points)

| Check | Points | Evidence |
| --- | ---: | --- |
| Public JSON API accepts `POST /v1/chat/completions` and returns a JSON response. | 8 | A working `curl` command and observed response. |
| Request flows through the TypeScript caller worker before inference. | 6 | Logs, code, or runtime trace showing `http::run_inference_over_http` and `inference::get_response`. |
| Inference is performed by the Python worker through `inference::run_inference`. | 8 | Logs or trace showing the Python worker handling the request and returning model output. |
| Workers are split across the required machines rather than co-located as one local process group. | 5 | VM inventory, deployment config, or service definitions. |
| API contract is stable and documented with request and response examples. | 3 | README section with schema and sample payloads. |

Full credit requires the model result to come from the iii RPC chain:

```text
HTTP client
  -> iii-http
  -> http::run_inference_over_http
  -> inference::get_response
  -> inference::run_inference
  -> JSON response
```

Do not award correctness credit for a gateway that bypasses the worker mesh and
calls the model directly.

## 2. Network Hygiene (25 points)

| Check | Points | Evidence |
| --- | ---: | --- |
| VPC and private subnet are explicitly provisioned. | 5 | Terraform, Pulumi, CLI scripts, or equivalent IaC. |
| `caller-worker` and `inference-worker` have no public ingress path. | 7 | No external IPs, restrictive firewall rules, or equivalent cloud controls. |
| Only the API endpoint is reachable from the public internet. | 5 | Firewall rules and public endpoint test. |
| iii worker RPC uses private subnet addressing. | 5 | `III_URL` or equivalent points to a private address, not localhost or a public IP. |
| Administrative access is constrained. | 3 | IAP, SSM, bastion, or another controlled access path instead of open SSH. |

Major deductions:

- Exposing worker VMs directly to the internet.
- Opening iii WebSocket/RPC ports publicly.
- Using public IPs for worker-to-worker communication.

## 3. Reproducibility (25 points)

| Check | Points | Evidence |
| --- | ---: | --- |
| Infrastructure is created from code. | 8 | IaC for network, subnet, VMs, NAT, firewall rules, and outputs. |
| Runtime deployment is automated. | 6 | Startup scripts, systemd units, container manifests, or configuration management. |
| A clean-account redeploy path is documented and executable. | 5 | README steps from prerequisites through API test. |
| Runtime versions and dependency installation are pinned or otherwise repeatable. | 3 | Lockfiles, package pins, image tags, or explicit installer versions. |
| Teardown is documented. | 3 | `terraform destroy`, cloud CLI cleanup, or equivalent. |

The reproducibility boundary is the repository. A reviewer should not need to
remember console clicks or hidden manual steps to rebuild the system.

## 4. Documentation and Operational Clarity (15 points)

| Check | Points | Evidence |
| --- | ---: | --- |
| Architecture diagram shows public gateway, private workers, subnet, and RPC flow. | 4 | README diagram, ASCII or image. |
| README includes the exact `curl` command and sample response. | 3 | Copy-pasteable command using the deployed endpoint. |
| README explains how to redeploy from scratch. | 4 | Ordered setup, deploy, verify, and destroy steps. |
| Troubleshooting information maps failures to the right component. | 2 | Service status commands, logs, or network checks. |
| The submission explains known gaps when incomplete. | 2 | Short writeup that distinguishes implemented work from planned work. |

Good documentation should let another engineer answer three questions quickly:

- Which VM owns each process?
- Which private address or service endpoint do workers use for iii RPC?
- How do I prove the public API is not bypassing the worker mesh?

## 5. Production Thinking (5 points)

| Check | Points | Evidence |
| --- | ---: | --- |
| Hardening discussion covers security and operations. | 3 | TLS, auth, rate limits, observability, least privilege, secrets, and dependency discipline. |
| Larger-model discussion changes the inference tier appropriately. | 2 | GPU serving, model weight handling, queueing, backpressure, streaming, or dedicated model serving. |

This section is intentionally small. The assignment is primarily about making
the distributed prototype work correctly and reproducibly.

## Suggested Review Procedure

1. Read the README and identify the claimed architecture.
2. Inspect the IaC for public IPs, firewall rules, private subnet use, and VM
   count.
3. Inspect deployment configuration for each service and the `III_URL` value
   used by custom workers.
4. Run the documented deploy steps in a clean project or account when possible.
5. Run the documented `curl` command and collect the response.
6. Check logs for the TypeScript caller and Python inference worker during the
   request.
7. Run negative network checks against private workers and iii RPC ports.

## Automatic Red Flags

These issues should cap the score even if other parts are polished:

- **Maximum 60 points** if the public API works but does not use the iii RPC
  worker chain.
- **Maximum 60 points** if workers are deployed but are publicly reachable.
- **Maximum 50 points** if the system only runs locally and no cloud network is
  provisioned.
- **Maximum 50 points** if the deployment depends on undocumented manual console
  steps.
- **Maximum 40 points** if there is no executable path to reproduce the
  infrastructure.

## Incomplete Submission Guidance

Incomplete submissions can still earn meaningful credit when they preserve the
right design invariant and make the gap explicit. For example:

- A working private network plus service definitions can score well on network
  hygiene and reproducibility even if model inference is not fully verified.
- A local end-to-end iii proof can score correctness points, but it does not
  replace the requirement to split workers across private VMs.
- A clear README with honest failure notes can earn documentation credit, but
  it should not hide missing infrastructure or manual steps.
