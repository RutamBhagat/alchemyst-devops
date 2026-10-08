export type DeploymentRole = "api" | "gateway" | "caller" | "inference";

const composeFiles: Record<DeploymentRole, string> = {
  api: "api.compose.yaml",
  gateway: "gateway.compose.yaml",
  caller: "caller.compose.yaml",
  inference: "inference.compose.yaml",
};

export function dockerCloudInit(role: DeploymentRole, repositoryUrl: string, deployRef: string,
  archive?: { url: string; sha256: string }): string {
  const repoDir = "/opt/devops-assignment";
  const composeFile = `${repoDir}/deploy/docker/${composeFiles[role]}`;
  if (archive && !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error("sourceArchiveSha256 must be a SHA-256 digest");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const build = ["timeout", "1200", "docker", "compose", "-f", composeFile, "up", "-d", "--build"];
  const sourceCommands = archive ? [["bash", "-ec", [
    `curl --fail --silent --show-error --location --retry 3 ${quote(archive.url)} -o /tmp/source.tar.gz`,
    `echo '${archive.sha256}  /tmp/source.tar.gz' | sha256sum -c -`,
    `mkdir -p ${repoDir}`,
    `tar -xzf /tmp/source.tar.gz -C ${repoDir}`,
    "rm /tmp/source.tar.gz",
    `echo 'SOURCE_SHA256=${archive.sha256}'`,
    build.map(quote).join(" "),
  ].join("\n")]] : [
    ["git", "clone", repositoryUrl, repoDir],
    ["git", "-C", repoDir, "checkout", "--detach", deployRef],
  ];
  const commands = [
    ["systemctl", "enable", "--now", "docker"],
    ...sourceCommands,
    ...(archive ? [] : [build]),
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
    "  - curl",
    "  - docker.io",
    "  - docker-compose-v2",
    "runcmd:",
    ...commands.map((command) => `  - ${JSON.stringify(command)}`),
    "",
  ].join("\n");
}
