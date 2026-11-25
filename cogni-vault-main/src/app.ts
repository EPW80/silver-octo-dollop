import { assertRole, type Actor } from "./auth.js";
import { listAudit, writeAudit } from "./audit.js";
import { AskService, ExtractiveModel, type LanguageModel } from "./ask.js";
import type { BlobStore } from "./blobs.js";
import type { SqlDatabase } from "./env.js";
import { readLimit } from "./fields.js";
import { InventoryService } from "./inventory.js";
import { LedgerService } from "./ledger.js";
import { OrderService } from "./orders.js";
import { PaymentService } from "./payments.js";
import { BankStore, type StoreOptions } from "./store.js";
import type { PaymentProvider } from "./stripe.js";

export interface AppOptions extends StoreOptions {
  provider?: PaymentProvider | null;
  model?: LanguageModel;
}

export class App {
  readonly bank: BankStore;
  readonly orders: OrderService;
  readonly inventory: InventoryService;
  readonly payments: PaymentService;
  readonly ledger: LedgerService;
  readonly ask: AskService;
  private readonly clock: () => string;

  constructor(
    private readonly db: SqlDatabase,
    blobs: BlobStore,
    options: AppOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.bank = new BankStore(db, blobs, { clock: this.clock, r2Threshold: options.r2Threshold, semanticWindow: options.semanticWindow });
    this.orders = new OrderService(db, this.clock);
    this.inventory = new InventoryService(db, this.clock);
    this.payments = new PaymentService(db, options.provider ?? null, this.clock);
    this.ledger = new LedgerService(db, this.bank, this.clock);
    this.ask = new AskService(db, this.bank, options.model ?? new ExtractiveModel());
  }

  async saveItem(input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const item = await this.bank.saveItem(input, actor.bot);
    await this.audit(actor, "item.save", "item", item.id, item.title);
    return item;
  }

  async updateItem(id: string, input: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const item = await this.bank.updateItem(id, input, actor.bot);
    await this.audit(actor, "item.update", "item", item.id, item.title);
    return item;
  }

  async deleteItem(id: string, actor: Actor) {
    assertRole(actor, "operator");
    const result = await this.bank.deleteItem(id);
    await this.audit(actor, "item.delete", "item", id);
    return result;
  }

  async createCollection(name: unknown, description: unknown, actor: Actor) {
    assertRole(actor, "operator");
    const collection = await this.bank.createCollection(name, description);
    await this.audit(actor, "collection.create", "collection", collection.name);
    return collection;
  }

  async deleteCollection(name: unknown, force: boolean, actor: Actor) {
    assertRole(actor, "operator");
    const result = await this.bank.deleteCollection(name, force);
    await this.audit(actor, "collection.delete", "collection", result.name, `deleted ${result.deleted_items} items`);
    return result;
  }

  async recentAudit(limit: unknown, actor: Actor) {
    assertRole(actor, "operator");
    return { entries: await listAudit(this.db, readLimit(limit, 50, 200)) };
  }

  private async audit(actor: Actor, action: string, entityType: string, entityId: string, summary?: string) {
    await writeAudit(this.db, { actor, action, entityType, entityId, summary }, this.clock());
  }
}
