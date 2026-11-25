import { describe, expect, it } from "vitest";
import { BankError } from "../src/errors.js";
import { createStore, sequencedClock } from "./helpers.js";

function bank() {
  return createStore({ clock: sequencedClock(), r2Threshold: 64 });
}

describe("BankStore", () => {
  it("saves, gets, attributes, and keeps the original author on update", async () => {
    const { store } = bank();
    const saved = await store.saveItem(
      {
        title: "Launch notes",
        content: "Ship the data bank behind a bearer token.",
        tags: ["Launch", "mcp"],
        source: "chat",
        metadata: { ticket: 12 },
      },
      "local-bot",
    );

    expect(saved.id).toMatch(/^itm_[0-9a-f]{32}$/);
    expect(saved.author).toBe("local-bot");
    expect(saved.updated_by).toBe("local-bot");
    expect(saved.tags).toEqual(["launch", "mcp"]);
    expect(saved.collection).toBe("inbox");
    expect(saved.storage).toBe("d1");
    expect(saved.metadata).toEqual({ ticket: 12 });

    const updated = await store.updateItem(saved.id, { title: "Launch notes v2" }, "second-bot");
    expect(updated.title).toBe("Launch notes v2");
    expect(updated.author).toBe("local-bot");
    expect(updated.updated_by).toBe("second-bot");
    expect(updated.content).toContain("bearer token");
  });

  it("stores JSON data canonically and rejects invalid JSON", async () => {
    const { store } = bank();
    const saved = await store.saveItem(
      { title: "Row", type: "data", content: ' { "b" : 2, "a" : 1 } ' },
      "local-bot",
    );
    expect(saved.type).toBe("data");
    expect(saved.content).toBe('{"b":2,"a":1}');

    const objectSaved = await store.saveItem(
      { title: "Object", content: { ok: true } },
      "local-bot",
    );
    expect(objectSaved.type).toBe("data");
    expect(objectSaved.content).toBe('{"ok":true}');

    await expect(store.saveItem({ title: "Bad", type: "data", content: "{not json" }, "local-bot")).rejects.toBeInstanceOf(BankError);
  });

  it("puts oversized bodies in object storage and still searches them", async () => {
    const { store, bucket } = bank();
    const content = `${"alpha ".repeat(30)}zephyrnook`;
    expect(content.length).toBeGreaterThan(64);
    const saved = await store.saveItem({ title: "Long doc", type: "doc", content }, "local-bot");
    expect(saved.storage).toBe("r2");
    expect(saved.content).toBe(content);
    expect(bucket.objects.get(`items/${saved.id}`)).toBe(content);

    const found = await store.searchItems({ query: "zephyrnook", mode: "keyword" });
    expect(found.items.map((item) => item.id)).toEqual([saved.id]);

    const shrunk = await store.updateItem(saved.id, { content: "now short" }, "local-bot");
    expect(shrunk.storage).toBe("d1");
    expect(shrunk.content).toBe("now short");
    expect(bucket.objects.has(`items/${saved.id}`)).toBe(false);
  });

  it("searches by keyword, semantic similarity, tags, and collection", async () => {
    const { store } = bank();
    await store.saveItem(
      {
        title: "EU revenue",
        content: "Quarterly revenue forecast for the EU market",
        tags: ["finance"],
        collection: "Work Notes",
      },
      "local-bot",
    );
    await store.saveItem(
      { title: "Kitchen", content: "Sourdough starter feeding schedule", tags: ["home"] },
      "local-bot",
    );

    const keyword = await store.searchItems({ query: "revenue forecast", mode: "keyword" });
    expect(keyword.items[0]?.title).toBe("EU revenue");

    const semantic = await store.searchItems({ query: "EU market revenue", mode: "semantic" });
    expect(semantic.items[0]?.title).toBe("EU revenue");
    expect(semantic.items[0]?.score).toBeGreaterThan(semantic.items[1]?.score ?? 0);

    const tagged = await store.searchItems({ query: "revenue", tags: ["home"] });
    expect(tagged.items).toEqual([]);

    const scoped = await store.searchItems({ query: "revenue", collection: "work-notes" });
    expect(scoped.items).toHaveLength(1);

    const other = await store.searchItems({ query: "revenue", collection: "inbox" });
    expect(other.items).toEqual([]);
  });

  it("replaces the full-text index when content changes", async () => {
    const { store } = bank();
    const saved = await store.saveItem({ title: "Draft", content: "alphaunique term" }, "local-bot");
    await store.updateItem(saved.id, { content: "betaunique term" }, "local-bot");

    expect((await store.searchItems({ query: "alphaunique", mode: "keyword" })).items).toEqual([]);
    expect((await store.searchItems({ query: "betaunique", mode: "keyword" })).items).toHaveLength(1);
  });

  it("paginates recent items and rejects a bad cursor", async () => {
    const { store } = bank();
    await store.saveItem({ title: "One", content: "first" }, "local-bot");
    await store.saveItem({ title: "Two", content: "second" }, "local-bot");
    await store.saveItem({ title: "Three", content: "third" }, "local-bot");

    const page = await store.listItems({ limit: 2 });
    expect(page.items.map((item) => item.title)).toEqual(["Three", "Two"]);
    expect(page.next_cursor).toBeTruthy();

    const rest = await store.listItems({ limit: 2, cursor: page.next_cursor });
    expect(rest.items.map((item) => item.title)).toEqual(["One"]);
    expect(rest.next_cursor).toBeNull();

    await expect(store.listItems({ cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "bad_cursor" });
  });

  it("stores hostile titles as data and deletes items", async () => {
    const { store } = bank();
    const title = "'); DROP TABLE items; --";
    const saved = await store.saveItem({ title, content: "still here" }, "local-bot");
    expect((await store.getItem(saved.id)).title).toBe(title);
    expect((await store.listItems({})).items).toHaveLength(1);

    await store.deleteItem(saved.id);
    await expect(store.getItem(saved.id)).rejects.toMatchObject({ status: 404 });
  });

  it("manages collections without letting inbox be removed", async () => {
    const { store } = bank();
    const created = await store.createCollection("Reading List", "Books to revisit");
    expect(created.name).toBe("reading-list");
    await expect(store.createCollection("reading-list", "")).rejects.toMatchObject({ status: 409 });

    await store.saveItem({ title: "Essay", content: "notes", collection: "reading-list" }, "local-bot");
    await expect(store.deleteCollection("reading-list", false)).rejects.toMatchObject({ status: 409 });

    const removed = await store.deleteCollection("reading-list", true);
    expect(removed.deleted_items).toBe(1);
    await expect(store.deleteCollection("inbox", true)).rejects.toMatchObject({ code: "protected" });

    const names = (await store.listCollections()).map((collection) => collection.name);
    expect(names).toContain("inbox");
    expect(names).not.toContain("reading-list");
  });
});
