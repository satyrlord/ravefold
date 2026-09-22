import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("Run this gate with npm run quality:quick.");
}

let failed = false;

for (const script of ["lint:md", "format:check"]) {
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

console.log(`Quick quality gate: ${failed ? "failed" : "passed"}`);
process.exitCode = failed ? 1 : 0;
