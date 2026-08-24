export type DeploymentRole = "gateway" | "caller" | "inference";

const composeFiles: Record<DeploymentRole, string> = {
  gateway: "gateway.compose.yaml",
  caller: "caller.compose.yaml",
  inference: "inference.compose.yaml",
};

export function dockerCloudInit(role: DeploymentRole, repositoryUrl: string, deployRef: string): string {
  const repoDir = "/opt/devops-assignment";
  const composeFile = `${repoDir}/deploy/docker/${composeFiles[role]}`;
  const commands = [
    ["git", "clone", repositoryUrl, repoDir],
    ["git", "-C", repoDir, "checkout", "--detach", deployRef],
    ["docker", "compose", "-f", composeFile, "up", "-d", "--build"],
  ];

  return [
    "#cloud-config",
    "package_update: true",
    "packages:",
    "  - git",
    "  - docker.io",
    "  - docker-compose-v2",
    "runcmd:",
    ...commands.map((command) => `  - ${JSON.stringify(command)}`),
    "",
  ].join("\n");
}
