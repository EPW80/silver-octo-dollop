export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  /**
   * Runs the statements in one transaction. D1 provides this natively; the node test helper
   * implements it with BEGIN/COMMIT. A multi-statement invariant that is not batched can leave
   * partial state when a later statement fails.
   */
  batch(statements: SqlStatement[]): Promise<{ meta?: { changes?: number } }[]>;
}

export interface ObjectBucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
}

export interface AiBinding {
  run(
    model: string,
    input: { messages: { role: string; content: string }[] },
  ): Promise<{ response?: string } | string>;
}

export interface Env {
  DB: SqlDatabase;
  BUCKET: ObjectBucket;
  API_KEYS?: string;
  /** Stripe secret key. Required only when an admin executes a charge or refund. */
  STRIPE_SECRET_KEY?: string;
  /** Set to "local" to skip Workers AI even when the AI binding is present. */
  ANSWERER?: string;
  AI?: AiBinding;
}
