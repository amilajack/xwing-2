import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Published/copied source without Git metadata does not need local hooks.
if (existsSync(".git")) {
  const result = spawnSync(
    "git",
    ["config", "--show-scope", "--get-all", "core.hooksPath"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error("Unable to inspect Git hooks configuration.");
  }
  // A command-line hooksPath (such as a tool's hook dispatcher, passed through
  // GIT_CONFIG_* variables) outranks the local setting written below, so it
  // can't be clobbered and doesn't need preserving.
  const hooksPath =
    result.stdout
      .split("\n")
      .filter((line) => line && !line.startsWith("command\t"))
      .at(-1)
      ?.split("\t")[1] ?? "";
  if (hooksPath && hooksPath !== ".githooks") {
    throw new Error(
      `Existing hooksPath ${hooksPath} must be preserved; integrate .githooks/pre-commit before installing.`,
    );
  }
  execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
}
