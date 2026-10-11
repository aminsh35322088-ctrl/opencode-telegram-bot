import type { SqlDatabase } from "./control-store.js";

const DAY = 86_400_000;
const BACKGROUND_READ_LIMIT = 1_000_000;
const BACKGROUND_WRITE_LIMIT = 20_000;
type Usage = { day: number; rowsRead: number; rowsWritten: number };

/** Reserve most of the free SQL allowance for authenticated user/control traffic. */
export class ControlSqlBudget {
  readonly sql: SqlDatabase;
  private usage: Usage;
  private dirty = false;
  private statements = 0;
  private peakRows = 0;
  private peakStatement = "";

  constructor(private readonly raw: SqlDatabase, private readonly now: () => number = Date.now) {
    raw.exec("CREATE TABLE IF NOT EXISTS control_sql_usage(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
    const stored = [...raw.exec<{ data: string }>("SELECT data FROM control_sql_usage WHERE id=1")][0];
    const day = this.day();
    const record = stored ? JSON.parse(stored.data) as Usage : undefined;
    this.usage = record?.day === day ? record : { day, rowsRead: 0, rowsWritten: 0 };
    this.sql = {
      exec: ((query: string, ...bindings: unknown[]) => {
        this.rollDay();
        this.statements++;
        const cursor = raw.exec(query, ...bindings);
        let read = 0, written = 0;
        const sample = () => {
          // Cloudflare reports scanned/index rows, not the number of result records.
          const nextRead = Number(cursor.rowsRead ?? 0);
          const nextWritten = Number(cursor.rowsWritten ?? 0);
          const readDelta = Math.max(0, nextRead - read);
          const writeDelta = Math.max(0, nextWritten - written);
          this.usage.rowsRead += readDelta;
          this.usage.rowsWritten += writeDelta;
          this.dirty ||= readDelta > 0 || writeDelta > 0;
          read = nextRead;
          written = nextWritten;
          if (read > this.peakRows) {
            this.peakRows = read;
            const operation = query.trim().split(/\s+/u)[0]?.toUpperCase() ?? "SQL";
            const table = /\b(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+)/iu.exec(query)?.[1] ?? "other";
            this.peakStatement = `${operation}:${table}`;
          }
        };
        sample();
        // Tests backed by Node SQLite return arrays; Cloudflare returns a native cursor.
        if (Array.isArray(cursor)) return cursor;
        const wrap = (target: object): object => new Proxy(target, {
          get: (value, key) => {
            const member = Reflect.get(value, key, value) as unknown;
            if (typeof member !== "function") return member;
            if (key === Symbol.iterator) return () => wrap(value);
            return (...args: unknown[]) => {
              try {
                const result: unknown = Reflect.apply(member, value, args);
                return key === "raw" && result && typeof result === "object" ? wrap(result) : result;
              } finally { sample(); }
            };
          },
        });
        return wrap(cursor);
      }) as SqlDatabase["exec"],
    };
  }
  private day(): number { return Math.floor(this.now() / DAY); }
  private rollDay(): void {
    const day = this.day();
    if (this.usage.day !== day) {
      this.usage = { day, rowsRead: 0, rowsWritten: 0 };
      this.dirty = true;
    }
  }
  snapshot() {
    this.rollDay();
    return { ...this.usage, statements: this.statements, peakRows: this.peakRows, peakStatement: this.peakStatement };
  }
  backgroundAllowed(): boolean {
    this.rollDay();
    return this.usage.rowsRead < BACKGROUND_READ_LIMIT && this.usage.rowsWritten < BACKGROUND_WRITE_LIMIT;
  }
  nextReset(): number { return (this.day() + 1) * DAY; }
  flush(): void {
    this.rollDay();
    if (!this.dirty) return;
    // Persist once per invocation, outside application transactions. No submitted SQL bindings are logged.
    this.usage.rowsWritten++;
    this.raw.exec("INSERT INTO control_sql_usage(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(this.usage));
    this.dirty = false;
  }
}
