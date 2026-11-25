import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { after, before, describe, it } from "node:test";
import { startRelay } from "../../scripts/plugin/dev-relay.ts";

// Loopback only: the relay is the subject of this test.
const echo = createServer((socket) => socket.pipe(socket));

function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  return once(socket, "connect").then(() => socket);
}

describe("startRelay", () => {
  let echoPort = 0;
  before(async () => {
    echo.listen(0, "127.0.0.1");
    await once(echo, "listening");
    const address = echo.address();
    assert.ok(address !== null && typeof address !== "string");
    echoPort = (address satisfies AddressInfo).port;
  });
  after(() => {
    echo.close();
  });

  it("forwards traffic and drops every relayed connection on close", async () => {
    const relay = await startRelay(0, echoPort);
    const socket = await connect(relay.port);
    socket.write("ping");
    const received: unknown[] = await once(socket, "data");
    assert.equal(String(received[0]), "ping");
    assert.equal(relay.openConnections, 1);
    const closed = once(socket, "close");
    await relay.close();
    await closed;
    assert.equal(relay.openConnections, 0);
  });
});
