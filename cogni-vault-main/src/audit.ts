import type { Actor } from "./auth.js";
import type { SqlDatabase, SqlStatement } from "./env.js";
import { newId } from "./ids.js";

export interface AuditEntry {
  actor: Actor;
  action: string;
  entityType: string;
  entityId: string;
  summary?: string;
}

export async function writeAudit(db: SqlDatabase, entry: AuditEntry, now: string): Promise<void> {
  await auditStatement(db, entry, now).run();
}

export function auditStatement(
  db: SqlDatabase,
  entry: AuditEntry,
  now: string,
  condition?: { sql: string; params: unknown[] },
  id = newId("aud"),
): SqlStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, created_at, actor, role, action, entity_type, entity_id, summary)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?${condition ? ` WHERE ${condition.sql}` : ""}`,
    )
    .bind(
      id,
      now,
      entry.actor.bot,
      entry.actor.role,
      entry.action,
      entry.entityType,
      entry.entityId,
      (entry.summary ?? "").slice(0, 500),
      ...(condition?.params ?? []),
    );
}

export async function listAudit(db: SqlDatabase, limit: number): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT id, created_at, actor, role, action, entity_type, entity_id, summary
       FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}
