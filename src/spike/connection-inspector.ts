import type { SaveOutcome } from "../connection/connection-saver.ts";
import type {
  AddressError,
  ConnectionBlock,
  ConnectionSource,
  SavedConnectionError,
} from "../connection/connection-model.ts";
import {
  isSessionId,
  parsePageMessage,
  type ConnectionStatusView,
  type PageMessage,
  type PluginMessage,
  type RequestKind,
  type SaveAddressError,
  type SaveOutcomeKind,
  type StatusBlockReason,
  type StatusLink,
  type StatusSavedError,
  type StatusSavedKind,
  type StatusSource,
  type StatusViewKind,
  type StatusSettingsRead,
} from "../inspector/connection-protocol.ts";
import type { ReadStatus } from "../connection/settings-reader.ts";
import type { ConnectionFacts } from "./feed-lifecycle.ts";

/**
 * The plugin side of the connection inspector protocol v2 (C4a4a).
 * Every action's Property Inspector may
 * bind to its own inspector opening and then ask for the status or send a
 * Save; the page itself never writes global settings.
 *
 * Per context, one generation per SDK appearance (didAppear to
 * didDisappear; a second appearance also starts a new one). A generation
 * has one challenge and binds at most once, to the first valid confirm of
 * (page nonce, challenge); a later hello or confirm never rebinds it. Only
 * the bound (page nonce, challenge) may ask for the status or Save. Every
 * answer carries them, and `seq` orders one binding's answers.
 *
 * Boundary: a send is gated before the hand-over to the SDK; a packet
 * already handed over cannot be recalled. The page discards packets of
 * another binding (connection-protocol.ts receivePage). Logs are fixed
 * codes only: never addresses, nonces, payloads or raw errors.
 */

export function connectionStatusView(facts: ConnectionFacts): ConnectionStatusView {
  const { view, requested, saved } = facts;
  return {
    view: view.kind,
    blockedReason: view.kind === "blocked" ? view.reason : null,
    active: view.kind === "active" ? { daemonUrl: view.daemonUrl, source: view.source } : null,
    requested:
      requested.kind === "connect"
        ? { kind: "connect", daemonUrl: requested.daemonUrl, reason: null }
        : requested.kind === "blocked"
          ? { kind: "blocked", daemonUrl: null, reason: requested.reason }
          : { kind: "loading", daemonUrl: null, reason: null },
    saved:
      saved.kind === "ok"
        ? { kind: "ok", daemonUrl: saved.daemonUrl, error: null }
        : saved.kind === "invalid"
          ? { kind: "invalid", daemonUrl: null, error: saved.error }
          : { kind: saved.kind, daemonUrl: null, error: null },
    sent: facts.sent,
    sending: facts.sending,
    link: facts.link,
    settingsRead: facts.settingsRead,
  };
}

/*
 * Compile-time: the page's status domains are exactly the producer's, in
 * both directions, so a new code on either side fails the typecheck
 * instead of drifting (a page would otherwise drop or misread it).
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type DomainsMatch = [
  Same<ConnectionFacts["view"]["kind"], StatusViewKind>,
  Same<ConnectionSource, StatusSource>,
  Same<ConnectionFacts["link"], StatusLink>,
  Same<ConnectionBlock, StatusBlockReason>,
  Same<ConnectionFacts["saved"]["kind"], StatusSavedKind>,
  Same<SavedConnectionError, StatusSavedError>,
  Same<SaveOutcome["kind"], SaveOutcomeKind>,
  Same<AddressError, SaveAddressError>,
  Same<ReadStatus, StatusSettingsRead>,
];
/** Exported only so the compile-time check above is not unused. */
export const STATUS_DOMAINS_MATCH: DomainsMatch = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

export interface ConnectionInspectorsDeps {
  /** The runtime's connection Save; the only path to a write. */
  readonly save: (daemonUrl: unknown) => Promise<SaveOutcome>;
  /** A fresh snapshot of the connection facts; reads nothing. */
  readonly status: () => ConnectionFacts;
  /** Delivers a message to the inspector of `context` only if it is open. */
  readonly send: (context: string, message: PluginMessage) => Promise<void>;
  /**
   * Reads the global settings again (lifecycle.refreshSettings, through the
   * one reader). Called once per generation, when it binds.
   */
  readonly refreshSettings: () => void;
  /** A new challenge (crypto.randomUUID in plugin.ts); not a secret. */
  readonly newChallenge: () => string;
  /** Fixed codes only. */
  readonly log: (code: string) => void;
}

