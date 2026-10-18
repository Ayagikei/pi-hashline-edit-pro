import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdir, open, readFile, rm, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import {
  initRegistry,
  resetRegistryForTests,
  allocateAnchor,
  freeAnchors,
  clearRegistry,
  ownerOf,
  ownersForPath,
  servedForPath,
  markServed,
  markServed as markServedScoped,
  adoptAnchors,
  alignOwnership,
  alignOwnershipWithSpans,
  readSidecarHeader,
  readSidecarSessionFile,
  SIDECAR_HEADER_BYTES,
  parseRegistryLog,
  foldRegistryEvents,
  mintAnchor,
  gcRegistrySidecars,
  sessionKeyFor,
  releaseRegistrySession,
  shadowStateFrom,
  withAnchorSession,
} from "../../src/anchor-registry";
import { sessionClaimsDir } from "../../src/paths";
import { lineHashes } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

useTestHome();

beforeEach(async () => {
  await initRegistry(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRegistryForTests();
});

function oversizedAllocateLine(): string {
  const row = JSON.stringify(["abcd", "0123456789abcdef"]);
  const rowCount = Math.ceil((SIDECAR_HEADER_BYTES + 1024) / (Buffer.byteLength(row, "utf-8") + 1));
  return JSON.stringify({
    kind: "allocate",
    path: "/example.txt",
    rows: Array.from({ length: rowCount }, () => ["abcd", "0123456789abcdef"]),
  });
}

describe("anchor registry", () => {
  it("allocates unique well-formed anchors within a session", () => {
    const first = allocateAnchor("a.ts", "ck0");
    const second = allocateAnchor("b.ts", "ck1");
    const third = allocateAnchor("c.ts", "ck2");
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toMatch(/^[A-Za-z]{4}$/);
  });

  it("does not repeat the mint sequence after an ephemeral re-init", async () => {
    const first = allocateAnchor("a.ts", "ck0");
    resetRegistryForTests();
    await initRegistry(undefined);
    expect(allocateAnchor("a.ts", "ck0")).not.toBe(first);
  });

  it("mints disjoint anchor sequences across sessions", async () => {
    const sessionA = join(sessionClaimsDir(), "session-a.json");
    const sessionB = join(sessionClaimsDir(), "session-b.json");
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionA, "", "utf-8");
    await writeFile(sessionB, "", "utf-8");
    await initRegistry(sessionA);
    const spent = new Set<string>();
    for (let i = 0; i < 200; i++) spent.add(allocateAnchor("a.ts", `ck${i}`));
    await initRegistry(sessionB);
    for (let i = 0; i < 200; i++) {
      expect(spent.has(allocateAnchor("b.ts", `ck${i}`))).toBe(false);
    }
  });

  it("does not re-mint folded anchors after a same-session restart", async () => {
    const sessionFile = join(sessionClaimsDir(), "restart.json");
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    await initRegistry(sessionFile);
    const spent = new Set<string>();
    for (let i = 0; i < 50; i++) spent.add(allocateAnchor("a.ts", `ck${i}`));
    resetRegistryForTests();
    await initRegistry(sessionFile);
    for (let i = 0; i < 50; i++) {
      expect(spent.has(allocateAnchor("a.ts", `ck${i}`))).toBe(false);
    }
  });

  it("starts the mint walk from the given seed", () => {
    const first = mintAnchor(foldRegistryEvents([], "seed-one"));
    const second = mintAnchor(foldRegistryEvents([], "seed-two"));
    expect(first).not.toBe(second);
    expect(mintAnchor(foldRegistryEvents([], "seed-one"))).toBe(first);
  });

  it("throws E_REGISTRY when allocating without an initialized session", async () => {
    resetRegistryForTests();
    expect(() => allocateAnchor("a.ts", "ck")).toThrow(/E_REGISTRY/);
    await initRegistry(undefined);
    expect(allocateAnchor("a.ts", "ck")).toMatch(/^[A-Za-z]{4}$/);
  });

  it("never mints an owned anchor", () => {
    const a = allocateAnchor("a.ts", "ck1");
    for (let i = 0; i < 50; i++) {
      expect(allocateAnchor("b.ts", `ck${i}`)).not.toBe(a);
    }
  });

  it("frees per anchor and per path, clearing served state", () => {
    const a = allocateAnchor("a.ts", "ckA");
    const b = allocateAnchor("a.ts", "ckB");
    const c = allocateAnchor("other.ts", "ckC");
    markServed("a.ts", [[a, "ckA"], [b, "ckB"]]);
    expect(servedForPath("a.ts")!.has(a)).toBe(true);

    freeAnchors("a.ts", [a]);
    expect(ownerOf(a)).toBeUndefined();
    expect(servedForPath("a.ts")!.has(a)).toBe(false);
    expect(servedForPath("a.ts")!.has(b)).toBe(true);
    expect(ownerOf(c)).toBeDefined();

    freeAnchors("a.ts");
    expect(ownerOf(b)).toBeUndefined();
    expect(servedForPath("a.ts")).toBeUndefined();
  });

  it("merges and scopes the served record", () => {
    markServed("a.ts", [["AAAA", "ck1"], ["BBBB", "ck2"]]);
    markServedScoped("a.ts", [["CCCC", "ck3"]], new Set(["AAAA", "CCCC"]));
    const served = servedForPath("a.ts")!;
    expect(served.get("AAAA")).toBe("ck1");
    expect(served.has("BBBB")).toBe(false);
    expect(served.get("CCCC")).toBe("ck3");
  });

  it("adopts error feedback anchors as owned and served", () => {
    adoptAnchors("a.ts", new Map([["AAAA", "ck1"]]));
    expect(ownerOf("AAAA")).toEqual({ path: "a.ts", checksum: "ck1" });
    expect(servedForPath("a.ts")!.get("AAAA")).toBe("ck1");
  });

  it("clears ownership and served state on /clear-anchors", () => {
    const a = allocateAnchor("a.ts", "ck");
    clearRegistry();
    expect(ownerOf(a)).toBeUndefined();
    expect(ownersForPath("a.ts").size).toBe(0);
    expect(servedForPath("a.ts")).toBeUndefined();
  });

  it("maps spans positionally, keeping unchanged span lines", () => {
    const a1 = allocateAnchor("a.ts", "ckA");
    const a2 = allocateAnchor("a.ts", "ckB");
    const a3 = allocateAnchor("a.ts", "ckC");
    const a4 = allocateAnchor("a.ts", "ckD");
    const aligned = alignOwnershipWithSpans(
      "a.ts",
      [a1, a2, a3, a4],
      ["ckA", "ckB", "ckC", "ckD"],
      ["ckA", "ckB", "ckX", "ckY", "ckD"],
      [{ start: 1, end: 2, replacementCount: 3 }],
    );
    expect(aligned.anchors).toEqual([a1, a2, aligned.minted[0], aligned.minted[1], a4]);
  });

  it("mints fresh anchors for replaced lines without content-based reuse", () => {
    const a1 = allocateAnchor("a.ts", "ckA");
    const a2 = allocateAnchor("a.ts", "ckB");
    const a3 = allocateAnchor("a.ts", "ckC");
    const aligned = alignOwnershipWithSpans(
      "a.ts",
      [a1, a2, a3],
      ["ckA", "ckB", "ckC"],
      ["ckA", "ckC", "ckB", "ckC"],
      [{ start: 1, end: 2, replacementCount: 3 }],
    );
    expect(aligned.anchors[0]).toBe(a1);
    expect(aligned.minted).toHaveLength(3);
    for (const mint of aligned.minted) {
      expect([a1, a2, a3].indexOf(mint) < 0).toBe(true);
    }
    expect(new Set(aligned.anchors).size).toBe(aligned.anchors.length);
  });

  it("keeps positional anchors without minting over them", () => {
    const a1 = allocateAnchor("a.ts", "ck1");
    const a2 = allocateAnchor("a.ts", "ckB");
    const a3 = allocateAnchor("a.ts", "ckB2");
    const a4 = allocateAnchor("a.ts", "ck4");
    const aligned = alignOwnershipWithSpans(
      "a.ts",
      [a1, a2, a3, a4],
      ["ck1", "ckB", "ckB2", "ck4"],
      ["ck1", "ckB2", "ckB2", "ckZ", "ck4"],
      [{ start: 1, end: 2, replacementCount: 3 }],
    );
    expect(new Set(aligned.anchors).size).toBe(aligned.anchors.length);
    expect(aligned.anchors[0]).toBe(a1);
    expect(aligned.anchors[4]).toBe(a4);
    expect(aligned.minted.every((m) => [a1, a2, a3, a4].indexOf(m) < 0)).toBe(true);
  });

  it("maps shadow allocations identically to real allocations", () => {
    const a1 = allocateAnchor("m.ts", "ckA");
    const a2 = allocateAnchor("m.ts", "ckB");
    const a3 = allocateAnchor("m.ts", "ckC");
    const span = [{ start: 1, end: 1, replacementCount: 1 }];
    const before = [...ownersForPath("m.ts").entries()];
    const shadow = alignOwnershipWithSpans("m.ts", [a1, a2, a3], ["ckA", "ckB", "ckC"], ["ckA", "ckX", "ckC"], span, { shadow: true });
    expect([...ownersForPath("m.ts").entries()]).toEqual(before);
    const real = alignOwnershipWithSpans("m.ts", [a1, a2, a3], ["ckA", "ckB", "ckC"], ["ckA", "ckX", "ckC"], span);
    expect(shadow.anchors).toEqual(real.anchors);
    expect(shadow.minted).toEqual(real.minted);
    expect(shadow.freed).toEqual(real.freed);
  });

  it("maps shadow diff alignments identically to real alignments", () => {
    const a1 = allocateAnchor("d.ts", "ckA");
    const a2 = allocateAnchor("d.ts", "ckB");
    const a3 = allocateAnchor("d.ts", "ckC");
    const before = [...ownersForPath("d.ts").entries()];
    const shadow = alignOwnership("d.ts", [a1, a2, a3], ["ckA", "ckB", "ckC"], ["ckA", "ckX", "ckC"], { shadow: true });
    expect([...ownersForPath("d.ts").entries()]).toEqual(before);
    const real = alignOwnership("d.ts", [a1, a2, a3], ["ckA", "ckB", "ckC"], ["ckA", "ckX", "ckC"]);
    expect(shadow.anchors).toEqual(real.anchors);
    expect(shadow.minted).toEqual(real.minted);
    expect(shadow.freed).toEqual(real.freed);
  });

  it("shadows session state without mutating the real registry", () => {
    const real = foldRegistryEvents(parseRegistryLog([
      '{"kind":"allocate","path":"s.ts","rows":[["AaAa","ckA"]]}',
      '{"kind":"minted","anchors":["BbBb"]}',
    ].join("\n")));
    const shadow = shadowStateFrom(real);
    expect(shadow.served.size).toBe(0);
    expect(shadow.owned.get("AaAa")).toEqual({ path: "s.ts", checksum: "ckA" });
    shadow.owned.set("AaAa", { path: "t.ts", checksum: "ckZ" });
    expect(shadow.owned.get("AaAa")).toEqual({ path: "t.ts", checksum: "ckZ" });
    expect(real.owned.get("AaAa")).toEqual({ path: "s.ts", checksum: "ckA" });
    shadow.owned.set("CcCc", { path: "s.ts", checksum: "ckC" });
    expect(shadow.owned.delete("AaAa")).toBe(true);
    expect(shadow.owned.delete("ZzZz")).toBe(false);
    expect(shadow.owned.has("AaAa")).toBe(false);
    expect(real.owned.has("AaAa")).toBe(true);
    expect(shadow.owned.size).toBe(1);
    expect([...shadow.owned.keys()]).toEqual(["CcCc"]);
    expect([...shadow.owned.values()]).toEqual([{ path: "s.ts", checksum: "ckC" }]);
    expect([...shadow.owned.entries()]).toEqual([["CcCc", { path: "s.ts", checksum: "ckC" }]]);
    shadow.owned.clear();
    expect(shadow.owned.size).toBe(0);
    expect(real.owned.size).toBe(1);
    expect(shadow.everMinted.has("BbBb")).toBe(true);
    shadow.everMinted.add("DdDd");
    expect(real.everMinted.has("DdDd")).toBe(false);
    expect([...shadow.everMinted]).toEqual(["AaAa", "BbBb", "DdDd"]);
  });

  it("parses and folds the ownership log", () => {
    const events = parseRegistryLog([
      '{"kind":"allocate","path":"a.ts","rows":[["AAAA","ck1"]]}',
      "not json",
      '{"kind":"free","path":"a.ts","anchors":["AAAA"]}',
      '{"kind":"clear"}',
    ].join("\n"));
    expect(events).toHaveLength(3);
    const state = foldRegistryEvents(events);
    expect(state.owned.size).toBe(0);
  });

  it("skips malformed sidecar events instead of crashing", () => {
    const events = parseRegistryLog([
      '{"kind":"allocate","path":"a.ts"}',
      '{"kind":"free","path":"a.ts","anchors":5}',
      '{"kind":"minted"}',
      '{"kind":"allocate","path":"a.ts","rows":[["AAAA","ck1"]]}',
    ].join("\n"));
    expect(events).toEqual([{ kind: "allocate", path: "a.ts", rows: [["AAAA", "ck1"]] }]);
    expect(foldRegistryEvents(events).owned.get("AAAA")).toEqual({ path: "a.ts", checksum: "ck1" });
    expect(() => foldRegistryEvents([{ kind: "allocate", path: "a.ts" } as never])).not.toThrow();
    expect(() => foldRegistryEvents([{ kind: "free", path: "a.ts", anchors: 5 } as never])).not.toThrow();
  });

  it("restores ownership and served state from a sidecar log", async () => {
    const sessionFile = join(sessionClaimsDir(), "session.jsonl");
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    await initRegistry(sessionFile);
    const anchor = allocateAnchor("restored.ts", "ckR");
    markServed("restored.ts", [[anchor, "ckR"]]);

    const sidecarKey = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecarPath = join(sessionClaimsDir(), `${sidecarKey}.registry.jsonl`);
    const log = await readFile(sidecarPath, "utf-8");
    expect(parseRegistryLog(log).some((e) => e.kind === "allocate")).toBe(true);

    resetRegistryForTests();
    await initRegistry(sessionFile);
    expect(ownerOf(anchor)).toEqual({ path: "restored.ts", checksum: "ckR" });
    expect(servedForPath("restored.ts")!.get(anchor)).toBe("ckR");
  });

  it("garbage-collects sidecars whose session file is gone", async () => {
    const sessionFile = join(sessionClaimsDir(), "live.jsonl");
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    await initRegistry(sessionFile);
    const deadSession = join(sessionClaimsDir(), "dead.jsonl");
    await initRegistry(deadSession);
    const deadKey = createHash("sha256").update(deadSession).digest("hex").slice(0, 24);
    const deadSidecar = join(sessionClaimsDir(), `${deadKey}.registry.jsonl`);
    await expect(readFile(deadSidecar, "utf-8")).resolves.toContain("session");
    resetRegistryForTests();
    await gcRegistrySidecars();
    await expect(readFile(deadSidecar, "utf-8")).rejects.toThrow();
    await expect(readFile(sessionFile, "utf-8")).resolves.toBe("");
  });

  it("keeps a loaded session's sidecar while its session file is missing", async () => {
    const sessionFile = join(sessionClaimsDir(), "pending.jsonl");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    await mkdir(sessionClaimsDir(), { recursive: true });
    await initRegistry(sessionFile);
    await gcRegistrySidecars();
    await expect(readFile(sidecar, "utf-8")).resolves.toContain("session");
  });

  it("recreates a missing sidecar with the session header first", async () => {
    const sessionFile = join(sessionClaimsDir(), "recreate.jsonl");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    await initRegistry(sessionFile);
    await rm(sidecar, { force: true });
    allocateAnchor("recreated.ts", "ckR");
    const lines = (await readFile(sidecar, "utf-8")).split("\n");
    const first = JSON.parse(lines[0]!) as { kind?: string; sessionFile?: string };
    const second = JSON.parse(lines[1]!) as { kind?: string };
    expect(first.kind).toBe("session");
    expect(first.sessionFile).toBe(sessionFile);
    expect(second.kind).toBe("allocate");
  });

  it("recreates an empty sidecar with the session header first", async () => {
    const sessionFile = join(sessionClaimsDir(), "recreate-empty.jsonl");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    await initRegistry(sessionFile);
    await writeFile(sidecar, "", "utf-8");
    allocateAnchor("recreated.ts", "ckE");
    const first = JSON.parse((await readFile(sidecar, "utf-8")).split("\n")[0]!) as { kind?: string };
    expect(first.kind).toBe("session");
  });

  it("reads a sidecar header longer than one read chunk", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "long-header.registry.jsonl");
    const normal = JSON.stringify({ kind: "session", sessionFile: join(sessionClaimsDir(), "header-live.jsonl") });
    const long = JSON.stringify({ kind: "session", sessionFile: "x".repeat(20000) });
    await writeFile(sidecar, `${normal}\n`, "utf-8");
    await expect(readSidecarHeader(sidecar)).resolves.toBe(normal);
    await writeFile(sidecar, `${long}\n`, "utf-8");
    await expect(readSidecarHeader(sidecar)).resolves.toBe(long);
  });

  it("reads a short sidecar header without a trailing newline", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "no-newline-header.registry.jsonl");
    const header = JSON.stringify({ kind: "session", sessionFile: join(sessionClaimsDir(), "no-newline-live.jsonl") });
    await writeFile(sidecar, header, "utf-8");
    await expect(readSidecarHeader(sidecar)).resolves.toBe(header);
  });

  it("returns an empty header when the first line exceeds the read cap", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "oversized-header.registry.jsonl");
    const oversized = oversizedAllocateLine();
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, `${oversized}\n`, "utf-8");
    await expect(readSidecarHeader(sidecar)).resolves.toBe("");
  });

  it("keeps a sidecar with an unreadable oversized header when gc runs", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "oversized-gc.registry.jsonl");
    await writeFile(sidecar, `${oversizedAllocateLine()}\n`, "utf-8");
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    await gcRegistrySidecars();
    expect(errors.some((args) => args.some((arg) => arg instanceof SyntaxError))).toBe(false);
    await expect(readFile(sidecar, "utf-8")).resolves.toContain("allocate");
  });

  it("finds a session header on a later line within the header window", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "later-session.registry.jsonl");
    const allocate = JSON.stringify({ kind: "allocate", path: "/a.ts", rows: [["abcd", "ck"]] });
    const session = JSON.stringify({ kind: "session", sessionFile: "/later-live.jsonl" });
    await writeFile(sidecar, `${allocate}\n${session}\n`, "utf-8");
    await expect(readSidecarSessionFile(sidecar)).resolves.toBe("/later-live.jsonl");
  });

  it("returns undefined when the session header sits past the read cap", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "beyond-cap.registry.jsonl");
    const session = JSON.stringify({ kind: "session", sessionFile: "/beyond-live.jsonl" });
    await writeFile(sidecar, `${oversizedAllocateLine()}\n${session}\n`, "utf-8");
    await expect(readSidecarSessionFile(sidecar)).resolves.toBeUndefined();
  });

  it("tolerates a truncated trailing line during gc without a SyntaxError", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "truncated-tail.registry.jsonl");
    await writeFile(sidecar, `${"x".repeat(SIDECAR_HEADER_BYTES * 2)}\n`, "utf-8");
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    await expect(readSidecarSessionFile(sidecar)).resolves.toBeUndefined();
    await gcRegistrySidecars();
    expect(errors.some((args) => args.some((arg) => arg instanceof SyntaxError))).toBe(false);
    await expect(readFile(sidecar, "utf-8")).resolves.toContain("x");
  });

  it("garbage-collects a dead sidecar whose session header is not the first line", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "second-line-dead.registry.jsonl");
    const allocate = JSON.stringify({ kind: "allocate", path: "/a.ts", rows: [["abcd", "ck"]] });
    const session = JSON.stringify({ kind: "session", sessionFile: join(sessionClaimsDir(), "second-line-gone.jsonl") });
    await writeFile(sidecar, `${allocate}\n${session}\n`, "utf-8");
    await gcRegistrySidecars();
    await expect(readFile(sidecar, "utf-8")).rejects.toThrow();
  });

  it("keeps a live sidecar whose session header is not the first line", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const liveSession = join(sessionClaimsDir(), "second-line-live.jsonl");
    await writeFile(liveSession, "", "utf-8");
    const sidecar = join(sessionClaimsDir(), "second-line-live.registry.jsonl");
    const allocate = JSON.stringify({ kind: "allocate", path: "/a.ts", rows: [["abcd", "ck"]] });
    const session = JSON.stringify({ kind: "session", sessionFile: liveSession });
    await writeFile(sidecar, `${allocate}\n${session}\n`, "utf-8");
    await gcRegistrySidecars();
    await expect(readFile(sidecar, "utf-8")).resolves.toContain("allocate");
  });

  it("normalizes a legacy sidecar so its session header becomes the first line", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sessionFile = join(sessionClaimsDir(), "normalize.jsonl");
    await writeFile(sessionFile, "", "utf-8");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    const allocate = JSON.stringify({ kind: "allocate", path: "/legacy.ts", rows: [["abcd", "ck"]] });
    await writeFile(sidecar, `${allocate}\n`, "utf-8");
    await initRegistry(sessionFile);
    expect(ownerOf("abcd")).toEqual({ path: "/legacy.ts", checksum: "ck" });
    const firstLine = (await readFile(sidecar, "utf-8")).split("\n")[0]!;
    const parsed = JSON.parse(firstLine) as { kind?: string; sessionFile?: string };
    expect(parsed.kind).toBe("session");
    expect(parsed.sessionFile).toBe(sessionFile);
  });

  it("reclaims a normalized sidecar once its session file is gone", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sessionFile = join(sessionClaimsDir(), "reclaim.jsonl");
    await writeFile(sessionFile, "", "utf-8");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    const allocate = JSON.stringify({ kind: "allocate", path: "/legacy.ts", rows: [["abcd", "ck"]] });
    await writeFile(sidecar, `${allocate}\n`, "utf-8");
    await initRegistry(sessionFile);
    resetRegistryForTests();
    await rm(sessionFile, { force: true });
    await gcRegistrySidecars();
    await expect(readFile(sidecar, "utf-8")).rejects.toThrow();
  });

  it("releases a session's in-memory registry", async () => {
    const sessionFile = join(sessionClaimsDir(), "release.jsonl");
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    const ctx = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "release" } };
    const anchor = await withAnchorSession(ctx, () => allocateAnchor("release.ts", "ckR"));
    const key = sessionKeyFor(ctx)!;
    await rm(join(sessionClaimsDir(), `${key}.registry.jsonl`), { force: true });
    releaseRegistrySession(key);
    expect(await withAnchorSession(ctx, () => ownerOf(anchor))).toBeUndefined();
  });

  it("does not resurrect a released session when its load finishes", async () => {
    const sessionFile = join(sessionClaimsDir(), "race.jsonl");
    const ctx = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "race" } };
    const key = sessionKeyFor(ctx)!;
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    await writeFile(sidecar, "", "utf-8");
    const loading = withAnchorSession(ctx, () => undefined);
    releaseRegistrySession(key);
    await loading;
    expect(await readFile(sidecar, "utf-8")).toBe("");
  });

  it("rebuilds a released session's ownership from its sidecar", async () => {
    const sessionFile = join(sessionClaimsDir(), "rebuild.jsonl");
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    const ctx = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "rebuild" } };
    const anchor = await withAnchorSession(ctx, () => allocateAnchor("rebuild.ts", "ckR"));
    markServed("rebuild.ts", [[anchor, "ckR"]]);
    releaseRegistrySession(sessionKeyFor(ctx)!);
    expect(await withAnchorSession(ctx, () => ownerOf(anchor))).toEqual({ path: "rebuild.ts", checksum: "ckR" });
    expect(await withAnchorSession(ctx, () => servedForPath("rebuild.ts")!.get(anchor))).toBe("ckR");
  });

  it("scopes ownership to the calling session", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sessionA = join(sessionClaimsDir(), "scope-a.jsonl");
    const sessionB = join(sessionClaimsDir(), "scope-b.jsonl");
    await writeFile(sessionA, "", "utf-8");
    await writeFile(sessionB, "", "utf-8");
    const ctxA = { sessionManager: { getSessionFile: () => sessionA, getSessionId: () => "scope-a" } };
    const ctxB = { sessionManager: { getSessionFile: () => sessionB, getSessionId: () => "scope-b" } };

    const anchorA = await withAnchorSession(ctxA, () => allocateAnchor("a.ts", "ckA"));
    const anchorB = await withAnchorSession(ctxB, () => allocateAnchor("b.ts", "ckB"));

    expect(await withAnchorSession(ctxA, () => ownerOf(anchorA))).toEqual({ path: "a.ts", checksum: "ckA" });
    expect(await withAnchorSession(ctxA, () => ownerOf(anchorB))).toBeUndefined();
    expect(await withAnchorSession(ctxB, () => ownerOf(anchorB))).toEqual({ path: "b.ts", checksum: "ckB" });
    expect(await withAnchorSession(ctxB, () => ownerOf(anchorA))).toBeUndefined();
  });

  it("routes registry events to the calling session sidecar", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sessionA = join(sessionClaimsDir(), "route-a.jsonl");
    const sessionB = join(sessionClaimsDir(), "route-b.jsonl");
    await writeFile(sessionA, "", "utf-8");
    await writeFile(sessionB, "", "utf-8");
    const ctxA = { sessionManager: { getSessionFile: () => sessionA, getSessionId: () => "route-a" } };
    const ctxB = { sessionManager: { getSessionFile: () => sessionB, getSessionId: () => "route-b" } };

    await withAnchorSession(ctxA, () => allocateAnchor("a.ts", "ckA"));
    await withAnchorSession(ctxB, () => allocateAnchor("b.ts", "ckB"));

    const logA = parseRegistryLog(await readFile(join(sessionClaimsDir(), `${sessionKeyFor(ctxA)!}.registry.jsonl`), "utf-8"));
    const logB = parseRegistryLog(await readFile(join(sessionClaimsDir(), `${sessionKeyFor(ctxB)!}.registry.jsonl`), "utf-8"));
    expect(logA.some((e) => e.kind === "allocate" && e.path === "a.ts")).toBe(true);
    expect(logA.some((e) => e.kind === "allocate" && e.path === "b.ts")).toBe(false);
    expect(logB.some((e) => e.kind === "allocate" && e.path === "b.ts")).toBe(true);
    expect(logB.some((e) => e.kind === "allocate" && e.path === "a.ts")).toBe(false);
  });

  it("initializes a session once per process", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sessionFile = join(sessionClaimsDir(), "once.jsonl");
    const ctx = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "once" } };
    const anchor = await withAnchorSession(ctx, () => allocateAnchor("a.ts", "ck"));
    await withAnchorSession(ctx, () => undefined);
    await withAnchorSession(ctx, () => undefined);
    expect(await withAnchorSession(ctx, () => ownerOf(anchor))).toEqual({ path: "a.ts", checksum: "ck" });
    const sessions = parseRegistryLog(await readFile(join(sessionClaimsDir(), `${sessionKeyFor(ctx)!}.registry.jsonl`), "utf-8")).filter((e) => e.kind === "session");
    expect(sessions).toHaveLength(1);
  });

  it("shares one initialization across concurrent first calls", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sessionFile = join(sessionClaimsDir(), "concurrent.jsonl");
    const ctx = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "concurrent" } };
    const [first, second] = await Promise.all([
      withAnchorSession(ctx, () => allocateAnchor("a.ts", "ckA")),
      withAnchorSession(ctx, () => allocateAnchor("b.ts", "ckB")),
    ]);
    expect(first).not.toBe(second);
    expect(ownerOf(first)).toEqual({ path: "a.ts", checksum: "ckA" });
    expect(ownerOf(second)).toEqual({ path: "b.ts", checksum: "ckB" });
    const sessions = parseRegistryLog(await readFile(join(sessionClaimsDir(), `${sessionKeyFor(ctx)!}.registry.jsonl`), "utf-8")).filter((e) => e.kind === "session");
    expect(sessions).toHaveLength(1);
  });

  it("persists adopted anchors so a restart restores them", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sessionA = join(sessionClaimsDir(), "adopt-a.jsonl");
    const sessionB = join(sessionClaimsDir(), "adopt-b.jsonl");
    await writeFile(sessionA, "", "utf-8");
    await writeFile(sessionB, "", "utf-8");
    const ctxA = { sessionManager: { getSessionFile: () => sessionA, getSessionId: () => "adopt-a" } };
    const ctxB = { sessionManager: { getSessionFile: () => sessionB, getSessionId: () => "adopt-b" } };
    const filePath = join(sessionClaimsDir(), "adopted.txt");
    const content = "alpha\nbeta\ngamma\n";

    const anchorsA = await withAnchorSession(ctxA, () => lineHashes(content, filePath));
    resetRegistryForTests();
    const anchorsB = await withAnchorSession(ctxB, () => lineHashes(content, filePath));
    expect(anchorsB).toEqual(anchorsA);

    resetRegistryForTests();
    await initRegistry(sessionB);
    for (const anchor of anchorsB) {
      expect(ownerOf(anchor)).toEqual({ path: filePath, checksum: expect.any(String) });
    }
  });

  it("isolates file-less sessions by session id", async () => {
    const ctxA = { sessionManager: { getSessionId: () => "ephemeral-a" } };
    const ctxB = { sessionManager: { getSessionId: () => "ephemeral-b" } };
    const anchorA = await withAnchorSession(ctxA, () => allocateAnchor("a.ts", "ckA"));
    const anchorB = await withAnchorSession(ctxB, () => allocateAnchor("b.ts", "ckB"));
    expect(anchorA).not.toBe(anchorB);
    expect(await withAnchorSession(ctxA, () => ownerOf(anchorA))).toBeDefined();
    expect(await withAnchorSession(ctxA, () => ownerOf(anchorB))).toBeUndefined();
  });

  it("treats an empty session file as file-less", async () => {
    const ctxA = { sessionManager: { getSessionFile: () => "", getSessionId: () => "empty-file-a" } };
    const ctxB = { sessionManager: { getSessionFile: () => "", getSessionId: () => "empty-file-b" } };
    const anchorA = await withAnchorSession(ctxA, () => allocateAnchor("a.ts", "ckA"));
    const anchorB = await withAnchorSession(ctxB, () => allocateAnchor("b.ts", "ckB"));
    expect(await withAnchorSession(ctxA, () => ownerOf(anchorA))).toBeDefined();
    expect(await withAnchorSession(ctxA, () => ownerOf(anchorB))).toBeUndefined();
  });

  it("never moves an owned anchor to another file", () => {
    const anchor = allocateAnchor("a.ts", "ckA");
    adoptAnchors("b.ts", new Map([[anchor, "ckB"]]));
    expect(ownerOf(anchor)).toEqual({ path: "a.ts", checksum: "ckA" });
    expect(servedForPath("b.ts")?.has(anchor) ?? false).toBe(false);
  });
});


