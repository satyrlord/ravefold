import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { createServer } from "vite";
import { localFolderPlugin } from "../scripts/local-folder-plugin.ts";
import {
  LOCAL_FOLDER_ENDPOINT,
  LOCAL_FOLDER_HEADER,
} from "../shared/local-folder-protocol.ts";
import { localFolderFixture } from "./local-folder-fixture.ts";
import { createLocalFolderProvider } from "../src/storage/local-folders.ts";
import { saveSampleTags, readTags } from "../src/library/tags.ts";

test("local HTTP access requires the page token and same origin and never exposes root paths", async () => {
  const fixture = await localFolderFixture();
  const server = await createServer({
    configFile: false,
    mode: "local-folders",
    plugins: [localFolderPlugin(fixture)],
    server: { host: "0.0.0.0", port: 0 },
    logLevel: "silent",
  });
  try {
    assert.equal(server.config.server.host, "127.0.0.1");
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const html = await (await fetch(origin)).text();
    const token = /name="ravefold-local-token" content="([a-f0-9]+)"/u.exec(
      html,
    )?.[1];
    assert.ok(token);
    assert.ok(!html.includes(fixture.samples));
    assert.ok(!html.includes(fixture.settings));
    const send = (headers: Record<string, string>, body = '{"op":"roots"}') =>
      fetch(origin + LOCAL_FOLDER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });
    assert.equal((await send({})).status, 403);
    assert.equal(
      (
        await send({
          [LOCAL_FOLDER_HEADER]: token,
          Origin: "https://unrelated.example",
        })
      ).status,
      403,
    );
    const untrustedHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          origin,
          { headers: { Host: "unrelated.example" } },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    assert.equal(untrustedHostStatus, 403);
    assert.equal(
      (await send({ [LOCAL_FOLDER_HEADER]: token }, "not-json")).status,
      400,
    );
    const allowed = await send({
      [LOCAL_FOLDER_HEADER]: token,
      Origin: origin,
    });
    assert.equal(allowed.status, 200);
    const text = await allowed.text();
    assert.ok(!text.includes(fixture.samples));
    assert.ok(!text.includes(fixture.settings));
    assert.equal(JSON.parse(text).ok, true);
    const provider = createLocalFolderProvider(token, (input, init) =>
      fetch(new URL(String(input), origin), init),
    );
    const { samples } = await provider.roots();
    assert.ok(samples);
    await saveSampleTags(samples, "Drums/kick.wav", ["http-proof"]);
    const saved = await readTags(samples);
    assert.equal(saved.status, "valid");
    if (saved.status === "valid")
      assert.deepEqual(saved.value.samples["Drums/kick.wav"]?.tags, [
        "http-proof",
      ]);
    const invalid = await (
      await send(
        { [LOCAL_FOLDER_HEADER]: token },
        '{"op":"read","handle":"invalid"}',
      )
    ).json();
    assert.equal(invalid.ok, false);
    assert.ok(!JSON.stringify(invalid).includes(fixture.root));
    assert.equal((await fetch(origin + LOCAL_FOLDER_ENDPOINT)).status, 403);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});
