import { harness } from "./state.ts";

/**
 * Stand-in for the parts of @elgato/streamdeck 3.0.4 that plugin.ts uses at
 * runtime (the real types still check plugin.ts in `npm run typecheck`).
 * Nothing here connects, logs to a file or registers process handlers.
 */

// plugin.ts's action classes extend it; the fake base needs no members.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- see above
export class SingletonAction {}

const streamDeck = {
  logger: {
    setLevel: (level: string): void => {
      harness.events.push(`logger.setLevel:${level}`);
    },
    info: (message: string): void => {
      harness.events.push(`log.info:${message}`);
    },
    warn: (message: string): void => {
      harness.events.push(`log.warn:${message}`);
    },
    error: (message: string): void => {
      harness.events.push(`log.error:${message}`);
    },
  },
  actions: {
    registerAction: (action: object): void => {
      const id: unknown = Reflect.get(action, "manifestId");
      harness.events.push(`register:${String(id)}`);
      harness.registered.push(action);
    },
  },
  connect: (): Promise<void> => {
    harness.events.push("connect");
    return Promise.resolve();
  },
  settings: {
    getGlobalSettings: (): Promise<unknown> => {
      harness.events.push("settings.getGlobalSettings");
      return Promise.resolve(harness.settings.answer);
    },
    // A method, not an arrow: the check sees the `this` plugin.ts calls it with.
    setGlobalSettings(this: unknown, settings: unknown): Promise<void> {
      harness.events.push("settings.setGlobalSettings");
      harness.settings.writes.push({ self: this, settings });
      const failure = harness.settings.refuseNextWrite;
      harness.settings.refuseNextWrite = null;
      return failure === null ? Promise.resolve() : Promise.reject(failure);
    },
    onDidReceiveGlobalSettings: (listener: (ev: { readonly settings: unknown }) => void) => {
      harness.events.push("settings.onDidReceiveGlobalSettings");
      harness.settings.listeners.push(listener);
      return {
        [Symbol.dispose]: (): void => {
          harness.events.push("settings.dispose");
          const index = harness.settings.listeners.indexOf(listener);
          if (index >= 0) harness.settings.listeners.splice(index, 1);
        },
      };
    },
  },
  ui: {
    get action(): { readonly id: string } | null {
      return harness.uiAction;
    },
    sendToPropertyInspector: (payload: unknown): Promise<void> => {
      harness.inspector.push(payload);
      return Promise.resolve();
    },
  },
};

export default streamDeck;