/** The binding of a generation: one page nonce, its own seq and status cache. */
interface Binding {
  readonly pageNonce: string;
  seq: number;
  /**
   * The newest status handed to the SDK (its JSON and seq), while that send
   * has not failed: an unchanged push is skipped. A failed send clears it
   * only if it is still the newest, so the next refresh or status request
   * sends again; no retry loop.
   */
  status: { readonly text: string; readonly seq: number } | null;
}

/** One inspector opening of one context. */
interface Generation {
  readonly challenge: string;
  binding: Binding | null;
}

type BoundMessage = Extract<
  PluginMessage,
  { readonly type: "connection_bound" | "connection_status" | "connection_save_result" }
>;

/** A bound message without the fields this controller fills in. */
type BoundDraft = BoundMessage extends infer M
  ? M extends BoundMessage
    ? Omit<M, "context" | "pageNonce" | "challenge" | "seq">
    : never
  : never;

/** Whether `seq` is still the binding's newest status attempt (read after an await). */
function isNewest(binding: Binding, seq: number): boolean {
  return binding.status?.seq === seq;
}

export class ConnectionInspectors {
  private readonly deps: ConnectionInspectorsDeps;
  private readonly generations = new Map<string, Generation>();
  private disposed = false;

  /** Creating it sends, schedules and generates nothing. */
  constructor(deps: ConnectionInspectorsDeps) {
    this.deps = deps;
  }

  /** An inspector of `context` appeared: a new, unbound generation; prompts a hello. */
  shown(context: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const challenge = this.deps.newChallenge();
    if (!isSessionId(challenge)) {
      // Never send an identity the page could not accept; nothing binds.
      this.deps.log("connection inspector: bad_challenge");
      this.generations.delete(context);
      return Promise.resolve();
    }
    const generation: Generation = { challenge, binding: null };
    this.generations.set(context, generation);
    return this.handOver(context, generation, { type: "connection_ready", context }).then(
      () => undefined,
    );
  }

  /** The inspector of `context` disappeared: its generation ends for good. */
  hidden(context: string): void {
    this.generations.delete(context);
  }

  /** A message from the inspector of `context`; `payload` is unvalidated JSON. */
  async message(context: string, payload: unknown): Promise<void> {
    if (this.disposed) return;
    const message = parsePageMessage(payload);
    if (message === null) {
      // Without a valid page nonce there is nobody to answer.
      this.deps.log("connection inspector: bad_request");
      return;
    }
    const generation = this.generations.get(context);
    if (generation === undefined) {
      // Before didAppear, or after didDisappear: nothing is kept.
      this.deps.log("connection inspector: no_generation");
      return;
    }
    if (message.type === "connection_hello") {
      await this.hello(context, generation, message.pageNonce);
      return;
    }
    if (message.challenge !== generation.challenge) {
      await this.reject(context, generation, message, "stale_session");
      return;
    }
    if (message.type === "connection_confirm") {
      await this.confirm(context, generation, message.pageNonce);
      return;
    }
    const binding = generation.binding;
    if (binding?.pageNonce !== message.pageNonce) {
      await this.reject(context, generation, message, "stale_session");
      return;
    }
    if (message.type === "connection_get_status") {
      await this.sendStatus(context, generation, binding, message.requestId);
      return;
    }
    this.deps.log("connection inspector: save_received");
    const outcome = await this.deps.save(message.daemonUrl);
    this.deps.log(`connection inspector: save_${outcome.kind}`);
    const status = connectionStatusView(this.deps.status());
    await this.sendBound(
      context,
      generation,
      binding,
      {
        type: "connection_save_result",
        requestId: message.requestId,
        outcome: outcome.kind,
        error: outcome.kind === "invalid" ? outcome.error : null,
        status,
      },
      // The page shows this status with the result; a later push sends only a change.
      JSON.stringify(status),
    );
  }

  /** The connection may have changed: pushes a changed status to bound pages. */
  refresh(): void {
    if (this.disposed) return;
    for (const [context, generation] of this.generations) {
      const binding = generation.binding;
      if (binding !== null) void this.sendStatus(context, generation, binding, null, true);
    }
  }

  /** Shutdown: every generation ends; later answers are dropped. */
  dispose(): void {
    this.disposed = true;
    this.generations.clear();
  }

