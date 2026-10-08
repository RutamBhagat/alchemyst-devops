import * as pulumi from "@pulumi/pulumi";
import * as oci from "@pulumi/oci";
import { dockerCloudInit, type DeploymentRole } from "../common";

const config = new pulumi.Config();
const compartmentId = config.require("compartmentId");
const availabilityDomain = config.require("availabilityDomain");
const repositoryUrl = config.require("repositoryUrl");
const deployRef = process.env.DEPLOY_REF ?? config.get("deployRef") ?? "main";
const sshAuthorizedKey = config.get("sshAuthorizedKey");
const sshAllowedCidr = config.get("sshAllowedCidr");
const sourceArchiveUrl = config.getSecret("sourceArchiveUrl");
const sourceArchiveSha256 = sourceArchiveUrl ? config.require("sourceArchiveSha256") : undefined;
// Fixed shapes/bandwidth prevent an override from silently leaving Always Free.
const shape = "VM.Standard.E2.1.Micro";
const imageId = config.get("amdImageId") ?? oci.core.getImages({
  compartmentId,
  operatingSystem: "Canonical Ubuntu",
  // OCI uses a distinct version label for Minimal; "24.04" excludes it.
  operatingSystemVersion: "24.04 Minimal",
  shape,
  sortBy: "TIMECREATED",
  sortOrder: "DESC",
}).then(({ images }) => {
  const image = images.find(({ displayName }) => displayName?.includes("-Minimal-") && !displayName.includes("-aarch64-"));
  if (!image) throw new Error(`No Ubuntu 24.04 Minimal x86 image found for ${shape}; set amdImageId explicitly.`);
  return image.id;
});
const tags = { project: "alchemyst-devops", managedBy: "pulumi" };

