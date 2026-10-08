/**
 * Wake-ups for the pending long-poll (CONCEPT §3, §5: "Long-polls wait on
 * Postgres LISTEN"). Migration 0003 notifies `proa_analysis` with the project
 * id whenever a task becomes `queued`.
 *
 * Connection hygiene: one dedicated connection per process (never a pool
 * connection, which a waiting request would otherwise hold), opened on the
 * first subscription with `application_name = proa-listen`, re-opened after
 * an error, closed with the database. Subscriptions are in memory and
 * bounded, in total and per caller; every wait has a timeout and honours an abort signal, and a
 * lost connection wakes all waiters so they count again.
 */
import type { ProjectId } from '@proa/contracts';
import pg from 'pg';

import type { Notifier, WorkSubscription } from '../domain/ports.ts';

export const ANALYSIS_CHANNEL = 'proa_analysis';
export const LISTENER_APPLICATION_NAME = 'proa-listen';
/** Concurrent long-polls per process; more wait no longer than a count. */
export const DEFAULT_MAX_SUBSCRIBERS = 200;
/**
 * Concurrent long-polls per caller (principal); its further polls answer at
 * once, so one token cannot take the slots of every other client.
 */
export const DEFAULT_MAX_SUBSCRIBERS_PER_OWNER = 8;

export interface NotifierHandle extends Notifier {
  /** Open subscriptions (tests, metrics). */
  subscribers(): number;
  /** Whether the LISTEN connection is open. */
  connected(): boolean;
  /** Ends the LISTEN connection and resolves every wait with `false`; idempotent. */
  close(): Promise<void>;
}

interface Subscriber {
  readonly projects: ReadonlySet<string>;
  wake(): void;
  end(): void;
}

/** A subscription that never waits (closed notifier, subscriber limit, no connection). */
const IMMEDIATE: WorkSubscription = {
  wait: () => Promise.resolve(false),
  close: () => undefined,
};

export function createNotifier(
  connectionString: string,
  options: { maxSubscribers?: number; maxPerOwner?: number } = {},
): NotifierHandle {
  const max = options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
  const maxPerOwner = options.maxPerOwner ?? DEFAULT_MAX_SUBSCRIBERS_PER_OWNER;
  const subscribers = new Set<Subscriber>();
  const perOwner = new Map<string, number>();
  let client: pg.Client | null = null;
  let connecting: Promise<pg.Client> | null = null;
  let closed = false;

  function drop(c: pg.Client): void {
    if (client !== c) return;
    client = null;
    // Lost notifications are possible now: let every waiter count again.
    for (const s of subscribers) s.wake();
  }

  async function open(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString, application_name: LISTENER_APPLICATION_NAME });
    c.on('notification', (msg) => {
      if (msg.channel !== ANALYSIS_CHANNEL || msg.payload === undefined) return;
      for (const s of subscribers) if (s.projects.has(msg.payload)) s.wake();
    });
    c.on('error', (err) => {
      console.error(`postgres listener error: ${err.message}`);
      drop(c);
      c.end().catch(() => undefined);
    });
    c.on('end', () => drop(c));
    try {
      await c.connect();
      await c.query(`LISTEN ${ANALYSIS_CHANNEL}`);
    } catch (err) {
      await c.end().catch(() => undefined);
      throw err;
    }
    if (closed) {
      await c.end().catch(() => undefined);
      throw new Error('notifier closed');
    }
    client = c;
    return c;
  }

  function connection(): Promise<pg.Client> {
    if (client) return Promise.resolve(client);
    connecting ??= open().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  return {
    async subscribe(projectIds: readonly ProjectId[], owner: string): Promise<WorkSubscription> {
      if (closed || subscribers.size >= max || (perOwner.get(owner) ?? 0) >= maxPerOwner) {
        return IMMEDIATE;
      }
      // Counted before the connection is awaited, so concurrent calls see each other.
      perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
      let counted = true;
      const uncount = () => {
        if (!counted) return;
        counted = false;
        const n = (perOwner.get(owner) ?? 1) - 1;
        if (n > 0) perOwner.set(owner, n);
        else perOwner.delete(owner);
      };
      try {
        await connection();
      } catch (err) {
        uncount();
        console.error(`postgres listener unavailable: ${(err as Error).message}`);
        return IMMEDIATE;
      }
      if (closed || subscribers.size >= max) {
        uncount();
        return IMMEDIATE;
      }
      let woken = false;
      let settle: ((value: boolean) => void) | null = null;
      const subscriber: Subscriber = {
        projects: new Set(projectIds),
        wake() {
          woken = true;
          settle?.(true);
        },
        end() {
          settle?.(false);
        },
      };
      subscribers.add(subscriber);
      return {
        wait(timeoutMs, signal) {
          if (woken) return Promise.resolve(true);
          if (closed || signal?.aborted) return Promise.resolve(false);
          return new Promise<boolean>((resolve) => {
            const onAbort = () => done(false);
            const timer = setTimeout(() => done(false), timeoutMs);
            function done(value: boolean): void {
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              settle = null;
              resolve(value);
            }
            settle = done;
            signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
        close() {
          subscribers.delete(subscriber);
          uncount();
          settle?.(false);
        },
      };
    },
    subscribers: () => subscribers.size,
    connected: () => client !== null,
    async close() {
      if (closed) return;
      closed = true;
      for (const s of subscribers) s.end();
      subscribers.clear();
      perOwner.clear();
      const c = client ?? (await connecting?.catch(() => null)) ?? null;
      client = null;
      if (c) await c.end().catch(() => undefined);
    },
  };
}
