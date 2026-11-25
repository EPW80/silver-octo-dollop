import { BankError } from "./errors.js";

export interface PageCursor {
  updatedAt: string;
  id: string;
}

export function encodeCursor(updatedAt: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ u: updatedAt, i: id }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeCursor(cursor: string): PageCursor {
  try {
    const pad = cursor.length % 4 === 0 ? "" : "=".repeat(4 - (cursor.length % 4));
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { u?: unknown; i?: unknown };
    if (typeof parsed.u !== "string" || typeof parsed.i !== "string" || !parsed.u || !parsed.i) {
      throw new Error("incomplete");
    }
    return { updatedAt: parsed.u, id: parsed.i };
  } catch (error) {
    if (error instanceof BankError) throw error;
    throw new BankError("Invalid cursor.", 400, "bad_cursor");
  }
}
