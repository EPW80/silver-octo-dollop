import { BankError } from "./errors.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SKU = /^[A-Z0-9][A-Z0-9._-]{0,40}$/;
const CURRENCY = /^[a-z]{3}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_.:-]{8,80}$/;
const PAYMENT_METHOD = /^pm_[A-Za-z0-9]+$/;

export function objectBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BankError("Request body must be a JSON object.", 400, "bad_body");
  }
  return input as Record<string, unknown>;
}

export function readEmail(input: unknown): string {
  if (typeof input !== "string" || !EMAIL.test(input.trim().toLowerCase())) {
    throw new BankError("A valid customer email is required.", 400, "bad_email");
  }
  return input.trim().toLowerCase();
}

export function optionalEmail(input: unknown): string {
  if (input == null || input === "") return "";
  return readEmail(input);
}

export function readSku(input: unknown): string {
  if (typeof input !== "string") throw new BankError("sku is required.", 400, "bad_sku");
  const sku = input.trim().toUpperCase();
  if (!SKU.test(sku)) {
    throw new BankError("sku must be 1-41 characters: letters, numbers, and . _ -.", 400, "bad_sku");
  }
  return sku;
}

export function readCurrency(input: unknown): string {
  if (input == null || input === "") return "usd";
  if (typeof input !== "string" || !CURRENCY.test(input.trim().toLowerCase())) {
    throw new BankError("currency must be a 3-letter code.", 400, "bad_currency");
  }
  return input.trim().toLowerCase();
}

export function readCents(input: unknown, field: string, allowZero = false): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < (allowZero ? 0 : 1) || input > 100_000_000) {
    throw new BankError(`${field} must be an integer number of cents.`, 400, "bad_amount");
  }
  return input;
}

export function readQuantity(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 100_000) {
    throw new BankError("quantity must be a positive integer.", 400, "bad_quantity");
  }
  return input;
}

export function readDelta(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input === 0 || Math.abs(input) > 100_000) {
    throw new BankError("delta must be a non-zero integer.", 400, "bad_quantity");
  }
  return input;
}

export function readIdempotencyKey(input: unknown): string {
  if (typeof input !== "string" || !IDEMPOTENCY.test(input.trim())) {
    throw new BankError("idempotency_key must be 8-80 characters: letters, numbers, and _ . : -.", 400, "bad_idempotency");
  }
  return input.trim();
}

export function readPaymentMethod(input: unknown): string | null {
  if (input == null || input === "") return null;
  if (typeof input !== "string" || !PAYMENT_METHOD.test(input)) {
    throw new BankError("payment_method must be a Stripe payment method id (pm_...). Card numbers are not accepted.", 400, "bad_payment_method");
  }
  return input;
}

export function readText(input: unknown, field: string, max: number, required = false): string {
  if (input == null || input === "") {
    if (required) throw new BankError(`${field} is required.`, 400, "bad_text");
    return "";
  }
  if (typeof input !== "string") throw new BankError(`${field} must be a string.`, 400, "bad_text");
  const text = input.trim();
  if (required && !text) throw new BankError(`${field} is required.`, 400, "bad_text");
  if (text.length > max) throw new BankError(`${field} must be at most ${max} characters.`, 400, "bad_text");
  return text;
}

export function readLimit(input: unknown, fallback: number, max: number): number {
  if (input == null || input === "") return fallback;
  const value = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BankError(`limit must be an integer from 1 to ${max}.`, 400, "bad_limit");
  }
  return value;
}

/** Reads an optional enumerated query or body value, returning null when it is absent. */
export function readEnumFilter<T extends string>(input: unknown, allowed: readonly T[], field: string): T | null {
  if (input == null || input === "") return null;
  if (typeof input !== "string" || !allowed.includes(input as T)) {
    throw new BankError(`${field} must be one of ${allowed.join(", ")}.`, 400, `bad_${field}`);
  }
  return input as T;
}
