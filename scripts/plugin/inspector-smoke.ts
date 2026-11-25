import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { FakeDocument, FakeSocket, PAGE_IDS } from "./inspector-fakes.ts";

/**
 * Smoke check of the built inspector scripts (C4b), after `plugin:bundle`:
 * loads the bundled ui/connection.js in a VM with a fake document and
 * socket, as connection.html does, and together with workspace.js in the
 * order workspace.html loads them. It proves that the bundle runs without
 * Node, defines connectElgatoStreamDeckSocket only where none exists, and
 * says hello on open; not that a real Stream Deck view renders it.
 */

const UI = new URL("../../local.paseocontrol.e1spike.sdPlugin/ui/", import.meta.url);

interface Page {
  readonly sandbox: Record<string, unknown>;
  readonly doc: FakeDocument;
}

function page(): Page {
  const doc = new FakeDocument(PAGE_IDS);
  const sandbox: Record<string, unknown> = {
    document: doc,
    WebSocket: FakeSocket,
    JSON,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
  };
  sandbox["window"] = sandbox;
  sandbox["globalThis"] = sandbox;
  return { sandbox, doc };
}

function connect(sandbox: Record<string, unknown>, action: string): FakeSocket {
  FakeSocket.instances.length = 0;
  const connectSocket: unknown = sandbox["connectElgatoStreamDeckSocket"];
  if (typeof connectSocket !== "function") throw new Error("no connectElgatoStreamDeckSocket");
  Reflect.apply(connectSocket, undefined, [
    28196,
    "inspector-uuid",
    "registerPropertyInspector",
    "{}",
    JSON.stringify({ action, context: "ctx" }),
  ]);
  if (FakeSocket.instances.length !== 1) throw new Error("expected exactly one socket");
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket");
  socket.open();
  return socket;
}

function hasHello(socket: FakeSocket): boolean {
  return socket
    .payloads()
    .some((payload) => Reflect.get(Object(payload), "type") === "connection_hello");
}

async function main(): Promise<number> {
  const connection = await readFile(new URL("connection.js", UI), "utf8");
  const workspace = await readFile(new URL("workspace.js", UI), "utf8");
  const problems: string[] = [];

  const standalone = page();
  const context = createContext(standalone.sandbox);
  runInContext(connection, context);
  const socket = connect(standalone.sandbox, "local.paseocontrol.e1spike.pages");
  if (!hasHello(socket)) problems.push("standalone page: no hello after open");
  if (standalone.doc.get("connection-status").textContent !== "Waiting for the plugin…") {
    problems.push("standalone page: not waiting for the plugin");
  }

  const combined = page();
  const shared = createContext(combined.sandbox);
  runInContext(workspace, shared);
  const workspaceConnect = combined.sandbox["connectElgatoStreamDeckSocket"];
  runInContext(connection, shared);
  if (combined.sandbox["connectElgatoStreamDeckSocket"] !== workspaceConnect) {
    problems.push("workspace page: connection.js replaced workspace.js's socket");
  }
  const workspaceSocket = connect(combined.sandbox, "local.paseocontrol.e1spike.workspace");
  const types = workspaceSocket
    .payloads()
    .map((payload): unknown => Reflect.get(Object(payload), "type"));
  if (types.join(",") !== "refresh,connection_hello") {
    problems.push(`workspace page: unexpected first messages ${types.join(",")}`);
  }

  for (const problem of problems) process.stdout.write(`PROBLEM: ${problem}\n`);
  process.stdout.write(
    problems.length === 0
      ? "inspector smoke OK (standalone and Workspace)\n"
      : "inspector smoke FAILED\n",
  );
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
