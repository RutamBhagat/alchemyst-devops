# OCI live verification — 2026-10-08

Deployment, public inference, restart recovery, and teardown passed on actual OCI in Frankfurt AD-3. OCI CLI used security-token authentication; Pulumi provisioned and destroyed the repository's infrastructure. A private Object Storage working-tree snapshot supplied the source without a GitHub push.

The cold inference build now downloads the official `llama-cpp-python` 0.3.19 AMD64 CPU wheel, verifies its release SHA-256, and requires binary packages. The pinned Alpine base supplies the wheel's musl runtime, libstdc++, and libgomp. The exact GGUF, prompt tokens, and deterministic output matched the previous 0.3.36 runtime. The model's existing repetitive output was preserved.

Final deployed source archive SHA-256:

```text
512c122cc5406fbd61df513cc523773da896016e82972ba2795148a93a522297
```

Both VM bootstrap logs confirmed that digest. Inference bootstrap finished in 276.53 seconds of VM uptime; API bootstrap finished in 325.48 seconds. The wheel ran on the actual AMD EPYC 7551 CPU.

Verified results:

- Exactly two private `VM.Standard.E2.1.Micro` instances; neither VNIC had a public IP.
- Public flexible load balancer fixed at 10 Mbps minimum and maximum; final OCI health status `OK`.
- Public TCP/80 reachable; TCP/3111 and TCP/49134 inaccessible.
- Public health returned 200 with `{"ready":true}`. All eight invalid-input cases returned the expected 400 body; oversized requests returned 413; empty messages returned 500.
- Public real inference passed in 31.79 seconds. The initial deployment also passed the full smoke test, in 28.05 seconds for inference.
- After engine restart, public readiness recovered in 5.97 seconds and real inference passed in 26.01 seconds.
- Stopping inference produced public health 503 with `{"ready":false}`; restarting it recovered readiness in 17.12 seconds.
- OCI CLI soft-reset both VMs. Changed kernel boot IDs confirmed both actual reboots; public readiness recovered in 110.31 seconds after the reboot checks, and real inference passed in 33.43 seconds. The load balancer requires three successful health checks at its default 30-second interval.
- All four containers were running afterward, without OOM kills or automatic failure restarts. Actual memory caps were engine 192 MiB, caller 128 MiB, nginx 32 MiB, and inference 768 MiB. Highest observed inference cgroup memory peak was 433.4 MiB.

Local validation also passed: six Python runtime tests, two infrastructure tests, TypeScript typechecking, Compose validation, workflow lint, and the AMD64 memory/CPU-limited mesh. The archive test executes the checksum gate and proves corrupt source cannot be extracted or start containers. Local Compose explicitly selects AMD64 inference on ARM hosts.

Teardown completed: Pulumi deleted 23 resources in 1m47s, and `live-e2` has zero resources. OCI CLI deleted the temporary Bastion, both forwarding sessions, both PARs, both source objects, and the temporary bucket. Both former source URLs returned 401 afterward. The final CLI inventory found zero active test instances, boot volumes in all three ADs, load balancers, VCNs, subnets, NSGs, route tables, security lists, internet/NAT gateways, buckets, or Bastions. Existing A1 remained `RUNNING`. Test VMs and their boot volumes were deleted; the deployment can recreate them from source.

Raw measurements and methods remain in the gitignored `.temp/` directory: `wheel-results.md`, `verify-live.py`, `final-verification.log`, `live-validation.json`, `oci-audit.py`, `oci-before-inventory.json`, `oci-after-inventory.json`, `live-destroy.log`, `cleanup-extras.log`, and `verify-cleanup.log`. Private delivery URLs and credentials are excluded from this report.
