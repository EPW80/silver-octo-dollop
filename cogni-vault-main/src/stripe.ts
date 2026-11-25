import { BankError } from "./errors.js";

export interface ChargeInput {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  description: string;
  customerEmail?: string;
  orderId?: string;
  requestId: string;
  paymentMethod: string;
}

export interface RefundInput {
  amountCents: number;
  idempotencyKey: string;
  paymentIntentId: string;
  requestId: string;
  reason?: string;
}

export type PaymentKind = "charge" | "refund";

export interface ProviderPayment {
  id: string;
  kind: PaymentKind;
  status: string;
  amountCents: number;
  currency: string;
  settledCents: number;
  requestId: string;
  paymentIntentId?: string;
}

export interface PaymentProvider {
  readonly name: string;
  charge(input: ChargeInput): Promise<ProviderPayment>;
  refund(input: RefundInput): Promise<ProviderPayment>;
  retrieve(kind: PaymentKind, id: string): Promise<ProviderPayment>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";

  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!secretKey.startsWith("sk_")) {
      throw new BankError("STRIPE_SECRET_KEY must be a Stripe secret key (sk_...).", 503, "stripe_not_configured");
    }
  }

  async charge(input: ChargeInput): Promise<ProviderPayment> {
    const body = new URLSearchParams({
      amount: String(input.amountCents),
      currency: input.currency,
      description: input.description,
      confirm: "true",
      payment_method: input.paymentMethod,
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      "metadata[request_id]": input.requestId,
    });
    if (input.orderId) body.set("metadata[order_id]", input.orderId);
    if (input.customerEmail) body.set("receipt_email", input.customerEmail);
    return this.request("charge", "/v1/payment_intents", body, input.idempotencyKey);
  }

  async refund(input: RefundInput): Promise<ProviderPayment> {
    const body = new URLSearchParams({
      payment_intent: input.paymentIntentId,
      amount: String(input.amountCents),
      "metadata[request_id]": input.requestId,
    });
    if (input.reason) body.set("metadata[reason]", input.reason.slice(0, 500));
    return this.request("refund", "/v1/refunds", body, input.idempotencyKey);
  }

  async retrieve(kind: PaymentKind, id: string): Promise<ProviderPayment> {
    if (!validProviderRef(kind, id)) throw new BankError("Invalid Stripe reference.", 400, "bad_provider_ref");
    const collection = kind === "charge" ? "payment_intents" : "refunds";
    return this.request(kind, `/v1/${collection}/${id}`);
  }

  private async request(
    kind: PaymentKind,
    path: string,
    body?: URLSearchParams,
    key?: string,
  ): Promise<ProviderPayment> {
    const headers = new Headers({ authorization: `Bearer ${this.secretKey}` });
    if (key !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      headers.set("idempotency-key", key);
    }
    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchImpl(`https://api.stripe.com${path}`, {
        method: body ? "POST" : "GET",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      payload = await stripeJson(response);
    } catch {
      throw new BankError("Stripe did not return a readable response.", 502, "stripe_error");
    }
    // Stripe can return a PaymentIntent with a payment error. Preserve the reference for a read-only retry.
    const candidate = response.ok ? payload : record(record(payload)?.error)?.payment_intent;
    const result = parsePayment(kind, candidate);
    if (result) return result;
    throw new BankError(
      response.ok ? "Stripe returned an incomplete payment." : `Stripe returned HTTP ${response.status}.`,
      502,
      "stripe_error",
    );
  }
}

export function validProviderRef(kind: PaymentKind, id: string): boolean {
  return (kind === "charge" ? /^pi_[A-Za-z0-9_]{1,120}$/ : /^re_[A-Za-z0-9_]{1,120}$/).test(id);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parsePayment(kind: PaymentKind, value: unknown): ProviderPayment | null {
  const row = record(value);
  if (!row || row.object !== (kind === "charge" ? "payment_intent" : "refund")) return null;
  const { id, status, amount, currency } = row;
  const requestId = record(row.metadata)?.request_id;
  const settled = kind === "charge" ? row.amount_received : status === "succeeded" ? amount : 0;
  if (
    typeof id !== "string" || !validProviderRef(kind, id) || typeof status !== "string" ||
    typeof amount !== "number" || !Number.isSafeInteger(amount) || typeof currency !== "string" ||
    typeof requestId !== "string" || typeof settled !== "number" || !Number.isSafeInteger(settled)
  ) return null;
  return {
    id, kind, status, amountCents: amount, currency, settledCents: settled, requestId,
    paymentIntentId: typeof row.payment_intent === "string" ? row.payment_intent : undefined,
  };
}

async function stripeJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty Stripe response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) {
        await reader.cancel();
        throw new Error("Stripe response exceeds 128 KiB");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
