-- Data bank: collections, items, and a full-text index.
-- Item bodies at or under 64 KiB live in `body`. Larger bodies live in R2
-- (`r2_key`) and `excerpt` keeps the first 8000 characters for search.

CREATE TABLE collections (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL REFERENCES collections(name),
  type TEXT NOT NULL CHECK (type IN ('note', 'doc', 'data')),
  title TEXT NOT NULL,
  body TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  r2_key TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_items_updated ON items (updated_at DESC, id DESC);
CREATE INDEX idx_items_collection ON items (collection, updated_at DESC);
CREATE INDEX idx_items_type ON items (type, updated_at DESC);
CREATE INDEX idx_items_author ON items (author);

CREATE VIRTUAL TABLE items_fts USING fts5 (
  title,
  body,
  tags,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, title, body, tags)
  VALUES (
    new.rowid,
    new.title,
    coalesce(new.body, new.excerpt, ''),
    new.tags
  );
END;

-- Ordinary DELETE, not the FTS5 'delete' command. That command is only for
-- contentless tables and raises "SQL logic error" on a normal FTS5 index.
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
  DELETE FROM items_fts WHERE rowid = old.rowid;
  INSERT INTO items_fts (rowid, title, body, tags)
  VALUES (
    new.rowid,
    new.title,
    coalesce(new.body, new.excerpt, ''),
    new.tags
  );
END;

INSERT INTO collections (name, description, created_at, updated_at)
VALUES (
  'inbox',
  'Default collection for items that do not name one.',
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z'
);
