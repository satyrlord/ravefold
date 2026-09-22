import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listFiles } from "@vscode/vsce";

const root = resolve("extensions/ravefold");
const manifest: unknown = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
if (
  !manifest ||
  typeof manifest !== "object" ||
  !("version" in manifest) ||
  typeof manifest.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    manifest.version,
  )
)
  throw new Error("The extension package version is invalid.");
const files = await listFiles({ cwd: root, packagedDependencies: [] });
const allowed =
  /^(package\.json|README\.md|out\/extension\.cjs|web\/index\.html|web\/[a-z-]*license\.txt|web\/third-party-notices\.txt|web\/assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2))$/;
let local = "";
try {
  local = await readFile(".env.local", "utf8");
} catch {
  /* Local inputs are optional. */
}
const privateValues = ["OG_INSTALL_DIR", "SAMPLES_DIR"]
  .map((key) => {
    const line = local
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${key}=`));
    return (
      line
        ?.slice(key.length + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "") ?? ""
    );
  })
  .filter(Boolean);
for (const file of files) {
  const name = file.replaceAll("\\", "/");
  if (!allowed.test(name))
    throw new Error("The extension package contains an unexpected file.");
  const contents = await readFile(resolve(root, file));
  if (privateValues.some((value) => contents.includes(Buffer.from(value))))
    throw new Error("The extension package contains a private path value.");
}
console.log("Extension package file and privacy checks passed.");
await mkdir("artifacts", { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    resolve("node_modules/@vscode/vsce/vsce"),
    "package",
    "--no-dependencies",
    "--allow-missing-repository",
    "--skip-license",
    "--out",
    resolve(`artifacts/ravefold-${manifest.version}.vsix`),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