  private async hello(context: string, generation: Generation, pageNonce: string): Promise<void> {
    const binding = generation.binding;
    if (binding === null) {
      await this.handOver(context, generation, {
        type: "connection_challenge",
        context,
        pageNonce,
        challenge: generation.challenge,
      });
      return;
    }
    if (binding.pageNonce === pageNonce) {
      // A repeated hello of the bound page: the binding again, nothing new.
      await this.sendBoundState(context, generation, binding);
      return;
    }
    // Bound to another page: a hello never rebinds.
    await this.handOver(context, generation, {
      type: "connection_rejected",
      context,
      pageNonce,
      challenge: null,
      request: "hello",
      requestId: null,
      code: "generation_bound",
    });
  }

  private async confirm(context: string, generation: Generation, pageNonce: string): Promise<void> {
    const binding = generation.binding;
    if (binding === null) {
      // Reserved first: a binding binds once and reads once, even if the
      // read below reenters through a redraw.
      const bound: Binding = { pageNonce, seq: 0, status: null };
      generation.binding = bound;
      this.deps.log("connection inspector: bound");
      // The bound is handed to the SDK before the read starts, so the
      // read's synchronous redraw pushes its "pending" status as a later
      // seq, which the now bound page accepts. The handshake never waits
      // for the read itself.
      const sending = this.sendBoundState(context, generation, bound);
      this.deps.refreshSettings();
      await sending;
      return;
    }
    if (binding.pageNonce === pageNonce) {
      // The same confirm again: idempotent, no second binding.
      await this.sendBoundState(context, generation, binding);
      return;
    }
    await this.handOver(context, generation, {
      type: "connection_rejected",
      context,
      pageNonce,
      challenge: generation.challenge,
      request: "confirm",
      requestId: null,
      code: "generation_bound",
    });
  }

  private reject(
    context: string,
    generation: Generation,
    message: Exclude<PageMessage, { readonly type: "connection_hello" }>,
    code: "stale_session",
  ): Promise<void> {
    this.deps.log(`connection inspector: rejected_${code}`);
    const request: RequestKind =
      message.type === "connection_confirm"
        ? "confirm"
        : message.type === "connection_get_status"
          ? "get_status"
          : "save";
    return this.handOver(context, generation, {
      type: "connection_rejected",
      context,
      pageNonce: message.pageNonce,
      challenge: message.challenge,
      request,
      requestId: message.type === "connection_confirm" ? null : message.requestId,
      code,
    }).then(() => undefined);
  }

  private sendBoundState(context: string, generation: Generation, binding: Binding): Promise<void> {
    const status = connectionStatusView(this.deps.status());
    return this.sendBound(
      context,
      generation,
      binding,
      { type: "connection_bound", status },
      JSON.stringify(status),
    );
  }

  private sendStatus(
    context: string,
    generation: Generation,
    binding: Binding,
    requestId: string | null,
    onlyIfChanged = false,
  ): Promise<void> {
    const status = connectionStatusView(this.deps.status());
    const text = JSON.stringify(status);
    if (onlyIfChanged && text === binding.status?.text) return Promise.resolve();
    return this.sendBound(
      context,
      generation,
      binding,
      { type: "connection_status", requestId, status },
      text,
    );
  }

  /**
   * A message of the binding: its page nonce, challenge and next seq are
   * filled in here, in send order, only while the generation is current.
   */
  private async sendBound(
    context: string,
    generation: Generation,
    binding: Binding,
    draft: BoundDraft,
    statusText: string,
  ): Promise<void> {
    if (!this.isCurrent(context, generation)) {
      this.deps.log("connection inspector: answer_dropped");
      return;
    }
    binding.seq += 1;
    const seq = binding.seq;
    binding.status = { text: statusText, seq };
    const message: PluginMessage = {
      ...draft,
      context,
      pageNonce: binding.pageNonce,
      challenge: generation.challenge,
      seq,
    };
    const sent = await this.handOver(context, generation, message);
    // Only the newest attempt is forgotten; an older one never touches a newer cache.
    if (!sent && isNewest(binding, seq)) binding.status = null;
  }

  /**
   * Hands a message to the SDK while its generation is the current one of
   * the context. This gate acts before the hand-over only: a packet already
   * handed over cannot be recalled. A failed send is logged as a code.
   * Returns whether the SDK took it.
   */
  private async handOver(
    context: string,
    generation: Generation,
    message: PluginMessage,
  ): Promise<boolean> {
    if (!this.isCurrent(context, generation)) {
      this.deps.log("connection inspector: answer_dropped");
      return false;
    }
    try {
      await this.deps.send(context, message);
      return true;
    } catch {
      this.deps.log("connection inspector: send_failed");
      return false;
    }
  }

  private isCurrent(context: string, generation: Generation): boolean {
    return !this.disposed && this.generations.get(context) === generation;
  }
}
