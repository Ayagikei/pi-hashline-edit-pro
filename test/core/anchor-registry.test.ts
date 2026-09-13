import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
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
  alignOwnershipWithSpans,
  parseRegistryLog,
  foldRegistryEvents,
  mintAnchor,
  gcRegistrySidecars,
  sessionKeyFor,
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
  resetRegistryForTests();
});

describe("anchor registry", () => {
  it("allocates unique well-formed anchors within a session", () => {
    const first = allocateAnchor("a.ts", "ck0");
    const second = allocateAnchor("b.ts", "ck1");
    const third = allocateAnchor("c.ts", "ck2");
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toMatch(/^[A-Za-z0-9]{4}$/);
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
    expect(allocateAnchor("a.ts", "ck")).toMatch(/^[A-Za-z0-9]{4}$/);
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

  it("restores ownership and served state from a sidecar log", async () => {
    const sessionFile = join(sessionClaimsDir(), "session.jsonl");
    await mkdir(sessionClaimsDir(), { recursive: true });
    await writeFile(sessionFile, "", "utf-8");
    await initRegistry(sessionFile);
    const anchor = allocateAnchor("restored.ts", "ckR");
    markServed("restored.ts", [[anchor, "ckR"]]);

    const sidecars = await readdir(sessionClaimsDir());
    const sidecarPath = join(sessionClaimsDir(), sidecars.find((n) => n.endsWith(".registry.jsonl"))!);
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
    const deadSidecar = join(sessionClaimsDir(), "dead.jsonl.registry.jsonl");
    await gcRegistrySidecars();
    await expect(readFile(deadSidecar, "utf-8")).rejects.toThrow();
    await expect(readFile(sessionFile, "utf-8")).resolves.toBe("");
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
