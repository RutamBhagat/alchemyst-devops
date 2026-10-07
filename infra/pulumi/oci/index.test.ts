import assert from "node:assert/strict";
import { test } from "node:test";
import * as pulumi from "@pulumi/pulumi";

const resources: pulumi.runtime.MockResourceArgs[] = [];
let backendReady: () => void;
let listenerReady: () => void;
const registered = [
  new Promise<void>((resolve) => { backendReady = resolve; }),
  new Promise<void>((resolve) => { listenerReady = resolve; }),
];
pulumi.runtime.setMocks({
  newResource(args) {
    resources.push(args);
    if (args.name === "api-backend") backendReady();
    if (args.name === "api-http-listener") listenerReady();
    return { id: `${args.name}-id`, state: {
      ...args.inputs,
      privateIp: args.inputs.createVnicDetails?.privateIp,
      ipAddresses: args.type === "oci:LoadBalancer/loadBalancer:LoadBalancer" ? ["203.0.113.1"] : undefined,
    } };
  },
  call(args) {
    if (args.token === "oci:Core/getImages:getImages") {
      assert.equal(args.inputs.operatingSystemVersion, "24.04 Minimal");
      assert.equal(args.inputs.shape, "VM.Standard.E2.1.Micro");
      return { images: [{ id: "ubuntu-amd", displayName: "Canonical-Ubuntu-24.04-Minimal-2026.09.01-0" }] };
    }
    return args.inputs;
  },
}, "alchemyst-devops-oci", "test", false);
pulumi.runtime.setAllConfig({
  "alchemyst-devops-oci:compartmentId": "compartment",
  "alchemyst-devops-oci:availabilityDomain": "AD-1",
  "alchemyst-devops-oci:repositoryUrl": "https://example.com/repo.git",
});

function value<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply((v) => { resolve(v); return v; }));
}

test("two private E2 micros behind one fixed 10 Mbps HTTP load balancer", async () => {
  await pulumi.runtime.runInPulumiStack(async () => {
    const deployment = await import("./index");
    assert.equal(await value(deployment.apiUrl), "http://203.0.113.1/v1/chat/completions");
    await value(deployment.inferencePrivateIp);
  });
  await Promise.all(registered);
  const instances = resources.filter((r) => r.type === "oci:Core/instance:Instance");
  assert.equal(instances.length, 2);
  for (const vm of instances) {
    assert.equal(vm.inputs.shape, "VM.Standard.E2.1.Micro");
    assert.equal(vm.inputs.shapeConfig, undefined);
    assert.equal(vm.inputs.createVnicDetails.assignPublicIp, "false");
    assert.equal(vm.inputs.sourceDetails.bootVolumeSizeInGbs, "50");
    assert.equal(vm.inputs.preserveBootVolume, false);
    const init = Buffer.from(vm.inputs.metadata.user_data, "base64").toString();
    assert.match(init, /docker.*compose/);
    assert.match(init, /swap:\n  filename: \/swapfile\n  size: 2147483648/);
    assert.ok(init.indexOf('"systemctl","enable","--now","docker"') < init.indexOf('"git","clone"'));
    assert.match(init, vm.name === "api-worker" ? /api\.compose\.yaml/ : /inference\.compose\.yaml/);
  }
  const lb = resources.find((r) => r.type === "oci:LoadBalancer/loadBalancer:LoadBalancer")!;
  assert.equal(lb.inputs.shape, "flexible");
  assert.deepEqual(lb.inputs.shapeDetails, { minimumBandwidthInMbps: 10, maximumBandwidthInMbps: 10 });
  assert.equal(lb.inputs.isPrivate, false);
  const backend = resources.find((r) => r.type === "oci:LoadBalancer/backend:Backend")!;
  assert.equal(backend.inputs.ipAddress, "10.10.1.11");
  assert.equal(backend.inputs.port, 80);
  const health = resources.find((r) => r.type === "oci:LoadBalancer/backendSet:BackendSet")!;
  assert.equal(health.inputs.healthChecker.protocol, "HTTP");
  assert.equal(health.inputs.healthChecker.port, 80);
  assert.equal(health.inputs.healthChecker.urlPath, "/health");
  assert.equal(health.inputs.healthChecker.returnCode, 200);
  const listener = resources.find((r) => r.type === "oci:LoadBalancer/listener:Listener")!;
  assert.equal(listener.inputs.port, 80);
  assert.equal(listener.inputs.protocol, "HTTP");
  assert.equal(listener.inputs.connectionConfiguration.idleTimeoutInSeconds, "240");
  const ingress = resources.filter((r) => r.type === "oci:Core/networkSecurityGroupSecurityRule:NetworkSecurityGroupSecurityRule" && r.inputs.direction === "INGRESS");
  const publicRules = ingress.filter((r) => r.inputs.source === "0.0.0.0/0");
  assert.equal(publicRules.length, 1);
  assert.equal(publicRules[0].inputs.tcpOptions.destinationPortRange.min, 80);
  assert.ok(!ingress.some((r) => r.inputs.tcpOptions?.destinationPortRange.min === 3111));
  for (const port of [80, 49134]) {
    const rule = ingress.find((r) => r.inputs.tcpOptions?.destinationPortRange.min === port && r.inputs.sourceType === "NETWORK_SECURITY_GROUP")!;
    assert.equal(rule.inputs.sourceType, "NETWORK_SECURITY_GROUP");
  }
});
