import { describe, expect, it } from "vitest";
import anchorData from "../../src/hashline/anchor-table.json";
import { ANCHOR_COUNT, HASH_LEN, anchorAt } from "../../src/hashline/alphabet";

const TABLE: string = anchorData.anchors;

describe("anchor table", () => {
  it("has the frozen size", () => {
    expect(TABLE.length).toBe(1353139 * 4);
    expect(ANCHOR_COUNT).toBe(1353139);
    expect(HASH_LEN).toBe(4);
  });

  it("contains only unique 4-letter anchors in sorted order", () => {
    const anchors = TABLE.match(/[A-Za-z]{4}/g) ?? [];
    expect(anchors).toHaveLength(ANCHOR_COUNT);
    expect(new Set(anchors).size).toBe(ANCHOR_COUNT);
    expect(anchors.every((a, i) => i === 0 || anchors[i - 1]! < a)).toBe(true);
  });

  it("is letters only", () => {
    expect(TABLE).toMatch(/^[A-Za-z]+$/);
  });

  it("is built from a shared 1360-piece alphabet", () => {
    const heads = new Set<string>();
    const tails = new Set<string>();
    for (let i = 0; i < ANCHOR_COUNT; i++) {
      heads.add(anchorAt(i).slice(0, 2));
      tails.add(anchorAt(i).slice(2));
    }
    expect(heads.size).toBe(1360);
    expect(tails.size).toBe(1360);
    expect(heads).toEqual(tails);
  });
});
