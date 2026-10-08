import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Published/copied source without Git metadata does not need local hooks.
if (existsSync(".git")) {
  const result = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error("Unable to inspect Git hooks configuration.");
  }
  const hooksPath = result.stdout.trim();
  if (hooksPath && hooksPath !== ".githooks") {
    throw new Error(
      `Existing hooksPath ${hooksPath} must be preserved; integrate .githooks/pre-commit before installing.`,
    );
  }
  execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
}
