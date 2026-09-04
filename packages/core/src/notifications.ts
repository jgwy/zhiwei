import pg from "pg";

type Channel = "zhiwei_activity" | "zhiwei_jobs";
type Listener = (channel: string, userId: string) => void;
const listeners = new Set<Listener>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let closed = false;

async function connect() {
  if (client || connecting || closed) return connecting;
  connecting = (async () => {
    const connection = new pg.Client({
      connectionString:
        process.env.DATABASE_URL ??
        "postgres://zhiwei:zhiwei@127.0.0.1:54329/zhiwei",
    });
    const disconnected = () => {
      if (client !== connection) return;
      client = null;
      void connection.end().catch(() => undefined);
      if (!closed)
        reconnect = setTimeout(() => {
          void connect().catch(() => undefined);
        }, 2_000);
    };
    connection.on("error", disconnected);
    connection.on("end", disconnected);
    connection.on("notification", (event) => {
      for (const listener of listeners)
        listener(event.channel, event.payload ?? "");
    });
    try {
      await connection.connect();
      await connection.query("LISTEN zhiwei_activity; LISTEN zhiwei_jobs");
      client = connection;
      for (const listener of listeners) listener("*", "*");
    } catch (error) {
      void connection.end().catch(() => undefined);
      if (!closed)
        reconnect = setTimeout(() => {
          void connect().catch(() => undefined);
        }, 2_000);
      throw error;
    }
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

export function subscribeDatabase(channel: Channel, userId?: string) {
  let dirty = true;
  let wake: (() => void) | undefined;
  const listener: Listener = (event, user) => {
    if (
      (event === "*" || event === channel) &&
      (!userId || user === "*" || user === userId)
    ) {
      dirty = true;
      wake?.();
    }
  };
  listeners.add(listener);
  void connect().catch(() => undefined);
  return {
    async wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
      if (dirty) {
        dirty = false;
        return true;
      }
      if (signal?.aborted) return false;
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          wake = undefined;
          const changed = dirty;
          dirty = false;
          resolve(changed);
        };
        const timer = setTimeout(finish, timeoutMs);
        wake = finish;
        signal?.addEventListener("abort", finish, { once: true });
      });
    },
    close() {
      listeners.delete(listener);
      wake?.();
    },
  };
}

export async function closeNotifications() {
  closed = true;
  clearTimeout(reconnect);
  const connection = client;
  client = null;
  await connection?.end().catch(() => undefined);
}
