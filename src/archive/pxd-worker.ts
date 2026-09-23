import { decodePxdToWav } from "./pxd.ts";

interface Request {
  id: number;
  bytes: ArrayBuffer;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, bytes } = event.data;
  try {
    const wav = decodePxdToWav(new Uint8Array(bytes));
    self.postMessage({ id, wav: wav.buffer }, { transfer: [wav.buffer] });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : "PXD conversion failed.",
    });
  }
};
