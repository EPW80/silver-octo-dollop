import { describe, expect, it } from "vitest";
import { EMBED_DIM, bytesToFloat32, cosine, embed, float32ToBytes } from "../src/embed.js";

describe("embed", () => {
  it("is deterministic, normalized, and ranks shared vocabulary above an unrelated note", () => {
    const revenue = embed("Quarterly revenue forecast for the EU market");
    const again = embed("Quarterly revenue forecast for the EU market");
    const related = embed("EU market revenue forecast update");
    const unrelated = embed("Sourdough starter feeding schedule");

    expect(revenue).toHaveLength(EMBED_DIM);
    expect([...revenue]).toEqual([...again]);

    let norm = 0;
    for (const value of revenue) norm += value * value;
    expect(norm).toBeCloseTo(1, 5);

    expect(cosine(revenue, related)).toBeGreaterThan(cosine(revenue, unrelated));
    expect(cosine(embed(""), embed("revenue forecast"))).toBe(0);
  });

  it("decodes the byte arrays D1 returns for blob columns", () => {
    const original = embed("shared release checklist");
    const asBytes = Array.from(float32ToBytes(original));
    const decoded = bytesToFloat32(asBytes);
    expect(decoded).not.toBeNull();
    if (!decoded) throw new Error("the stored embedding did not decode");
    expect(cosine(original, decoded)).toBeCloseTo(1, 5);
  });
});
