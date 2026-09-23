import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
  LOCAL_FOLDER_ENDPOINT,
  LOCAL_FOLDER_HEADER,
  type LocalRequest,
  type LocalResponse,
} from "../shared/local-folder-protocol.ts";
import { LocalFolderHost } from "./local-folder-host.ts";

export interface LocalFolderPaths {
  samples: string;
  settings: string;
}

async function configuredPaths(root: string): Promise<LocalFolderPaths> {
  let values: Record<string, string | undefined>;
  try {
    values = parseEnv(await readFile(resolve(root, ".env.local"), "utf8"));
  } catch {
    throw new Error("Local folder mode requires .env.local.");
  }
  if (!values.SAMPLES_DIR || !values.SETTINGS_DIR)
    throw new Error("Set SAMPLES_DIR and SETTINGS_DIR in .env.local.");
  return { samples: values.SAMPLES_DIR, settings: values.SETTINGS_DIR };
}

function reply(response: ServerResponse, status: number, body: LocalResponse) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function failure(response: ServerResponse, status: number, message: string) {
  reply(response, status, {
    ok: false,
    error: { name: "NotAllowedError", message },
  });
}

async function readRequest(request: IncomingMessage): Promise<LocalRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 384 * 1024) throw new Error("The request is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as LocalRequest;
}

/** The endpoints exist only in the explicitly selected local development mode. */
export function localFolderPlugin(paths?: LocalFolderPaths): Plugin {
  const token = randomBytes(32).toString("hex");
  let host: LocalFolderHost | undefined;
  return {
    name: "ravefold-local-folders",
    apply: "serve",
    config(config) {
      // Command-line options must not expose the file host to the network.
      config.server = {
        ...config.server,
        host: "127.0.0.1",
        cors: false,
        allowedHosts: ["localhost"],
      };
    },
    async configureServer(server) {
      const selected = paths ?? (await configuredPaths(server.config.root));
      try {
        host = await LocalFolderHost.create(selected);
      } catch {
        throw new Error(
          "Local folders are unavailable or overlap. Check .env.local.",
        );
      }
      server.middlewares.use((request, response, next) => {
        const port = request.socket.localPort;
        const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        const authority = request.headers.host;
        if (!authority || !allowedHosts.includes(authority)) {
          failure(response, 403, "This server accepts local requests only.");
          return;
        }
        if (request.url?.split("?")[0] !== LOCAL_FOLDER_ENDPOINT) {
          next();
          return;
        }
        const origin = request.headers.origin;
        if (
          request.method !== "POST" ||
          request.headers[LOCAL_FOLDER_HEADER] !== token ||
          request.headers["content-type"] !== "application/json" ||
          (origin !== undefined && origin !== `http://${authority}`)
        ) {
          failure(
            response,
            403,
            "Local folder access is unavailable. Reload the page.",
          );
          return;
        }
        void (async () => {
          let input: LocalRequest;
          try {
            input = await readRequest(request);
          } catch {
            failure(response, 400, "The local folder request is invalid.");
            return;
          }
          try {
            const value = await host!.dispatch(input);
            reply(response, 200, { ok: true, value });
          } catch (error) {
            const safe = error instanceof DOMException;
            reply(response, 200, {
              ok: false,
              error: {
                name: safe ? error.name : "NotReadableError",
                message: safe
                  ? error.message
                  : "The local folder operation failed.",
              },
            });
          }
        })();
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { name: "ravefold-local-token", content: token },
          injectTo: "head",
        },
      ];
    },
    async closeBundle() {
      await host?.dispose();
    },
  };
}
