import { BankError } from "./errors.js";

export const MAX_BODY_BYTES = 1_500_000;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id, x-api-key",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

export function empty(status: number, extra?: HeadersInit): Response {
  return new Response(null, { status, headers: extra });
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof BankError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof URIError) {
    return json({ error: "The URL contains invalid percent-encoding.", code: "bad_path" }, 400);
  }
  console.error(error);
  return json({ error: "Internal error", code: "internal" }, 500);
}

/** Decodes one URL path segment, turning malformed percent-encoding into a 400 instead of a 500. */
export function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BankError("The URL contains invalid percent-encoding.", 400, "bad_path");
  }
}

export async function readJson(request: Request, allowEmpty = false): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BankError("Request body is too large.", 413, "too_large");
  }
  const text = await request.text();
  if (byteSize(text) > MAX_BODY_BYTES) {
    throw new BankError("Request body is too large.", 413, "too_large");
  }
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new BankError("Request body must be a JSON object.", 400, "bad_body");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BankError("Request body must be valid JSON.", 400, "bad_json");
  }
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
