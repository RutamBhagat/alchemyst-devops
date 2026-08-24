import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const config = new pulumi.Config();
const endpoint = config.get("endpoint") ?? "http://localhost:4566";
const region = config.get("region") ?? "us-east-1";
const gatewayHost = config.get("gatewayHost") ?? "host.docker.internal";

const provider = new aws.Provider("floci", {
  region,
  accessKey: "test",
  secretKey: "test",
  skipCredentialsValidation: true,
  skipMetadataApiCheck: true,
  skipRegionValidation: true,
  skipRequestingAccountId: true,
  endpoints: [{ ecs: endpoint }],
});
const providerOpts: pulumi.CustomResourceOptions = { provider };
const tags = { Project: "alchemyst-devops", ManagedBy: "pulumi", Backend: "floci" };
const cluster = new aws.ecs.Cluster("cluster", {
  name: "alchemyst-devops",
  tags,
}, providerOpts);

const gatewayTask = new aws.ecs.TaskDefinition("gateway-task", {
  family: "alchemyst-gateway",
  networkMode: "bridge",
  containerDefinitions: JSON.stringify([
    {
      name: "iii-engine",
      image: "alchemyst/iii-engine:local",
      essential: true,
      memory: 256,
      cpu: 128,
      portMappings: [{ containerPort: 49134, hostPort: 49134, protocol: "tcp" }],
    },
    {
      name: "gateway-proxy",
      image: "alchemyst/gateway-proxy:local",
      essential: true,
      memory: 64,
      cpu: 32,
      portMappings: [{ containerPort: 80, hostPort: 8080, protocol: "tcp" }],
    },
  ]),
  tags,
}, providerOpts);

const callerTask = new aws.ecs.TaskDefinition("caller-task", {
  family: "alchemyst-caller",
  networkMode: "bridge",
  containerDefinitions: JSON.stringify([{
    name: "caller",
    image: "alchemyst/caller:local",
    essential: true,
    memory: 256,
    cpu: 128,
    environment: [{ name: "III_URL", value: `ws://${gatewayHost}:49134` }],
  }]),
  tags,
}, providerOpts);

const inferenceTask = new aws.ecs.TaskDefinition("inference-task", {
  family: "alchemyst-inference",
  networkMode: "bridge",
  containerDefinitions: JSON.stringify([{
    name: "inference",
    image: "alchemyst/inference:local",
    essential: true,
    memory: 6144,
    cpu: 1024,
    environment: [
      { name: "III_URL", value: `ws://${gatewayHost}:49134` },
      { name: "HF_HOME", value: "/models/huggingface" },
    ],
  }]),
  tags,
}, providerOpts);

const gateway = new aws.ecs.Service("gateway", {
  name: "alchemyst-gateway",
  cluster: cluster.arn,
  taskDefinition: gatewayTask.arn,
  desiredCount: 1,
}, providerOpts);
const caller = new aws.ecs.Service("caller", {
  name: "alchemyst-caller",
  cluster: cluster.arn,
  taskDefinition: callerTask.arn,
  desiredCount: 1,
}, { ...providerOpts, dependsOn: [gateway] });
const inference = new aws.ecs.Service("inference", {
  name: "alchemyst-inference",
  cluster: cluster.arn,
  taskDefinition: inferenceTask.arn,
  desiredCount: 1,
}, { ...providerOpts, dependsOn: [gateway] });

export const clusterArn = cluster.arn;
export const apiUrl = "http://localhost:8080/v1/chat/completions";
export const services = [gateway.name, caller.name, inference.name];
