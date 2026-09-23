import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import {
  parseSourceManifest,
  SOURCE_MANIFEST_FILENAME,
  validateSourceManifest,
  type SourceManifest,
} from "../src/domain/source-manifest.ts";
import { validateSamplePath } from "../src/domain/project.ts";
import { validateWav, type WavInfo } from "../src/domain/wav.ts";

interface MetadataRow {
  filename: string;
  duration_sec?: number;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
}

interface MetadataIndex {
  rows: Map<string, MetadataRow>;
  format: Record<string, unknown> | null;
}

export interface RegistrationResult {
  files: number;
  bytes: number;
  dryRun: boolean;
  created: boolean;
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Sample metadata has an invalid structure.");
  return value as Record<string, unknown>;
}

function metadataNumber(
  value: unknown,
  label: string,
  integer = false,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(`Sample metadata has an invalid ${label}.`);
  return value;
}

async function readMetadata(root: string): Promise<MetadataIndex> {
  let source: string;
  try {
    source = await readFile(join(root, "metadata.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("The sample folder needs metadata.json.");
    throw error;
  }
  const data = fields(JSON.parse(source) as unknown);
  const origin = data.source;
  if (!(
    (typeof origin === "string" && origin.trim()) ||
    (Array.isArray(origin) &&
      origin.length > 0 &&
      origin.every((value) => typeof value === "string" && value.trim()))
  ))
    throw new Error("Sample metadata needs a source identifier.");
  if (!Array.isArray(data.samples))
    throw new Error("Sample metadata has no sample list.");
  const count = metadataNumber(data.total_samples, "sample count", true);
  if (count !== undefined && count !== data.samples.length)
    throw new Error("The sample metadata count does not match its list.");
  const rows = new Map<string, MetadataRow>();
  for (const item of data.samples) {
    const row = fields(item);
    if (
      typeof row.filename !== "string" ||
      !/^[^\\/]+\.wav$/iu.test(row.filename) ||
      row.filename === "." ||
      row.filename === ".."
    )
      throw new Error("Sample metadata has an invalid WAV name.");
    const key = row.filename.toLowerCase();
    if (rows.has(key))
      throw new Error("Sample metadata has duplicate WAV names.");
    rows.set(key, {
      filename: row.filename,
      duration_sec: metadataNumber(row.duration_sec, "duration"),
      sample_rate: metadataNumber(row.sample_rate, "sample rate", true),
      bit_depth: metadataNumber(row.bit_depth, "bit depth", true),
      channels: metadataNumber(row.channels, "channel count", true),
    });
  }
  return {
    rows,
    format: data.format === undefined ? null : fields(data.format),
  };
}

async function wavFiles(
  root: string,
): Promise<Array<{ full: string; path: string }>> {
  const found: Array<{ full: string; path: string }> = [];
  async function visit(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("The sample folder cannot contain symbolic links.");
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /\.wav$/iu.test(entry.name)) {
        const path = validateSamplePath(
          relative(root, full).split(sep).join("/"),
        );
        found.push({ full, path });
      }
    }
  }
  await visit(root);
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function checkMetadata(
  info: WavInfo,
  metadata: MetadataIndex,
  row: MetadataRow | undefined,
): void {
  if (!row) throw new Error("A WAV file has no metadata record.");
  const bitDepth =
    info.encoding === "pcm16" ? 16 : info.encoding === "pcm24" ? 24 : 32;
  if (
    row &&
    ((row.duration_sec !== undefined &&
      Math.abs(row.duration_sec - info.duration) > 0.0001 + 1e-9) ||
      (row.sample_rate !== undefined && row.sample_rate !== info.sampleRate) ||
      (row.bit_depth !== undefined && row.bit_depth !== bitDepth) ||
      (row.channels !== undefined && row.channels !== info.channels))
  )
    throw new Error("A WAV file does not match its metadata.");
  if (
    metadata.format &&
    ((metadata.format.sample_rate !== undefined &&
      metadata.format.sample_rate !== info.sampleRate) ||
      (metadata.format.bit_depth !== undefined &&
        metadata.format.bit_depth !== bitDepth) ||
      (metadata.format.channels !== undefined &&
        metadata.format.channels !== info.channels))
  )
    throw new Error("A WAV file does not match the collection format.");
}

async function existingText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function publishNew(path: string, text: string): Promise<boolean> {
  const old = await existingText(path);
  if (old !== null) {
    if (old === text) return false;
    throw new Error(
      "An existing source manifest is different. Keep it unchanged.",
    );
  }
  const temporary = join(
    dirname(path),
    `.ravefold-sources-${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if ((await existingText(path)) === text) return false;
        throw new Error(
          "An existing source manifest is different. Keep it unchanged.",
        );
      }
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Build a local user attestation. This does not prove historical OG origin. */
export async function registerLocalSource(
  selectedFolder: string,
  options: { dryRun?: boolean } = {},
): Promise<RegistrationResult> {
  const root = await realpath(selectedFolder);
  const stat = await lstat(root);
  if (!stat.isDirectory()) throw new Error("The sample folder is invalid.");
  const files = await wavFiles(root);
  if (files.length === 0)
    throw new Error("The sample folder has no WAV files.");
  const metadata = await readMetadata(root);
  if (metadata.rows.size !== files.length)
    throw new Error("The WAV and metadata counts do not match.");
  const sources: SourceManifest["sources"] = {};
  const seenNames = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const name = basename(file.path).toLowerCase();
    if (seenNames.has(name))
      throw new Error("Metadata cannot identify duplicate WAV names.");
    seenNames.add(name);
    const bytes = await readFile(file.full);
    const validation = await validateWav(new Blob([bytes]));
    if (!validation.valid) throw new Error("A source WAV file is invalid.");
    checkMetadata(validation.info, metadata, metadata.rows.get(name));
    const hash = createHash("sha256").update(bytes).digest("hex");
    sources[file.path] = {
      sha256: hash,
      bytes: bytes.byteLength,
      declared: { bpm: 180, key: "C minor" },
      provenance: "user-attested-og",
    };
    totalBytes += bytes.byteLength;
  }
  const manifest = validateSourceManifest({
    schemaVersion: 1,
    revision: 0,
    sources,
  });
  const text = JSON.stringify(manifest, null, 2) + "\n";
  parseSourceManifest(text);
  const destination = join(root, SOURCE_MANIFEST_FILENAME);
  const old = await existingText(destination);
  if (old !== null && old !== text)
    throw new Error(
      "An existing source manifest is different. Keep it unchanged.",
    );
  if (options.dryRun)
    return {
      files: files.length,
      bytes: totalBytes,
      dryRun: true,
      created: false,
    };
  const created = await publishNew(destination, text);
  return { files: files.length, bytes: totalBytes, dryRun: false, created };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run"))
    throw new Error("Use only the optional --dry-run argument.");
  const values = parseEnv(
    await readFile(new URL("../.env.local", import.meta.url), "utf8"),
  );
  if (!values.SAMPLES_DIR) throw new Error("Set SAMPLES_DIR in .env.local.");
  const result = await registerLocalSource(values.SAMPLES_DIR, {
    dryRun: args[0] === "--dry-run",
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch(() => {
    process.stderr.write(
      "Source registration failed. Check the sample folder and metadata.\n",
    );
    process.exitCode = 1;
  });
