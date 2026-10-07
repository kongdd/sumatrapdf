import { test, expect } from "bun:test";
import { createServer, createConnection } from "node:net";
import { readExactly } from "./ng-dbg-control";

async function withResponse(bytes: Buffer, check: (socket: ReturnType<typeof createConnection>) => Promise<void>) {
  const server = createServer((socket) => socket.end(bytes));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const socket = createConnection(address.port, "127.0.0.1");
  try {
    await check(socket);
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("reads a complete reply even when the server closes immediately", async () => {
  await withResponse(Buffer.from([1, 2, 3, 4]), async (socket) => {
    expect(await readExactly(socket, 4)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
}, 2000);

test("rejects a truncated reply instead of waiting forever", async () => {
  await withResponse(Buffer.from([1, 2]), async (socket) => {
    await expect(readExactly(socket, 4)).rejects.toThrow("closed before a complete response");
  });
}, 2000);

test("rejects an empty reply instead of waiting forever", async () => {
  await withResponse(Buffer.alloc(0), async (socket) => {
    await expect(readExactly(socket, 4)).rejects.toThrow("closed before a complete response");
  });
}, 2000);
