import { describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import register from "../../index";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests, batchMemberFor } from "../../src/batch";
import { planEdit } from "../../src/hashline";
import { resEdit } from "../../src/hashline";
import { lineHashes } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile, getText } from "../support/fixtures";

function toolCall(id: string, name: string, args: unknown) {
  return { type: "toolCall", id, name, arguments: args };
}

function assistantMessage(calls: Array<{ type: string; id: string; name: string; arguments: unknown }>) {
  return { role: "assistant", content: calls };
}

function anchorFor(readText: string, needle: string) {
  return readText.split("\n").find((line) => line.split("│")[1] === needle)!.split("│")[0]!;
}

async function setupTools(cwd: string) {
  resetRegistryForTests();
  resetBatchStateForTests();
  await initRegistry(undefined);
  const { pi, getTool, handlers } = makeFakePiRegistry();
  register(pi);
  const ctx = { cwd, ui: { notify() {} } } as any;
  return { getTool, handlers, ctx };
}

describe("batch hardening", () => {
  it("batch preflight aborts before writing on allocation failure", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("b1", "replace", { remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] }),
        toolCall("b2", "replace", { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] }),
      ]) }, ctx) as Promise<unknown>);
      const hashline = await import("../../src/hashline");
      const original = hashline.lineHashes;
      const spy = vi.spyOn(hashline, "lineHashes").mockImplementation(async (...args: any[]) => {
        const prev = args[2] as any;
        if (prev && Array.isArray(prev.spans) && args[5] === true) throw new Error("[E_FILE_TOO_LARGE] simulated preflight failure");
        return (original as any)(...args);
      });
      try {
        await editTool.execute("b1", { remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] }, undefined, undefined, ctx);
        await expect(
          editTool.execute("b2", { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] }, undefined, undefined, ctx)
        ).rejects.toThrow(/simulated preflight/);
      } finally {
        spy.mockRestore();
      }
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("batch post-write allocation failure reports file-written with undo", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const undoTool = getTool("undo_last_change");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("b1", "replace", { remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] }),
        toolCall("b2", "replace", { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] } ),
      ]) }, ctx) as Promise<unknown>);
      const hashline = await import("../../src/hashline");
      const original = hashline.lineHashes;
      const spy = vi.spyOn(hashline, "lineHashes").mockImplementation(async (...args: any[]) => {
        const prev = args[2] as any;
        if (prev && Array.isArray(prev.spans) && args[5] !== true) throw new Error("[E_FILE_TOO_LARGE] simulated post-write failure");
        return (original as any)(...args);
      });
      try {
        await editTool.execute("b1", { remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] }, undefined, undefined, ctx);
        await expect(
          editTool.execute("b2", { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] }, undefined, undefined, ctx)
        ).rejects.toThrow(/File was written; anchor finalization failed/);
      } finally {
        spy.mockRestore();
      }
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\nGAMMA\n");
      const undone = await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(getText(undone)).toMatch(/Undone last change/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("single post-write allocation failure reports file-written with undo", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { getTool, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const undoTool = getTool("undo_last_change");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const alphaRef = anchorFor(text, "alpha");
      const hashline = await import("../../src/hashline");
      const original = hashline.lineHashes;
      const spy = vi.spyOn(hashline, "lineHashes").mockImplementation(async (...args: any[]) => {
        const prev = args[2] as any;
        if (prev && Array.isArray(prev.spans) && args[5] !== true) throw new Error("[E_FILE_TOO_LARGE] simulated single post-write failure");
        return (original as any)(...args);
      });
      try {
        await expect(
          editTool.execute("e1", { remove_from: alphaRef, remove_to: alphaRef, replacement_lines: ["ALPHA"] }, undefined, undefined, ctx)
        ).rejects.toThrow(/File was written; anchor finalization failed/);
      } finally {
        spy.mockRestore();
      }
      expect(await readFile(path, "utf-8")).toContain("ALPHA");
      const undone = await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(getText(undone)).toMatch(/Undone last change/);
    });
  });

  it("requirePath stale call joins batch through path hint and aborts", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(join(cwd, ".config", "pi-hashline-edit-pro", "config.json"), JSON.stringify({ autoRead: true, requirePath: true }), "utf-8");
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const betaRef = anchorFor(text, "beta");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("v1", "replace", { path: "sample.txt", remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] }),
        toolCall("s1", "replace", { path: "sample.txt", remove_from: "ZZZZ", remove_to: "ZZZZ", replacement_lines: ["STALE"] }),
      ]) }, ctx) as Promise<unknown>);
      expect(batchMemberFor("v1")).toBeDefined();
      expect(batchMemberFor("s1")).toBeDefined();
      expect(batchMemberFor("v1")?.batchKey).toBe(batchMemberFor("s1")?.batchKey);
      await editTool.execute("v1", { path: "sample.txt", remove_from: betaRef, remove_to: betaRef, replacement_lines: ["BETA"] }, undefined, undefined, ctx);
      await expect(
        editTool.execute("s1", { path: "sample.txt", remove_from: "ZZZZ", remove_to: "ZZZZ", replacement_lines: ["STALE"] }, undefined, undefined, ctx)
      ).rejects.toThrow(/E_OP_ABORTED|E_STALE_ANCHOR/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("replace with one valid co-anchor joins batch and aborts", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const betaRef = anchorFor(text, "beta");
      const gammaRef = anchorFor(text, "gamma");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("v1", "replace", { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] }),
        toolCall("m1", "replace", { remove_from: betaRef, remove_to: "ZZZZ", replacement_lines: ["MIXED"] }),
      ]) }, ctx) as Promise<unknown>);
      expect(batchMemberFor("v1")).toBeDefined();
      expect(batchMemberFor("m1")).toBeDefined();
      expect(batchMemberFor("v1")?.batchKey).toBe(batchMemberFor("m1")?.batchKey);
      await editTool.execute("v1", { remove_from: gammaRef, remove_to: gammaRef, replacement_lines: ["GAMMA"] }, undefined, undefined, ctx);
      await expect(
        editTool.execute("m1", { remove_from: betaRef, remove_to: "ZZZZ", replacement_lines: ["MIXED"] }, undefined, undefined, ctx)
      ).rejects.toThrow(/Aborts batch 1\.$/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    });
  });

  it("insert batch reuses base read instead of per-member file reads", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const insertTool = getTool("insert");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const oneRef = anchorFor(text, "one");
      const threeRef = anchorFor(text, "three");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("m1", "replace", { remove_from: oneRef, remove_to: oneRef, replacement_lines: ["ONE"] }),
        toolCall("m2", "insert", { anchor: threeRef, direction: "before", lines: ["MID"] }),
      ]) }, ctx) as Promise<unknown>);
      const reader = await import("../../src/file-reader");
      const originalRead = reader.readNormFile;
      let readCalls = 0;
      const spy = vi.spyOn(reader, "readNormFile").mockImplementation(async (...args: any[]) => {
        readCalls += 1;
        return (originalRead as any)(...args);
      });
      try {
        await editTool.execute("m1", { remove_from: oneRef, remove_to: oneRef, replacement_lines: ["ONE"] }, undefined, undefined, ctx);
        await insertTool.execute("m2", { anchor: threeRef, direction: "before", lines: ["MID"] }, undefined, undefined, ctx);
      } finally {
        spy.mockRestore();
      }
      expect(readCalls).toBeLessThanOrEqual(1);
    });
  });

  it("planEdit with cached base lines matches fresh planning", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      setupTools(cwd);
      const content = "aaa\nbbb\nccc\n";
      const hashes = await lineHashes(content, path);
      const edit = resEdit({ remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["X"] }, []);
      const fresh = planEdit(content, edit, hashes, {});
      const { splitLines } = await import("../../src/utils");
      const cached = planEdit(content, edit, hashes, { baseFileLines: splitLines(content) });
      expect(cached.resolved).toEqual(fresh.resolved);
      expect(cached.warnings).toEqual(fresh.warnings);
    });
  });

  it("an unresolvable sibling does not abort the valid sibling batch", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const aaaRef = anchorFor(text, "aaa");
      const bbbRef = anchorFor(text, "bbb");
      const cccRef = anchorFor(text, "ccc");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("v1", "replace", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["AAA"] }),
        toolCall("s1", "replace", { remove_from: "ZZZZ", remove_to: "ZZZZ", replacement_lines: ["XXX"] }),
        toolCall("v2", "replace", { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["BBB"] }),
        toolCall("v3", "replace", { remove_from: cccRef, remove_to: cccRef, replacement_lines: ["CCC"] }),
      ]) }, ctx) as Promise<unknown>);
      expect(batchMemberFor("s1")).toBeUndefined();
      expect(batchMemberFor("v1")?.display).toBe(1);
      expect(batchMemberFor("v3")?.last).toBe(true);
      const first = getText(await editTool.execute("v1", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["AAA"] }, undefined, undefined, ctx));
      expect(first).toBe("In batch 1");
      await expect(
        editTool.execute("s1", { remove_from: "ZZZZ", remove_to: "ZZZZ", replacement_lines: ["XXX"] }, undefined, undefined, ctx)
      ).rejects.toThrow(/\[E_STALE_ANCHOR\]/);
      await editTool.execute("v2", { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["BBB"] }, undefined, undefined, ctx);
      const last = await editTool.execute("v3", { remove_from: cccRef, remove_to: cccRef, replacement_lines: ["CCC"] }, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 3 edits applied as one commit");
      expect(await readFile(path, "utf-8")).toBe("AAA\nBBB\nCCC\n");
    });
  });
  it("an unresolvable sibling executed first does not poison the later batch", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const aaaRef = anchorFor(text, "aaa");
      const bbbRef = anchorFor(text, "bbb");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("s1", "replace", { remove_from: "ZZZZ", remove_to: "ZZZZ", replacement_lines: ["XXX"] }),
        toolCall("v1", "replace", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["AAA"] }),
        toolCall("v2", "replace", { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["BBB"] }),
      ]) }, ctx) as Promise<unknown>);
      let failure = "";
      try {
        await editTool.execute("s1", { remove_from: "ZZZZ", remove_to: "ZZZZ", replacement_lines: ["XXX"] }, undefined, undefined, ctx);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toMatch(/^\[E_STALE_ANCHOR\]/);
      expect(failure).not.toContain("Aborts batch");
      const first = getText(await editTool.execute("v1", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["AAA"] }, undefined, undefined, ctx));
      expect(first).toBe("In batch 1");
      const last = await editTool.execute("v2", { remove_from: bbbRef, remove_to: bbbRef, replacement_lines: ["BBB"] }, undefined, undefined, ctx);
      expect(getText(last)).toContain("Batch 1: 2 edits applied as one commit");
      expect(await readFile(path, "utf-8")).toBe("AAA\nBBB\nccc\n");
    });
  });
  it("an unparsable sibling fails solo instead of aborting the batch", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const text = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const aaaRef = anchorFor(text, "aaa");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("p1", "replace", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["AAA"] }),
        toolCall("p2", "replace", { replacement_lines: ["BBB"] }),
      ]) }, ctx) as Promise<unknown>);
      expect(batchMemberFor("p1")).toBeUndefined();
      expect(batchMemberFor("p2")).toBeUndefined();
      await editTool.execute("p1", { remove_from: aaaRef, remove_to: aaaRef, replacement_lines: ["AAA"] }, undefined, undefined, ctx);
      await expect(
        editTool.execute("p2", { replacement_lines: ["BBB"] }, undefined, undefined, ctx)
      ).rejects.toThrow(/\[E_BAD_SHAPE\]/);
      expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\n");
    });
  });
  it("aborted batch preserves prior undo", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { getTool, handlers, ctx } = await setupTools(cwd);
      const readTool = getTool("read");
      const editTool = getTool("replace");
      const undoTool = getTool("undo_last_change");
      const first = getText(await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx));
      const bbb = anchorFor(first, "bbb");
      await editTool.execute("base", { remove_from: bbb, remove_to: bbb, replacement_lines: ["BBB"] }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
      const second = getText(await readTool.execute("r2", { path: "sample.txt" }, undefined, undefined, ctx));
      const valid = anchorFor(second, "aaa");
      await (handlers.get("message_end")!({ type: "message_end", message: assistantMessage([
        toolCall("s1", "replace", { remove_from: valid, remove_to: "ZZZZ", replacement_lines: ["XXX"] }),
        toolCall("v1", "replace", { remove_from: valid, remove_to: valid, replacement_lines: ["AAA"] }),
      ]) }, ctx) as Promise<unknown>);
      await expect(
        editTool.execute("s1", { remove_from: valid, remove_to: "ZZZZ", replacement_lines: ["XXX"] }, undefined, undefined, ctx)
      ).rejects.toThrow(/Aborts batch 1\.$/);
      await expect(
        editTool.execute("v1", { remove_from: valid, remove_to: valid, replacement_lines: ["AAA"] }, undefined, undefined, ctx)
      ).rejects.toThrow(/\[E_OP_ABORTED\]/);
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
      await undoTool.execute("u1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });
});
