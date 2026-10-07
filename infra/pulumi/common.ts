export type DeploymentRole = "api" | "gateway" | "caller" | "inference";

const composeFiles: Record<DeploymentRole, string> = {
  api: "api.compose.yaml",
  gateway: "gateway.compose.yaml",
  caller: "caller.compose.yaml",
  inference: "inference.compose.yaml",
};

export function dockerCloudInit(role: DeploymentRole, repositoryUrl: string, deployRef: string): string {
  const repoDir = "/opt/devops-assignment";
  const composeFile = `${repoDir}/deploy/docker/${composeFiles[role]}`;
  const commands = [
    ["systemctl", "enable", "--now", "docker"],
    ["git", "clone", repositoryUrl, repoDir],
    ["git", "-C", repoDir, "checkout", "--detach", deployRef],
    ["docker", "compose", "-f", composeFile, "up", "-d", "--build"],
  ];

  return [
    "#cloud-config",
    "package_update: true",
    // Builds can exceed free RAM even though the quantized service fits.
    "swap:",
    "  filename: /swapfile",
    "  size: 2147483648",
    "  maxsize: 2147483648",
    "packages:",
    "  - git",
    "  - docker.io",
    "  - docker-compose-v2",
    "runcmd:",
    ...commands.map((command) => `  - ${JSON.stringify(command)}`),
    "",
  ].join("\n");
}
