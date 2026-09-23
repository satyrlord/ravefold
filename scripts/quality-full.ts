import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Use npm run quality:full to start the checks.");

for (const script of ["quality:quick", "build"]) {
  const result = spawnSync(process.execPath, [npmCli, "run", script], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const result = spawnSync(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test"],
  { stdio: "inherit", env: { ...process.env, RAVEFOLD_FULL_GATE: "1" } },
);
process.exitCode = result.status ?? 1;
