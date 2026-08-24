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

const gatewayShape = config.get("gatewayShape") ?? "VM.Standard.E2.1.Micro";
const callerShape = config.get("callerShape") ?? "VM.Standard.E2.1.Micro";
const inferenceShape = config.get("inferenceShape") ?? "VM.Standard.A1.Flex";

function latestUbuntuMinimalImage(shape: string, configKey: "amdImageId" | "armImageId"): pulumi.Input<string> {
  return config.get(configKey) ?? oci.core.getImages({
    compartmentId,
    operatingSystem: "Canonical Ubuntu",
    operatingSystemVersion: "24.04",
    shape,
    sortBy: "TIMECREATED",
    sortOrder: "DESC",
  }).then(({ images }) => {
    const image = images.find(({ displayName }) => configKey === "armImageId"
      ? displayName?.includes("-Minimal-aarch64-")
      : displayName?.includes("-Minimal-") && !displayName.includes("-aarch64-"));
    if (!image) {
      throw new Error(`No Canonical Ubuntu 24.04 Minimal OCI image found for ${shape}; set ${configKey} explicitly.`);
    }
    return image.id;
  });
}

const amdImageId = latestUbuntuMinimalImage(gatewayShape, "amdImageId");
const armImageId = latestUbuntuMinimalImage(inferenceShape, "armImageId");

const tags = { project: "alchemyst-devops", managedBy: "pulumi" };

const vcn = new oci.core.Vcn("vcn", {
  compartmentId,
  cidrBlocks: ["10.10.0.0/16"],
  displayName: "alchemyst-devops-vcn",
  dnsLabel: "alchemyst",
  freeformTags: tags,
});

const internetGateway = new oci.core.InternetGateway("internet-gateway", {
  compartmentId,
  vcnId: vcn.id,
  enabled: true,
  displayName: "alchemyst-devops-igw",
  freeformTags: tags,
});

const natGateway = new oci.core.NatGateway("nat-gateway", {
  compartmentId,
  vcnId: vcn.id,
  displayName: "alchemyst-devops-nat",
  freeformTags: tags,
});

const publicRouteTable = new oci.core.RouteTable("public-routes", {
  compartmentId,
  vcnId: vcn.id,
  displayName: "alchemyst-devops-public-routes",
  routeRules: [{
    destination: "0.0.0.0/0",
    destinationType: "CIDR_BLOCK",
    networkEntityId: internetGateway.id,
  }],
  freeformTags: tags,
});

const privateRouteTable = new oci.core.RouteTable("private-routes", {
  compartmentId,
  vcnId: vcn.id,
  displayName: "alchemyst-devops-private-routes",
  routeRules: [{
    destination: "0.0.0.0/0",
    destinationType: "CIDR_BLOCK",
    networkEntityId: natGateway.id,
  }],
  freeformTags: tags,
});

const egressOnlySecurityList = new oci.core.SecurityList("egress-only-security-list", {
  compartmentId,
  vcnId: vcn.id,
  displayName: "alchemyst-devops-egress-only",
  ingressSecurityRules: [],
  egressSecurityRules: [{
    destination: "0.0.0.0/0",
    destinationType: "CIDR_BLOCK",
    protocol: "all",
    stateless: false,
  }],
  freeformTags: tags,
});

const publicSubnet = new oci.core.Subnet("public-subnet", {
  compartmentId,
  vcnId: vcn.id,
  cidrBlock: "10.10.0.0/24",
  displayName: "alchemyst-devops-public",
  dnsLabel: "public",
  prohibitPublicIpOnVnic: false,
  routeTableId: publicRouteTable.id,
  securityListIds: [egressOnlySecurityList.id],
  freeformTags: tags,
});

const privateSubnet = new oci.core.Subnet("private-subnet", {
  compartmentId,
  vcnId: vcn.id,
  cidrBlock: "10.10.1.0/24",
  displayName: "alchemyst-devops-private",
  dnsLabel: "private",
  prohibitPublicIpOnVnic: true,
  routeTableId: privateRouteTable.id,
  securityListIds: [egressOnlySecurityList.id],
  freeformTags: tags,
});

const gatewayNsg = new oci.core.NetworkSecurityGroup("gateway-nsg", {
  compartmentId,
  vcnId: vcn.id,
  displayName: "alchemyst-devops-gateway",
  freeformTags: tags,
});

