import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("Use npm run quality:quick to start the checks.");
}

let failed = false;

for (const script of [
  "typecheck",
  "test:unit",
  "lint:md",
  "format:check",
] as const) {
  const result = spawnSync(process.execPath, [npmCli, "run", script], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`${script}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    failed = true;
  }
}

console.log(failed ? "Checks failed." : "Checks passed.");
process.exitCode = failed ? 1 : 0;
