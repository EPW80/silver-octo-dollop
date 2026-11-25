import { assertRole, type Actor } from "./auth.js";
import type { SqlDatabase } from "./env.js";
import { BankError } from "./errors.js";
import { readText } from "./fields.js";
import type { BankStore } from "./store.js";

export interface LanguageModel {
  readonly name: string;
  answer(question: string, briefing: string): Promise<string>;
}

/** Answers from the retrieved briefing only. No outside knowledge, no network. */
export class ExtractiveModel implements LanguageModel {
  readonly name = "local";

  async answer(question: string, briefing: string): Promise<string> {
    return [`House of Helix Peptides`, ``, `Question: ${question}`, ``, briefing].join("\n");
  }
}

export interface AiBinding {
  run(model: string, input: { messages: { role: string; content: string }[] }): Promise<{ response?: string } | string>;
}

const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export class WorkersAiModel implements LanguageModel {
  readonly name = "workers-ai";

  constructor(private readonly ai: AiBinding) {}

  async answer(question: string, briefing: string): Promise<string> {
    const result = await this.ai.run(WORKERS_AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You answer questions for House of Helix Peptides. Use only the briefing. If it does not contain the answer, say so. Do not invent orders, stock, or payments.",
        },
        { role: "user", content: `Question: ${question}\n\nBriefing:\n${briefing}` },
      ],
    });
    if (typeof result === "string" && result.trim()) return result.trim();
    if (typeof result === "object" && result.response?.trim()) return result.response.trim();
    return briefing;
  }
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const ORDER_ID = /ord_[0-9a-f]{32}/i;
const SKU = /\b[A-Z0-9][A-Z0-9._-]{1,40}\b/g;

export class AskService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly bank: BankStore,
    private readonly model: LanguageModel,
  ) {}

  async ask(questionInput: unknown, actor: Actor) {
    assertRole(actor, "read");
    const question = readText(questionInput, "question", 1000, true);
    const briefing = await this.briefing(question);
    let answer: string;
    try {
      answer = await this.model.answer(question, briefing);
    } catch (error) {
      console.error("ask model failed", error instanceof Error ? error.message : "model");
      answer = await new ExtractiveModel().answer(question, briefing);
    }
    return { answer, model: this.model.name, briefing };
  }

  private async briefing(question: string): Promise<string> {
    const sections: string[] = [];
    const email = EMAIL.exec(question)?.[0]?.toLowerCase();
    const orderId = ORDER_ID.exec(question)?.[0];
    const lower = question.toLowerCase();

    if (orderId) {
      const order = await this.db.prepare(`SELECT id, customer_email, status, total_cents, currency FROM orders WHERE id = ?`).bind(orderId).first();
      sections.push(order ? `Order ${JSON.stringify(order)}` : `No order ${orderId}.`);
    }
    if (email) {
      const { results } = await this.db
        .prepare(`SELECT id, status, total_cents, currency, created_at FROM orders WHERE customer_email = ? ORDER BY created_at DESC LIMIT 10`)
        .bind(email)
        .all();
      sections.push(`Orders for ${email}: ${JSON.stringify(results ?? [])}`);
    }

    // One query for every SKU-looking token that actually exists, instead of a sequential lookup
    // per word (which probed products named "THE" and "ORDER" on most questions).
    const candidates = [...new Set([...question.toUpperCase().matchAll(SKU)].map((match) => match[0]))]
      .filter((sku) => sku.length >= 2)
      .slice(0, 12);
    if (candidates.length > 0) {
      const placeholders = candidates.map(() => "?").join(", ");
      const { results } = await this.db
        .prepare(
          `SELECT sku, title, stock, low_stock_threshold, price_cents, currency, active
           FROM products WHERE sku IN (${placeholders}) LIMIT 5`,
        )
        .bind(...candidates)
        .all();
      for (const product of results ?? []) sections.push(`Product ${JSON.stringify(product)}`);
    }

    if (/\b(low stock|restock|inventory)\b/.test(lower)) {
      const { results } = await this.db
        .prepare(`SELECT sku, title, stock, low_stock_threshold FROM products WHERE active = 1 AND stock <= low_stock_threshold ORDER BY sku LIMIT 20`)
        .all();
      sections.push(`Low stock: ${JSON.stringify(results ?? [])}`);
    }

    if (/\b(ledger|policy|record|note)\b/.test(lower)) {
      const { results } = await this.db
        .prepare(`SELECT id, kind, title, ref_type, ref_id, item_id, created_at FROM ledger_entries ORDER BY created_at DESC LIMIT 8`)
        .all();
      sections.push(`Recent business records: ${JSON.stringify(results ?? [])}`);
    }

    try {
      const found = await this.bank.searchItems({ query: question, mode: "hybrid", limit: 5 });
      sections.push(
        `Knowledge store: ${JSON.stringify(found.items.map((item) => ({ id: item.id, title: item.title, excerpt: item.excerpt, collection: item.collection })))}`,
      );
    } catch (error) {
      if (!(error instanceof BankError)) throw error;
    }

    if (sections.length === 0) {
      return "Nothing in the knowledge store or the business tables matched this question.";
    }
    return sections.join("\n\n");
  }
}