const SIDECAR_HEADER_CHUNK = 4096;

async function bytesReadBySidecar(run: () => Promise<void>): Promise<number> {
  await mkdir(sessionClaimsDir(), { recursive: true });
  const probe = await open(join(sessionClaimsDir(), "read-probe.bin"), "w+");
  const proto = Object.getPrototypeOf(probe) as {
    read: (this: unknown, ...args: never[]) => Promise<{ bytesRead?: number }>;
  };
  await probe.close();
  const original = proto.read;
  let bytes = 0;
  const spy = vi.spyOn(proto, "read").mockImplementation(async function (this: unknown, ...args: never[]) {
    const result = await original.call(this, ...args);
    bytes += result.bytesRead ?? 0;
    return result;
  });
  try {
    await run();
    return bytes;
  } finally {
    spy.mockRestore();
  }
}

function chunkCeiling(bytes: number): number {
  return Math.ceil(bytes / SIDECAR_HEADER_CHUNK) * SIDECAR_HEADER_CHUNK;
}

describe("sidecar prefix reads", () => {
  it("does not read a later allocate tail once the first chunk holds a session record", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "early-session.registry.jsonl");
    const sessionFile = "/early-live.jsonl";
    const header = `${JSON.stringify({ kind: "session", sessionFile })}\n`;
    const tail = `${JSON.stringify({ kind: "allocate", path: "/a.ts", rows: [["abcd", "k".repeat(70000)]] })}\n`;
    expect(Buffer.byteLength(header)).toBeLessThan(SIDECAR_HEADER_CHUNK);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, header + tail);
    let found: string | undefined;
    const bytes = await bytesReadBySidecar(async () => {
      found = await readSidecarSessionFile(sidecar);
    });
    expect(found).toBe(sessionFile);
    expect(bytes).toBeLessThanOrEqual(SIDECAR_HEADER_CHUNK);
  });

  it("stops a header read at the first complete line", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "early-header.registry.jsonl");
    const header = JSON.stringify({ kind: "session", sessionFile: "/header-live.jsonl" });
    const tail = "z".repeat(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, `${header}\n${tail}`);
    let found = "";
    const bytes = await bytesReadBySidecar(async () => {
      found = await readSidecarHeader(sidecar);
    });
    expect(found).toBe(header);
    expect(bytes).toBeLessThanOrEqual(SIDECAR_HEADER_CHUNK);
    expect(bytes).toBeLessThan(Buffer.byteLength(`${header}\n${tail}`));
  });

  it("reads a header that crosses chunks and then stops before the allocate tail", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "long-header-stop.registry.jsonl");
    const header = JSON.stringify({ kind: "session", sessionFile: `你${"x".repeat(5000)}` });
    const tail = "y".repeat(SIDECAR_HEADER_BYTES);
    expect(Buffer.byteLength(header)).toBeGreaterThan(SIDECAR_HEADER_CHUNK);
    expect(Buffer.byteLength(header) + 1).toBeLessThan(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, `${header}\n${tail}`);
    let found = "";
    const bytes = await bytesReadBySidecar(async () => {
      found = await readSidecarHeader(sidecar);
    });
    expect(found).toBe(header);
    expect(bytes).toBeGreaterThan(SIDECAR_HEADER_CHUNK);
    expect(bytes).toBeLessThanOrEqual(chunkCeiling(Buffer.byteLength(header) + 1));
  });

  it("finds a legacy session after an allocate line without reading the rest of the file", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "legacy-second-line.registry.jsonl");
    const allocate = JSON.stringify({ kind: "allocate", path: "/legacy.ts", rows: [["abcd", "c".repeat(5000)]] });
    const sessionFile = "/legacy-live.jsonl";
    const session = JSON.stringify({ kind: "session", sessionFile });
    const tail = JSON.stringify({ kind: "allocate", path: "/tail.ts", rows: [["efgh", "d".repeat(40000)]] });
    const prefix = `${allocate}\n${session}\n`;
    expect(Buffer.byteLength(allocate)).toBeGreaterThan(SIDECAR_HEADER_CHUNK);
    expect(Buffer.byteLength(prefix)).toBeLessThan(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, prefix + tail);
    let found: string | undefined;
    const bytes = await bytesReadBySidecar(async () => {
      found = await readSidecarSessionFile(sidecar);
    });
    expect(found).toBe(sessionFile);
    expect(bytes).toBeGreaterThan(SIDECAR_HEADER_CHUNK);
    expect(bytes).toBeLessThanOrEqual(chunkCeiling(Buffer.byteLength(prefix)));
  });

  it("preserves a session path whose UTF-8 character crosses a chunk boundary", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "utf8-chunk.registry.jsonl");
    const head = '{"kind":"session","sessionFile":"';
    const markerAt = SIDECAR_HEADER_CHUNK - 1;
    const pad = markerAt - Buffer.byteLength(head);
    expect(pad).toBeGreaterThan(0);
    const sessionFile = `${"a".repeat(pad)}你/live.jsonl`;
    const line = `${head}${sessionFile}"}`;
    expect(Buffer.byteLength(line.slice(0, line.indexOf("你")))).toBe(markerAt);
    const tail = `\n${"b".repeat(SIDECAR_HEADER_BYTES)}`;
    await writeFile(sidecar, line + tail);
    let found: string | undefined;
    const bytes = await bytesReadBySidecar(async () => {
      found = await readSidecarSessionFile(sidecar);
    });
    expect(found).toBe(sessionFile);
    expect(bytes).toBeGreaterThan(SIDECAR_HEADER_CHUNK);
    expect(bytes).toBeLessThanOrEqual(chunkCeiling(Buffer.byteLength(line) + 1));
  });

  it("reads a session record that has no trailing newline at EOF", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "eof-session.registry.jsonl");
    const sessionFile = "/eof-live.jsonl";
    const line = JSON.stringify({ kind: "session", sessionFile });
    await writeFile(sidecar, line);
    await expect(readSidecarSessionFile(sidecar)).resolves.toBe(sessionFile);
    await expect(readSidecarHeader(sidecar)).resolves.toBe(line);
  });

  it("reads a session record whose newline is the last byte of the 64KiB window", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "window-end.registry.jsonl");
    const sessionFile = "/window-end.jsonl";
    const record = JSON.stringify({ kind: "session", sessionFile });
    const pad = SIDECAR_HEADER_BYTES - 1 - Buffer.byteLength(record);
    expect(pad).toBeGreaterThan(0);
    const prefix = `${" ".repeat(pad)}${record}\n`;
    expect(Buffer.byteLength(prefix)).toBe(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, `${prefix}ignored`);
    await expect(readSidecarSessionFile(sidecar)).resolves.toBe(sessionFile);
  });

  it("ignores a session record cut off by the 64KiB window", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "window-cut.registry.jsonl");
    const record = JSON.stringify({
      kind: "session",
      sessionFile: `/cut-${"x".repeat(SIDECAR_HEADER_BYTES)}.jsonl`,
    });
    expect(Buffer.byteLength(record)).toBeGreaterThan(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, `${record}\n`);
    await expect(readSidecarSessionFile(sidecar)).resolves.toBeUndefined();
    await expect(readSidecarHeader(sidecar)).resolves.toBe("");
  });

  it("parses each completed allocate line once per scan when later chunks have no session", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "allocate-only-chunks.registry.jsonl");
    const lines = Array.from({ length: 6 }, (_, id) => {
      const marker = `ALLOC-${String(id).padStart(2, "0")}-`;
      const base = JSON.stringify({ kind: "allocate", path: `/alloc-${id}.ts`, rows: [["abcd", marker]] });
      const pad = SIDECAR_HEADER_CHUNK - 1 - Buffer.byteLength(base);
      expect(pad).toBeGreaterThan(0);
      const line = JSON.stringify({
        kind: "allocate",
        path: `/alloc-${id}.ts`,
        rows: [["abcd", marker + "x".repeat(pad)]],
      });
      expect(Buffer.byteLength(line)).toBe(SIDECAR_HEADER_CHUNK - 1);
      return line;
    });
    await writeFile(sidecar, `${lines.join("\n")}\n`);
    const counts = new Map(lines.map((line) => [line, 0]));
    const original = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const seen = counts.get(text);
      if (seen !== undefined) counts.set(text, seen + 1);
      return original(text);
    });
    try {
      await expect(readSidecarSessionFile(sidecar)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect([...counts.values()]).toEqual(lines.map(() => 2));
  });

  it("reads a full 64KiB window without a session in five normal reads", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "full-window-reads.registry.jsonl");
    await writeFile(sidecar, `${"x".repeat(SIDECAR_HEADER_BYTES)}Y`);
    const probe = await open(join(sessionClaimsDir(), "full-window-probe.bin"), "w+");
    const proto = Object.getPrototypeOf(probe) as {
      read: (this: unknown, ...args: never[]) => Promise<{ bytesRead?: number }>;
    };
    await probe.close();
    const original = proto.read;
    const requests: number[] = [];
    let bytes = 0;
    const spy = vi.spyOn(proto, "read").mockImplementation(async function (this: unknown, ...args: never[]) {
      const requested = args[2] as unknown as number;
      const result = await original.call(this, ...args);
      requests.push(requested);
      bytes += result.bytesRead ?? 0;
      return result;
    });
    try {
      await expect(readSidecarSessionFile(sidecar)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(bytes).toBe(SIDECAR_HEADER_BYTES);
    expect(requests).toEqual([4096, 4096, 8192, 16384, 32768]);
    expect(requests.length).toBeLessThanOrEqual(5);
  });

  it("assembles a session when every read returns fewer bytes than requested", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "short-read-session.registry.jsonl");
    const sessionFile = "/short-你.jsonl";
    const line = JSON.stringify({ kind: "session", sessionFile });
    await writeFile(sidecar, `${line}\n${"z".repeat(SIDECAR_HEADER_BYTES)}`);
    const probe = await open(join(sessionClaimsDir(), "short-read-probe.bin"), "w+");
    const proto = Object.getPrototypeOf(probe) as {
      read: (this: unknown, ...args: never[]) => Promise<{ bytesRead?: number }>;
    };
    await probe.close();
    const original = proto.read;
    const calls: Array<{ requested: number; bytesRead: number; position: number }> = [];
    const spy = vi.spyOn(proto, "read").mockImplementation(async function (this: unknown, ...args: never[]) {
      const requested = args[2] as unknown as number;
      const position = args[3] as unknown as number;
      const capped = Math.min(requested, 2) as never;
      const result = await original.call(this, args[0], args[1], capped, args[3]);
      const bytesRead = result.bytesRead ?? 0;
      calls.push({ requested, bytesRead, position });
      return result;
    });
    let found: string | undefined;
    try {
      found = await readSidecarSessionFile(sidecar);
    } finally {
      spy.mockRestore();
    }
    expect(found).toBe(sessionFile);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.bytesRead < call.requested)).toBe(true);
    expect(calls[0]?.position).toBe(0);
    for (let index = 1; index < calls.length; index += 1) {
      expect(calls[index]?.position).toBe((calls[index - 1]?.position ?? 0) + (calls[index - 1]?.bytesRead ?? 0));
    }
  });

  it("reads an exact 64KiB session record that has no newline inside the window", async () => {
    await mkdir(sessionClaimsDir(), { recursive: true });
    const sidecar = join(sessionClaimsDir(), "exact-window.registry.jsonl");
    const sessionFile = "/exact-window.jsonl";
    const record = JSON.stringify({ kind: "session", sessionFile });
    const content = `${" ".repeat(SIDECAR_HEADER_BYTES - Buffer.byteLength(record))}${record}`;
    expect(Buffer.byteLength(content)).toBe(SIDECAR_HEADER_BYTES);
    await writeFile(sidecar, `${content}\nextra`);
    await expect(readSidecarSessionFile(sidecar)).resolves.toBe(sessionFile);
  });
});
