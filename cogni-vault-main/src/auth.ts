import { BankError, ConfigError } from "./errors.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MIN_TOKEN = 16;

export type Role = "read" | "operator" | "admin";

const RANK: Record<Role, number> = { read: 1, operator: 2, admin: 3 };

export interface Actor {
  bot: string;
  role: Role;
}

/** token -> bot. Several tokens may share one bot name. A missing role defaults to operator. */
export function parseApiKeys(raw: string | undefined): Map<string, Actor> {
  if (!raw?.trim()) {
    throw new ConfigError("API_KEYS is empty.");
  }

  const keys = new Map<string, Actor>();
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new ConfigError("API_KEYS is empty.");

  for (const part of parts) {
    const { name, token, role } = splitKey(part);
    if (!NAME.test(name)) {
      throw new ConfigError(`Invalid bot name "${name}". Use letters, numbers, ".", "_" or "-".`);
    }
    if (token.length < MIN_TOKEN || /[\s,:]/.test(token)) {
      throw new ConfigError(
        `Token for ${name} must be at least ${MIN_TOKEN} characters and contain no spaces, commas, or colons.`,
      );
    }
    if (keys.has(token)) throw new ConfigError("Duplicate token in API_KEYS.");
    keys.set(token, { bot: name, role });
  }

  return keys;
}

export function assertRole(actor: Actor, minimum: Role): void {
  if (RANK[actor.role] < RANK[minimum]) {
    throw new BankError(`This action requires the ${minimum} role.`, 403, "forbidden");
  }
}

function splitKey(part: string): { name: string; token: string; role: Role } {
  let role: Role = "operator";
  let rest = part;
  const roleMatch = /:(read|operator|admin)$/.exec(part);
  if (roleMatch) {
    role = roleMatch[1] as Role;
    rest = part.slice(0, -roleMatch[0].length);
  }
  const splitAt = rest.indexOf(":");
  if (splitAt <= 0) {
    throw new ConfigError("Each API_KEYS entry must look like name:token or name:token:role.");
  }
  return { name: rest.slice(0, splitAt).trim(), token: rest.slice(splitAt + 1).trim(), role };
}

export function authenticate(header: string | null, apiKeyHeader: string | null, rawKeys: string | undefined): Actor {
  const keys = parseApiKeys(rawKeys);
  const presented = bearerToken(header) ?? apiKeyHeader?.trim() ?? "";
  if (!presented) {
    throw new AuthFailure();
  }

  let actor: Actor | null = null;
  for (const [token, record] of keys) {
    if (timingSafeEqual(token, presented)) actor = record;
  }
  if (!actor) throw new AuthFailure();
  return actor;
}

export class AuthFailure extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthFailure";
  }
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
