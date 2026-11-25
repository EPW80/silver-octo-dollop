import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env, SqlDatabase, SqlStatement } from "../src/env.js";
import { BankStore, type StoreOptions } from "../src/store.js";

const MIGRATIONS = readdirSync(join(dirname(fileURLToPath(import.meta.url)), "../migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../migrations", name), "utf8"));

export const LOCAL_KEY = "dbk_test_local_bot_key";
export const SECOND_KEY = "dbk_test_second_bot_key";
export const API_KEYS = `local-bot:${LOCAL_KEY},second-bot:${SECOND_KEY}`;

export function sequencedClock(start = Date.parse("2026-01-01T00:00:00.000Z")): () => string {
  let time = start;
  return () => {
    const iso = new Date(time).toISOString();
    time += 1000;
    return iso;
  };
}

export function createDatabase(migrations = MIGRATIONS.length, beforeMigration?: (db: DatabaseSync, version: number) => void): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const [index, migration] of MIGRATIONS.slice(0, migrations).entries()) {
    beforeMigration?.(db, index + 1);
    db.exec(migration);
  }
  return new SqliteDatabase(db);
}

export function createBucket(): MemoryBucket {
  return new MemoryBucket();
}

export function createStore(options: StoreOptions = {}): { store: BankStore; bucket: MemoryBucket } {
  const bucket = createBucket();
  const store = new BankStore(createDatabase(), bucket, options);
  return { store, bucket };
}

export function createEnv(): Env {
  return {
    DB: createDatabase(),
    BUCKET: createBucket(),
    API_KEYS,
  };
}

/**
 * Wraps a database so every statement matching `pattern` throws. Used to prove that a failure after
 * a payment provider call leaves the transaction retryable instead of marking it failed.
 */
export function withFailingWrites(inner: SqlDatabase, pattern: RegExp): SqlDatabase {
  return {
    prepare(query: string): SqlStatement {
      const statement = inner.prepare(query);
      if (!pattern.test(query)) return statement;
      if (!(statement instanceof SqliteStatement)) throw new Error("Fault injection requires a SQLite test database.");
      return statement.withFailure();
    },
    batch: (statements: SqlStatement[]) => inner.batch(statements),
  };
}

class SqliteDatabase implements SqlDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): SqlStatement {
    return new SqliteStatement(this.db, query);
  }

  async batch(statements: SqlStatement[]): Promise<{ meta: { changes: number } }[]> {
    this.db.exec("BEGIN");
    try {
      const results: { meta: { changes: number } }[] = [];
      for (const statement of statements) {
        if (!(statement instanceof SqliteStatement)) throw new Error("Expected a SQLite test statement.");
        results.push(statement.runSync());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteStatement implements SqlStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
    private readonly failing = false,
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new SqliteStatement(this.db, this.sql, values, this.failing);
  }

  withFailure(): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, this.params, true);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const statement = this.prepare();
    const results = (this.params.length ? statement.all(...(this.params as never[])) : statement.all()) as T[];
    return { results };
  }

  async first<T>(): Promise<T | null> {
    const statement = this.prepare();
    const row = (this.params.length ? statement.get(...(this.params as never[])) : statement.get()) as T | undefined;
    return row ?? null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { meta: { changes: number } } {
    const statement = this.prepare();
    const info = this.params.length ? statement.run(...(this.params as never[])) : statement.run();
    return { meta: { changes: Number(info.changes) } };
  }

  private prepare() {
    if (this.failing) throw new Error("simulated database failure");
    return this.db.prepare(this.sql);
  }
}

class MemoryBucket {
  readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return { text: async () => value };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async putText(key: string, text: string): Promise<void> {
    await this.put(key, text);
  }

  async getText(key: string): Promise<string | null> {
    const object = await this.get(key);
    return object ? object.text() : null;
  }
}
