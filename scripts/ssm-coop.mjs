import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const id =
  process.env.COOP_INSTANCE ??
  execFileSync(
    "aws",
    [
      "ec2",
      "describe-instances",
      "--region",
      "us-west-1",
      "--filters",
      "Name=tag:Name,Values=xwing-coop",
      "Name=instance-state-name,Values=running",
      "--query",
      "Reservations[0].Instances[0].InstanceId",
      "--output",
      "text",
    ],
    { encoding: "utf8" },
  ).trim();
if (!/^i-[a-f0-9]+$/.test(id)) throw Error("No running co-op instance found");
const command = await readFile(process.argv[2], "utf8");
await mkdir("work", { recursive: true });
await writeFile(
  "work/ssm-command.json",
  JSON.stringify({
    commands: [command],
    executionTimeout: [process.env.SSM_TIMEOUT ?? "3600"],
  }),
);
const aws = (args) =>
  execFileSync("aws", [...args, "--region", "us-west-1", "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
const c = JSON.parse(
  aws([
    "ssm",
    "send-command",
    "--document-name",
    "AWS-RunShellScript",
    "--instance-ids",
    id,
    "--parameters",
    "file://work/ssm-command.json",
  ]),
);
const cid = c.Command.CommandId;
console.log(`SSM command ${cid}`);
if (process.env.SSM_ASYNC) {
  await writeFile("work/last-ssm-command", cid);
  process.exit(0);
}
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const r = JSON.parse(
      aws([
        "ssm",
        "get-command-invocation",
        "--command-id",
        cid,
        "--instance-id",
        id,
      ]),
    );
    if (!["Pending", "InProgress", "Delayed"].includes(r.Status)) {
      console.log(r.StandardOutputContent);
      if (r.StandardErrorContent) console.error(r.StandardErrorContent);
      if (r.Status !== "Success") process.exit(1);
      break;
    }
  } catch (error) {
    if (i > 3) throw error;
  }
}
