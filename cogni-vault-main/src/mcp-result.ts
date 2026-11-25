import { BankError } from "./errors.js";

/** The response shapes every MCP tool returns. Kept in one place so both tool modules agree. */
export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

export async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (error) {
    if (!(error instanceof BankError)) console.error(error);
    return fail(error instanceof BankError ? error.message : "Internal error");
  }
}
