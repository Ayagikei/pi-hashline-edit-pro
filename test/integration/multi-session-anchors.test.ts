import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { initRegistry } from "../../src/anchor-registry";
import { makeFakePiRegistry, withTempDir, getText, anchorFor } from "../support/fixtures";

function sessionContext(cwd: string, sessionFile: string) {
  return {
    cwd,
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionFile,
    },
  } as any;
}
async function setup(dir: string) {
  await writeFile(join(dir, "fileA.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(dir, "fileB.txt"), "one\ntwo\nthree\n");
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return { getTool };
}

describe("multi-session anchor isolation", () => {
  it("resolves edits against the calling session's anchors", async () => {
    await withTempDir("pi-hashline-multi-", async (dir) => {
      const { getTool } = await setup(dir);
      const ctxA = sessionContext(dir, join(dir, "session-a.jsonl"));
      const ctxB = sessionContext(dir, join(dir, "session-b.jsonl"));
      const readTool = getTool("read");
      const replaceTool = getTool("replace");

      const readA = await readTool.execute("rA", { path: "fileA.txt" }, undefined, undefined, ctxA);
      const anchorA = anchorFor(getText(readA), "beta");
      const readB = await readTool.execute("rB", { path: "fileB.txt" }, undefined, undefined, ctxB);
      const anchorB = anchorFor(getText(readB), "two");

      const applied = await replaceTool.execute(
        "eA",
        { remove_from: anchorA, remove_to: anchorA, replacement_lines: ["BETA"] },
        undefined,
        undefined,
        ctxA,
      );
      expect(getText(applied)).toContain("Successfully replaced");
      expect(await readFile(join(dir, "fileA.txt"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
      expect(await readFile(join(dir, "fileB.txt"), "utf-8")).toBe("one\ntwo\nthree\n");

      await expect(
        replaceTool.execute(
          "eA2",
          { remove_from: anchorB, remove_to: anchorB, replacement_lines: ["HACKED"] },
          undefined,
          undefined,
          ctxA,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
      expect(await readFile(join(dir, "fileB.txt"), "utf-8")).toBe("one\ntwo\nthree\n");
    });
  });

  it("keeps anchors valid when another session initializes", async () => {
    await withTempDir("pi-hashline-multi-switch-", async (dir) => {
      const { getTool } = await setup(dir);
      const ctxA = sessionContext(dir, join(dir, "switch-a.jsonl"));
      const readTool = getTool("read");
      const replaceTool = getTool("replace");

      const readA = await readTool.execute("rA", { path: "fileA.txt" }, undefined, undefined, ctxA);
      const anchorA = anchorFor(getText(readA), "beta");

      await initRegistry(join(dir, "switch-b.jsonl"));

      const applied = await replaceTool.execute(
        "eA",
        { remove_from: anchorA, remove_to: anchorA, replacement_lines: ["BETA"] },
        undefined,
        undefined,
        ctxA,
      );
      expect(getText(applied)).toContain("Successfully replaced");
      expect(await readFile(join(dir, "fileA.txt"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("keeps concurrent edits isolated across sessions", async () => {
    await withTempDir("pi-hashline-multi-par-", async (dir) => {
      const { getTool } = await setup(dir);
      const ctxA = sessionContext(dir, join(dir, "par-a.jsonl"));
      const ctxB = sessionContext(dir, join(dir, "par-b.jsonl"));
      const readTool = getTool("read");
      const replaceTool = getTool("replace");

      const readA = await readTool.execute("rA", { path: "fileA.txt" }, undefined, undefined, ctxA);
      const anchorA = anchorFor(getText(readA), "beta");
      const readB = await readTool.execute("rB", { path: "fileB.txt" }, undefined, undefined, ctxB);
      const anchorB = anchorFor(getText(readB), "two");

      await Promise.all([
        replaceTool.execute(
          "eA",
          { remove_from: anchorA, remove_to: anchorA, replacement_lines: ["BETA"] },
          undefined,
          undefined,
          ctxA,
        ),
        replaceTool.execute(
          "eB",
          { remove_from: anchorB, remove_to: anchorB, replacement_lines: ["TWO"] },
          undefined,
          undefined,
          ctxB,
        ),
      ]);

      expect(await readFile(join(dir, "fileA.txt"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
      expect(await readFile(join(dir, "fileB.txt"), "utf-8")).toBe("one\nTWO\nthree\n");
    });
  });
});
