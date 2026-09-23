import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { settingsFixture } from "./fixtures.ts";

export function localWav(): Buffer {
  const frames = 48000 * 4;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++)
    bytes.writeInt16LE(
      Math.round(Math.sin((frame * Math.PI) / 100) * 12000),
      44 + frame * 2,
    );
  return bytes;
}

export async function localFolderFixture() {
  const root = await mkdtemp(join(tmpdir(), "ravefold-local-test-"));
  const samples = join(root, "samples");
  const settings = join(root, "settings");
  await mkdir(join(samples, "Drums"), { recursive: true });
  await mkdir(settings);
  const audio = localWav();
  await writeFile(join(samples, "Drums", "kick.wav"), audio);
  const savedSettings = settingsFixture();
  savedSettings.appearance.effects = "static";
  await writeFile(
    join(settings, "ravefold-settings.json"),
    JSON.stringify(savedSettings),
  );
  return {
    root,
    samples,
    settings,
    audio,
    async dispose() {
      if (
        dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith("ravefold-local-test-")
      )
        throw new Error("The test folder is outside its temporary root.");
      await rm(root, { recursive: true, force: true });
    },
  };
}