const vcn = new oci.core.Vcn("vcn", {
  compartmentId, cidrBlocks: ["10.10.0.0/16"],
  displayName: "alchemyst-devops-vcn", dnsLabel: "alchemyst", freeformTags: tags,
});
const internetGateway = new oci.core.InternetGateway("internet-gateway", {
  compartmentId, vcnId: vcn.id, enabled: true,
  displayName: "alchemyst-devops-igw", freeformTags: tags,
});
const natGateway = new oci.core.NatGateway("nat-gateway", {
  compartmentId, vcnId: vcn.id, displayName: "alchemyst-devops-nat", freeformTags: tags,
});
const publicRouteTable = new oci.core.RouteTable("public-routes", {
  compartmentId, vcnId: vcn.id, displayName: "alchemyst-devops-public-routes",
  routeRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: internetGateway.id }],
  freeformTags: tags,
});
const privateRouteTable = new oci.core.RouteTable("private-routes", {
  compartmentId, vcnId: vcn.id, displayName: "alchemyst-devops-private-routes",
  routeRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: natGateway.id }],
  freeformTags: tags,
});
const egressOnlySecurityList = new oci.core.SecurityList("egress-only-security-list", {
  compartmentId, vcnId: vcn.id, displayName: "alchemyst-devops-egress-only",
  ingressSecurityRules: [],
  egressSecurityRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", protocol: "all", stateless: false }],
  freeformTags: tags,
});
const publicSubnet = new oci.core.Subnet("public-subnet", {
  compartmentId, vcnId: vcn.id, cidrBlock: "10.10.0.0/24",
  displayName: "alchemyst-devops-public", dnsLabel: "public", prohibitPublicIpOnVnic: false,
  routeTableId: publicRouteTable.id, securityListIds: [egressOnlySecurityList.id], freeformTags: tags,
});
const privateSubnet = new oci.core.Subnet("private-subnet", {
  compartmentId, vcnId: vcn.id, cidrBlock: "10.10.1.0/24",
  displayName: "alchemyst-devops-private", dnsLabel: "private", prohibitPublicIpOnVnic: true,
  routeTableId: privateRouteTable.id, securityListIds: [egressOnlySecurityList.id], freeformTags: tags,
});
const lbNsg = new oci.core.NetworkSecurityGroup("load-balancer-nsg", {
  compartmentId, vcnId: vcn.id, displayName: "alchemyst-devops-load-balancer", freeformTags: tags,
});
const apiNsg = new oci.core.NetworkSecurityGroup("api-nsg", {
  compartmentId, vcnId: vcn.id, displayName: "alchemyst-devops-api", freeformTags: tags,
});
const workerNsg = new oci.core.NetworkSecurityGroup("worker-nsg", {
  compartmentId, vcnId: vcn.id, displayName: "alchemyst-devops-workers", freeformTags: tags,
});
new oci.core.NetworkSecurityGroupSecurityRule("load-balancer-http", {
  networkSecurityGroupId: lbNsg.id, direction: "INGRESS", protocol: "6",
  source: "0.0.0.0/0", sourceType: "CIDR_BLOCK",
  tcpOptions: { destinationPortRange: { min: 80, max: 80 } },
});
new oci.core.NetworkSecurityGroupSecurityRule("api-http", {
  networkSecurityGroupId: apiNsg.id, direction: "INGRESS", protocol: "6",
  source: lbNsg.id, sourceType: "NETWORK_SECURITY_GROUP",
  tcpOptions: { destinationPortRange: { min: 80, max: 80 } },
});
new oci.core.NetworkSecurityGroupSecurityRule("api-rpc", {
  networkSecurityGroupId: apiNsg.id, direction: "INGRESS", protocol: "6",
  source: workerNsg.id, sourceType: "NETWORK_SECURITY_GROUP",
  tcpOptions: { destinationPortRange: { min: 49134, max: 49134 } },
});
if (sshAllowedCidr) {
  // Private administration only: the instances have no public IPs.
  for (const [name, nsg] of [["api", apiNsg], ["inference", workerNsg]] as const) {
    new oci.core.NetworkSecurityGroupSecurityRule(`${name}-ssh`, {
      networkSecurityGroupId: nsg.id, direction: "INGRESS", protocol: "6",
      source: sshAllowedCidr, sourceType: "CIDR_BLOCK",
      tcpOptions: { destinationPortRange: { min: 22, max: 22 } },
    });
  }
}
function createInstance(name: string, privateIp: string, nsg: oci.core.NetworkSecurityGroup, role: DeploymentRole): oci.core.Instance {
  const metadata: Record<string, pulumi.Input<string>> = {
    user_data: sourceArchiveUrl
      ? sourceArchiveUrl.apply((url) => Buffer.from(dockerCloudInit(role, repositoryUrl, deployRef,
        { url, sha256: sourceArchiveSha256! })).toString("base64"))
      : Buffer.from(dockerCloudInit(role, repositoryUrl, deployRef)).toString("base64"),
  };
  if (sshAuthorizedKey) metadata.ssh_authorized_keys = sshAuthorizedKey;
  return new oci.core.Instance(name, {
    availabilityDomain, compartmentId, displayName: `alchemyst-devops-${name}`, shape,
    sourceDetails: { sourceType: "image", sourceId: imageId, bootVolumeSizeInGbs: "50" },
    createVnicDetails: {
      subnetId: privateSubnet.id, privateIp, assignPublicIp: "false", hostnameLabel: name, nsgIds: [nsg.id],
    },
    metadata, preserveBootVolume: false, freeformTags: tags,
  }, {
    // Image/package downloads must wait for working NAT routes, not just the subnet.
    dependsOn: [privateRouteTable, natGateway],
    deleteBeforeReplace: true, replaceOnChanges: ["metadata"],
  });
}
const api = createInstance("api-worker", "10.10.1.11", apiNsg, "api");
const inference = createInstance("inference-worker", "10.10.1.12", workerNsg, "inference");
const loadBalancer = new oci.loadbalancer.LoadBalancer("api-load-balancer", {
  compartmentId, displayName: "alchemyst-devops-api", shape: "flexible",
  shapeDetails: { minimumBandwidthInMbps: 10, maximumBandwidthInMbps: 10 },
  isPrivate: false, subnetIds: [publicSubnet.id], networkSecurityGroupIds: [lbNsg.id], freeformTags: tags,
}, { dependsOn: [internetGateway, publicRouteTable] });
const backendSet = new oci.loadbalancer.BackendSet("api-backend-set", {
  loadBalancerId: loadBalancer.id, name: "api", policy: "ROUND_ROBIN",
  healthChecker: { protocol: "HTTP", port: 80, urlPath: "/health", returnCode: 200 },
});
new oci.loadbalancer.Backend("api-backend", {
  loadBalancerId: loadBalancer.id, backendsetName: backendSet.name,
  ipAddress: api.privateIp, port: 80,
});
new oci.loadbalancer.Listener("api-http-listener", {
  loadBalancerId: loadBalancer.id, name: "http", defaultBackendSetName: backendSet.name,
  port: 80, protocol: "HTTP", connectionConfiguration: { idleTimeoutInSeconds: "240" },
});

export const deployedRef = deployRef;
export const apiIp = loadBalancer.ipAddresses.apply(([ip]) => ip);
export const apiUrl = pulumi.interpolate`http://${apiIp}/v1/chat/completions`;
export const apiPrivateIp = api.privateIp;
export const callerPrivateIp = api.privateIp;
export const inferencePrivateIp = inference.privateIp;
export const apiInstanceId = api.id;
export const inferenceInstanceId = inference.id;
export const vcnId = vcn.id;
export const privateSubnetId = privateSubnet.id;
export const loadBalancerId = loadBalancer.id;
