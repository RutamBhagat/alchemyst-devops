# OCI Always Free Deployment Plan

Pulumi provisions two private Ubuntu 24.04 Minimal VMs; Docker Compose owns the application runtime. Oracle's public load balancer replaces the public gateway VM, not the iii engine. A private nginx sidecar retains the original 1 MiB body cap, which iii HTTP alone does not enforce.

## Resources

- VCN `10.10.0.0/16`, public load-balancer subnet `10.10.0.0/24`, private VM subnet `10.10.1.0/24`
- Internet Gateway for the load balancer; NAT Gateway for private image/package/model downloads
- Egress-only subnet security list
- Load-balancer NSG: public HTTP/80 only
- API NSG: HTTP/80 from the load-balancer NSG; RPC/49134 from the inference NSG
- Inference NSG: no inbound application ports
- API VM `10.10.1.11`: nginx + iii engine + TypeScript caller, `deploy/docker/api.compose.yaml`
- Inference VM `10.10.1.12`: quantized Python GGUF runtime, `deploy/docker/inference.compose.yaml`

Neither VM has a public IP. Optional SSH rules are for private administration (e.g. OCI Bastion), not public SSH. The public HTTP listener forwards to `10.10.1.11:80`; nginx forwards to container-only iii HTTP/3111. Its `/health` check verifies that the caller can reach the loaded inference worker through iii, returning 503 until ready.

## Free-Tier Budget

Both VMs are fixed to `VM.Standard.E2.1.Micro` (1 GB RAM, 1/8 OCPU), with 50 GB boot volumes. The flexible load balancer's **minimum and maximum are both 10 Mbps**; neither the VM shapes nor bandwidth are configurable to paid values. Deploy in the tenancy's **home region**, and count existing resources against its shared allowances.

[Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) allow two E2 micros and one 10 Mbps flexible load balancer for eligible tenancies. Existing A1 instances are unrelated to this stack; their volumes still count toward the 200 GB total block/boot storage allowance. Capacity is not guaranteed, and Oracle can reclaim idle free instances.

Container limits leave host memory available: iii 192 MiB, caller 128 MiB, nginx 32 MiB, inference 768 MiB (no runtime swap). Cloud-init allocates 2 GiB of host swap to make on-VM dependency/image builds safer, enables Docker, clones the repository, checks out `DEPLOY_REF`/`deployRef`, and builds/starts the appropriate Compose file. Native llama.cpp builds use one compile job; initial boot can take many minutes on a micro.

## Model Runtime

The same Gemma 3 270M Q8 GGUF now runs via llama.cpp without loading Torch/Transformers or expanding the quantized weights. Python `iii-sdk`/`iii-helpers` are pinned to 0.24.4, which contains the [upstream clean-WebSocket-close reconnect fix](https://github.com/iii-hq/iii/pull/2243); the engine is pinned to 0.20.0 (retaining the built-in HTTP worker and supporting the new telemetry WebSocket endpoint). The caller SDK remains at 0.11; its API/RPC/logging compatibility is exercised by integration tests, including an engine restart. Model revision and SHA256 are pinned; downloads are streamed and atomically cached in a Docker volume. Conversation formatting and `{ "text": "..." }` are preserved. Necessary runtime deltas: greedy quantized generation (not bit-identical to Transformers), a 2048-token context window, and serialized generation. Output remains capped at 256 new tokens. Generation on the shared CPU can exceed the old 30-second budget: inference RPC allows 180 seconds, its caller wrapper 190 seconds, HTTP 210 seconds, and nginx/load-balancer idle timeout 240 seconds.

## Configuration

Required: `oci:region`, `compartmentId`, `availabilityDomain`, `repositoryUrl`.
Optional: `deployRef` (default `main`), `amdImageId`, `sshAuthorizedKey`, `sshAllowedCidr`.

Image discovery filters OCI's **`24.04 Minimal`** version label, not `24.04` (which excludes Minimal), and rejects aarch64 images. `amdImageId` can pin a compatible x86 platform image explicitly.
