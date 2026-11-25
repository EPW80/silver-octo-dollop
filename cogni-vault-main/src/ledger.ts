import { assertRole, type Actor } from "./auth.js";
import { writeAudit } from "./audit.js";
import type { SqlDatabase } from "./env.js";
import { BankError } from "./errors.js";
import { objectBody, readLimit, readText } from "./fields.js";
import { newId } from "./ids.js";
import type { BankStore } from "./store.js";

const KINDS = new Set(["note", "event", "record", "policy"]);

export class LedgerService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly bank: BankStore,
    private readonly clock: () => string,
  ) {}

  async record(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const body = objectBody(input);
    const kind = readText(body.kind ?? "record", "kind", 40, true);
    if (!KINDS.has(kind)) throw new BankError("kind must be note, event, record, or policy.", 400, "bad_kind");
    const title = readText(body.title, "title", 200, true);
    const text = readText(body.body, "body", 20_000);
    const refType = readText(body.ref_type, "ref_type", 40);
    const refId = readText(body.ref_id, "ref_id", 80);
    const now = this.clock();
    let itemId = typeof body.item_id === "string" ? body.item_id : "";
    if (itemId) {
      await this.bank.getItem(itemId);
    } else {
      const item = await this.bank.saveItem(
        {
          title,
          content: text || title,
          type: "note",
          collection: "business",
          tags: ["business", kind],
          source: "ledger",
        },
        actor.bot,
      );
      itemId = item.id;
      await writeAudit(this.db, { actor, action: "item.save", entityType: "item", entityId: itemId, summary: title }, now);
    }
    const id = newId("led");
    await this.db
      .prepare(
        `INSERT INTO ledger_entries (id, kind, title, body, ref_type, ref_id, item_id, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, kind, title, text, refType || null, refId || null, itemId, actor.bot, now)
      .run();
    await writeAudit(this.db, { actor, action: "ledger.record", entityType: "ledger", entityId: id, summary: title }, now);
    return this.get(id);
  }

  async list(input: { ref_type?: unknown; ref_id?: unknown; limit?: unknown }, actor: Actor) {
    assertRole(actor, "read");
    const refType = input.ref_type == null || input.ref_type === "" ? null : readText(input.ref_type, "ref_type", 40);
    const refId = input.ref_id == null || input.ref_id === "" ? null : readText(input.ref_id, "ref_id", 80);
    const limit = readLimit(input.limit, 20, 100);
    const { results } = await this.db
      .prepare(
        `SELECT id, kind, title, body, ref_type, ref_id, item_id, actor, created_at
         FROM ledger_entries
         WHERE (? IS NULL OR ref_type = ?) AND (? IS NULL OR ref_id = ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(refType, refType, refId, refId, limit)
      .all();
    return { records: results ?? [] };
  }

  private async get(id: string) {
    const row = await this.db.prepare(`SELECT * FROM ledger_entries WHERE id = ?`).bind(id).first();
    if (!row) throw new BankError("Record not found.", 404, "not_found");
    return row;
  }
}
