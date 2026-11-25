import { describe, expect, it } from "vitest";
import { AuthFailure, authenticate, parseApiKeys } from "../src/auth.js";
import { ConfigError } from "../src/errors.js";

const KEYS = "notes:dbk_notes_token_aaaa,search:dbk_search_token_bb";

describe("parseApiKeys", () => {
  it("maps each token to its bot and allows two tokens for one bot", () => {
    const keys = parseApiKeys(`${KEYS},notes:dbk_notes_token_cccc`);
    expect(keys.get("dbk_notes_token_aaaa")).toEqual({ bot: "notes", role: "operator" });
    expect(keys.get("dbk_notes_token_cccc")).toEqual({ bot: "notes", role: "operator" });
    expect(keys.get("dbk_search_token_bb")).toEqual({ bot: "search", role: "operator" });
    expect(parseApiKeys("audit:dbk_audit_token_dddd:read").get("dbk_audit_token_dddd")).toEqual({
      bot: "audit",
      role: "read",
    });
    expect(parseApiKeys("root:dbk_root_token_eeee:admin").get("dbk_root_token_eeee")?.role).toBe("admin");
  });

  it("rejects empty, malformed, short, and duplicate tokens", () => {
    expect(() => parseApiKeys("")).toThrow(ConfigError);
    expect(() => parseApiKeys("notes")).toThrow(/name:token/);
    expect(() => parseApiKeys("notes:short")).toThrow(/at least 16/);
    expect(() => parseApiKeys("bad name:dbk_notes_token_aaaa")).toThrow(/Invalid bot name/);
    expect(() => parseApiKeys("notes:dbk_notes_token_aaaa,other:dbk_notes_token_aaaa")).toThrow(/Duplicate/);
  });
});

describe("authenticate", () => {
  it("accepts a bearer token or X-Api-Key and rejects anything else", () => {
    expect(authenticate("Bearer dbk_notes_token_aaaa", null, KEYS)).toEqual({ bot: "notes", role: "operator" });
    expect(authenticate("bearer dbk_search_token_bb", null, KEYS)).toEqual({ bot: "search", role: "operator" });
    expect(authenticate(null, "dbk_notes_token_aaaa", KEYS)).toEqual({ bot: "notes", role: "operator" });
    expect(authenticate("Bearer dbk_audit_token_dddd", null, "audit:dbk_audit_token_dddd:read").role).toBe("read");
    expect(() => authenticate(null, null, KEYS)).toThrow(AuthFailure);
    expect(() => authenticate("Bearer dbk_notes_token_aaab", null, KEYS)).toThrow(AuthFailure);
    expect(() => authenticate("Basic dbk_notes_token_aaaa", null, KEYS)).toThrow(AuthFailure);
  });
});
