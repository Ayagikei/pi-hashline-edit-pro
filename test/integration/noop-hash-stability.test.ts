import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import {
  withTempFile,
  setupIntegrationTest,
  getText,
  anchorFor,
} from "../support/fixtures";

describe("noop replace hash stability", () => {
  it("keeps the edited line hash unchanged after a pure noop replace", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = getText(
        await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const hashBefore = anchorFor(r1, "bbb");

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashBefore, remove_to: hashBefore,
          replacement_lines: ["bbb"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("No changes made");

      const r2 = getText(
        await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      expect(anchorFor(r2, "bbb")).toBe(hashBefore);
    });
  });

  it("keeps hashes stable across repeated noop replaces", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = getText(
        await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const hashBefore = anchorFor(r1, "bbb");

      for (let i = 0; i < 3; i++) {
        await editTool.execute(
          `e${i}`,
          {
            remove_from: hashBefore, remove_to: hashBefore,
            replacement_lines: ["bbb"],
          },
          undefined,
          undefined,
          ctx,
        );
      }

      const r2 = getText(
        await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      expect(anchorFor(r2, "bbb")).toBe(hashBefore);
    });
  });

  it("keeps the noop line hash stable when a real edit follows", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = getText(
        await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const bbbHash = anchorFor(r1, "bbb");
      const dddHash = anchorFor(r1, "ddd");

      const noop = await editTool.execute(
        "e1",
        {
          remove_from: bbbHash, remove_to: bbbHash,
          replacement_lines: ["bbb"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(noop)).toContain("No changes made");

      const result = await editTool.execute(
        "e2",
        {
          remove_from: dddHash, remove_to: dddHash,
          replacement_lines: ["DDD"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully replaced");

      const r2 = getText(
        await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      expect(anchorFor(r2, "bbb")).toBe(bbbHash);
      expect(anchorFor(r2, "DDD")).not.toBe(dddHash);
    });
  });

  it("keeps original anchors usable after a noop replace", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const r1 = getText(
        await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx),
      );
      const hashBefore = anchorFor(r1, "bbb");

      const noop = await editTool.execute(
        "e1",
        {
          remove_from: hashBefore, remove_to: hashBefore,
          replacement_lines: ["bbb"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(noop)).toContain("No changes made");

      const followUp = await editTool.execute(
        "e2",
        {
          remove_from: hashBefore, remove_to: hashBefore,
          replacement_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(followUp)).toContain("Successfully replaced");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });
});
