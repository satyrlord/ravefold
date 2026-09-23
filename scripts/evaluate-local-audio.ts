import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { analyzeAudio } from "../src/audio/analyze.ts";
import { decodeWav } from "../src/audio/pcm.ts";
import {
  parseSourceManifest,
  SOURCE_MANIFEST_FILENAME,
  type SourceManifest,
} from "../src/domain/source-manifest.ts";

process.loadEnvFile(".env.local");
const root = process.env.SAMPLES_DIR;
if (!root) throw new Error("Configure SAMPLES_DIR in .env.local first.");
const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 &&
    !/^--min-ready-percent=(?:100|\d{1,2}(?:\.\d+)?)$/u.test(arguments_[0]!))
)
  throw new Error("Use only --min-ready-percent=<0-100>.");
const minimumReady = arguments_.length
  ? Number(arguments_[0]!.split("=")[1])
  : undefined;
if (minimumReady !== undefined && minimumReady > 100)
  throw new Error("The minimum ready percentage cannot exceed 100.");

let sourceManifest: SourceManifest | undefined;
try {
  sourceManifest = parseSourceManifest(
    await readFile(join(root, SOURCE_MANIFEST_FILENAME), "utf8"),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error("The sample source manifest cannot be read.");
}

async function wavFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await wavFiles(path)));
    else if (entry.isFile() && /\.wav$/iu.test(entry.name)) paths.push(path);
  }
  return paths.sort();
}

const statuses: Record<string, number> = {};
const kinds: Record<string, number> = {};
const reasons: Record<string, number> = {};
let bytes = 0;
let failures = 0;
let count = 0;
let verifiedClaims = 0;
const started = performance.now();

try {
  for (const path of await wavFiles(root)) {
    try {
      const source = await readFile(path);
      bytes += source.byteLength;
      const audio = await decodeWav(new Blob([source]));
      const relativePath = relative(root, path).split(sep).join("/");
      const record = sourceManifest?.sources[relativePath];
      const verified =
        record?.bytes === source.byteLength &&
        record.sha256 === createHash("sha256").update(source).digest("hex");
      if (verified) verifiedClaims++;
      const result = analyzeAudio(
        audio,
        verified ? { verifiedOfficialSource: true } : undefined,
      );
      statuses[result.status] = (statuses[result.status] ?? 0) + 1;
      kinds[result.measured.sampleKind] =
        (kinds[result.measured.sampleKind] ?? 0) + 1;
      for (const reason of result.reasons)
        reasons[reason] = (reasons[reason] ?? 0) + 1;
    } catch {
      failures++;
    }
    count++;
  }
} catch {
  throw new Error("The configured sample folder cannot be read.");
}

const ready = statuses.ready ?? 0;
const readyPercent = count ? Math.round((ready / count) * 10_000) / 100 : 0;
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    method: "Sequential WAV decode and analysis with exact-hash source checks",
    files: count,
    bytes,
    elapsedMs: Math.round(performance.now() - started),
    ready,
    readyPercent,
    coverageOnly: true,
    verifiedClaims,
    statuses,
    kinds,
    reasons,
    failures,
  }),
);
if (
  minimumReady !== undefined &&
  (readyPercent < minimumReady || failures !== 0 || verifiedClaims !== count)
)
  process.exitCode = 1;