const workerNsg = new oci.core.NetworkSecurityGroup("worker-nsg", {
  compartmentId,
  vcnId: vcn.id,
  displayName: "alchemyst-devops-workers",
  freeformTags: tags,
});

new oci.core.NetworkSecurityGroupSecurityRule("gateway-http", {
  networkSecurityGroupId: gatewayNsg.id,
  direction: "INGRESS",
  protocol: "6",
  source: "0.0.0.0/0",
  sourceType: "CIDR_BLOCK",
  tcpOptions: { destinationPortRange: { min: 80, max: 80 } },
});

new oci.core.NetworkSecurityGroupSecurityRule("gateway-rpc", {
  networkSecurityGroupId: gatewayNsg.id,
  direction: "INGRESS",
  protocol: "6",
  source: workerNsg.id,
  sourceType: "NETWORK_SECURITY_GROUP",
  tcpOptions: { destinationPortRange: { min: 49134, max: 49134 } },
});

if (sshAllowedCidr) {
  new oci.core.NetworkSecurityGroupSecurityRule("gateway-ssh", {
    networkSecurityGroupId: gatewayNsg.id,
    direction: "INGRESS",
    protocol: "6",
    source: sshAllowedCidr,
    sourceType: "CIDR_BLOCK",
    tcpOptions: { destinationPortRange: { min: 22, max: 22 } },
  });
}

function shapeConfig(shape: string, memoryInGbs: number): oci.types.input.Core.InstanceShapeConfig | undefined {
  return shape.endsWith(".Flex") ? { ocpus: 1, memoryInGbs } : undefined;
}

function createInstance(args: {
  name: string;
  hostname: string;
  subnetId: pulumi.Input<string>;
  privateIp: string;
  publicIp: boolean;
  nsgIds: pulumi.Input<string>[];
  shape: string;
  memoryInGbs: number;
  imageId: pulumi.Input<string>;
  role: DeploymentRole;
}, opts?: pulumi.CustomResourceOptions): oci.core.Instance {
  const metadata: Record<string, pulumi.Input<string>> = {
    user_data: Buffer.from(dockerCloudInit(args.role, repositoryUrl, deployRef)).toString("base64"),
  };
  if (sshAuthorizedKey) metadata.ssh_authorized_keys = sshAuthorizedKey;

  return new oci.core.Instance(args.name, {
    availabilityDomain,
    compartmentId,
    displayName: `alchemyst-devops-${args.name}`,
    shape: args.shape,
    shapeConfig: shapeConfig(args.shape, args.memoryInGbs),
    sourceDetails: { sourceType: "image", sourceId: args.imageId },
    createVnicDetails: {
      subnetId: args.subnetId,
      privateIp: args.privateIp,
      assignPublicIp: args.publicIp ? "true" : "false",
      hostnameLabel: args.hostname,
      nsgIds: args.nsgIds,
    },
    metadata,
    preserveBootVolume: false,
    freeformTags: tags,
  }, { ...opts, deleteBeforeReplace: true, replaceOnChanges: ["metadata"] });
}

const gateway = createInstance({
  name: "api-gateway",
  hostname: "api-gateway",
  subnetId: publicSubnet.id,
  privateIp: "10.10.0.10",
  publicIp: true,
  nsgIds: [gatewayNsg.id],
  shape: gatewayShape,
  memoryInGbs: 1,
  imageId: amdImageId,
  role: "gateway",
});

const caller = createInstance({
  name: "caller-worker",
  hostname: "caller-worker",
  subnetId: privateSubnet.id,
  privateIp: "10.10.1.11",
  publicIp: false,
  nsgIds: [workerNsg.id],
  shape: callerShape,
  memoryInGbs: 1,
  imageId: amdImageId,
  role: "caller",
}, { dependsOn: [gateway] });

const inference = createInstance({
  name: "inference-worker",
  hostname: "inference-worker",
  subnetId: privateSubnet.id,
  privateIp: "10.10.1.12",
  publicIp: false,
  nsgIds: [workerNsg.id],
  shape: inferenceShape,
  memoryInGbs: 6,
  imageId: armImageId,
  role: "inference",
}, { dependsOn: [gateway] });

export const deployedRef = deployRef;
export const apiIp = gateway.publicIp;
export const apiUrl = pulumi.interpolate`http://${gateway.publicIp}/v1/chat/completions`;
export const gatewayPrivateIp = gateway.privateIp;
export const callerPrivateIp = caller.privateIp;
export const inferencePrivateIp = inference.privateIp;
