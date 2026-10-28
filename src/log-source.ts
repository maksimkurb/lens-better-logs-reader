import { Renderer } from "@freelensapp/extensions";

const { podsApi } = Renderer.K8sApi;

const INITIAL_LINES = 1000;
const MAX_LINES = 200000;
// Matches the RFC3339 prefix the API adds when asking for timestamps.
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}) /gm;
const TIMESTAMP_AT_START = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})) /;

export interface Target {
  namespace: string;
  pod: string;
  container: string;
  previous: boolean;
}

export const stripTimestamps = (text: string) => text.replace(TIMESTAMP_PREFIX, "");

// The tab's own log store calls the same API object; keep the real call for ourselves.
const fetchLogs: typeof podsApi.getLogs = podsApi.getLogs.bind(podsApi);

let active: LogSource | null = null;

/**
 * The built-in (hidden) tab keeps fetching the logs it no longer shows. While we are showing the
 * same pod and container, answer it from our copy instead of asking the API server a second time.
 */
podsApi.getLogs = async (
  params: { name: string; namespace: string },
  query: { container?: string; previous?: boolean; timestamps?: boolean } = {},
) => {
  const source = active;
  if (source?.serves(params, query)) {
    const text = await source.ready();
    return query.timestamps ? text : stripTimestamps(text);
  }
  return fetchLogs(params, query);
};

/**
 * Holds the log of one container (always with timestamps). Starts with the last few lines, then
 * only asks for lines newer than the last one seen; older lines are fetched when asked for.
 */
export class LogSource {
  text = "";
  /** False once the start of the log has been reached. */
  hasOlder = true;
  private requested = INITIAL_LINES;
  private pending: Promise<void> | null = null;
  private lastTimestamp: string | null = null;

  constructor(private target: Target) {
    active = this;
  }

  dispose() {
    if (active === this) active = null;
  }

  serves(params: { name: string; namespace: string }, query: { container?: string; previous?: boolean }) {
    const t = this.target;
    return (
      params.name === t.pod &&
      params.namespace === t.namespace &&
      query.container === t.container &&
      !!query.previous === t.previous &&
      (!!this.text || !!this.pending)
    );
  }

  /** Resolves with the current text once any fetch in flight is done. */
  async ready() {
    await this.pending;
    return this.text;
  }

  /** Fetches what is new; returns whether the text changed. */
  async refresh(): Promise<boolean> {
    return this.run(async () => {
      const t = this.target;
      const params = { name: t.pod, namespace: t.namespace };
      const base = { container: t.container, timestamps: true, previous: t.previous };
      if (this.lastTimestamp === null) {
        const text = await fetchLogs(params, { ...base, tailLines: this.requested });
        this.set(text);
        this.hasOlder = countLines(text) >= this.requested;
        return true;
      }
      const text: string = await fetchLogs(params, { ...base, sinceTime: this.lastTimestamp });
      // sinceTime is inclusive; drop lines already held.
      const fresh = text
        .split("\n")
        .filter((line: string) => {
          const stamp = TIMESTAMP_AT_START.exec(line)?.[1];
          return stamp !== undefined && comparable(stamp) > comparable(this.lastTimestamp!);
        })
        .join("\n");
      if (!fresh) return false;
      this.set(this.text ? `${this.text}\n${fresh}` : fresh);
      return true;
    });
  }

  /** Fetches a bigger tail; returns how many lines were added in front. */
  async loadOlder(): Promise<number> {
    let added = 0;
    await this.run(async () => {
      if (!this.hasOlder) return false;
      const t = this.target;
      const before = countLines(this.text);
      this.requested = Math.min(this.requested * 4, MAX_LINES);
      const text = await fetchLogs(
        { name: t.pod, namespace: t.namespace },
        { container: t.container, timestamps: true, previous: t.previous, tailLines: this.requested },
      );
      const after = countLines(text);
      this.hasOlder = after >= this.requested && this.requested < MAX_LINES;
      added = Math.max(0, after - before);
      this.set(text);
      return true;
    });
    return added;
  }

  private set(text: string) {
    this.text = text.replace(/\n$/, "");
    const last = this.text.slice(this.text.lastIndexOf("\n") + 1);
    this.lastTimestamp = TIMESTAMP_AT_START.exec(last)?.[1] ?? this.lastTimestamp;
  }

  // One fetch at a time, so polling and loading older lines cannot interleave.
  private async run(job: () => Promise<boolean>): Promise<boolean> {
    while (this.pending) await this.pending.catch(() => {});
    let changed = false;
    this.pending = job().then((c) => void (changed = c));
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
    return changed;
  }
}

// Nanosecond fractions come with trailing zeros trimmed, so pad them before comparing as text.
const comparable = (stamp: string) => stamp.replace(/\.(\d+)/, (_, f: string) => `.${f.padEnd(9, "0")}`);

const countLines = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0);
