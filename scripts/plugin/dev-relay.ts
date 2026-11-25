import { createConnection, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Development relay for the E1 disconnect check: forwards loopback TCP from
 * --listen to the local Paseo daemon (--target, default 6767). Point the E1
 * config's daemonUrl at the relay; stopping the relay (Ctrl+C) cuts only the
 * plugin's own connection, starting it again restores it. The daemon is
 * never touched.
 */

const LOOPBACK = "127.0.0.1";

export interface Relay {
  readonly port: number;
  readonly openConnections: number;
  close(): Promise<void>;
}

export async function startRelay(listenPort: number, targetPort: number): Promise<Relay> {
  const pairs = new Set<{ client: Socket; upstream: Socket }>();
  const server: Server = createServer((client) => {
    const upstream = createConnection({ host: LOOPBACK, port: targetPort });
    const pair = { client, upstream };
    pairs.add(pair);
    const teardown = (): void => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", teardown).on("close", teardown);
    upstream.on("error", teardown).on("close", teardown);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("relay did not bind to a TCP port");
  }
  return {
    port: address.port,
    get openConnections() {
      return pairs.size;
    },
    close() {
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      pairs.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function port(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65_535) {
    throw new Error("ports must be whole numbers between 1 and 65535");
  }
  return Number(raw);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { listen: { type: "string" }, target: { type: "string" } },
    strict: true,
  });
  const relay = await startRelay(port(values.listen, 6799), port(values.target, 6767));
  process.stdout.write(
    `relay 127.0.0.1:${relay.port} -> 127.0.0.1:${port(values.target, 6767)}; Ctrl+C cuts it\n`,
  );
  const stop = (): void => {
    void relay.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
