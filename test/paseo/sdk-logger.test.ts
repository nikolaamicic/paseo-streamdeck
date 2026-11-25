import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSdkLogger,
  paseoClientConfig,
  type SdkLogLevel,
} from "../../src/paseo/sdk-logger.ts";

const MARKER = "SENSITIVE-SENTINEL-5a90";
const SENTINEL_ERROR = new Error(`${MARKER} ws://u:p@127.0.0.1/ws /Users/someone/private`);

describe("createSdkLogger", () => {
  it("reports warn/error levels only and never passes SDK arguments on", () => {
    const reported: SdkLogLevel[] = [];
    const logger = createSdkLogger((level) => reported.push(level));
    logger.debug({ err: SENTINEL_ERROR }, MARKER);
    logger.info({ err: SENTINEL_ERROR }, MARKER);
    logger.warn({ msgType: "x", error: MARKER }, "Message validation failed");
    logger.error({ err: SENTINEL_ERROR }, "Subscription failed");
    assert.deepEqual(reported, ["warn", "error"]);
    assert.equal(JSON.stringify(reported).includes(MARKER), false);
  });
});

describe("paseoClientConfig", () => {
  it("always installs the safe logger, so the SDK never falls back to its console logger", () => {
    const reported: SdkLogLevel[] = [];
    const config = paseoClientConfig("ws://127.0.0.1:6767/ws", (level) => reported.push(level));
    assert.equal(config.url, "ws://127.0.0.1:6767/ws");
    assert.ok(config.logger !== undefined);
    config.logger.error({ err: SENTINEL_ERROR }, MARKER);
    assert.deepEqual(reported, ["error"]);
  });
});
