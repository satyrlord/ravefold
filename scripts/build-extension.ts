import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

const extensionRoot = resolve("extensions/ravefold");
for (const name of ["out", "web"]) {
  const target = resolve(extensionRoot, name);
  const inside = relative(extensionRoot, target);
  if (inside.startsWith("..") || isAbsolute(inside) || inside === "")
    throw new Error("The build target is outside the extension.");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}
await build({
  entryPoints: ["extensions/ravefold/src/extension.ts"],
  outfile: "extensions/ravefold/out/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  legalComments: "eof",
});
await cp(resolve("dist"), resolve(extensionRoot, "web"), { recursive: true });
console.log("Extension files built.");
