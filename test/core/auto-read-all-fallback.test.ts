import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/grep", () => ({
  resolveRgPath: async () => {
    throw new Error("ripgrep unavailable");
  },
}));

import { discoverAutoReadAllFiles } from "../../src/auto-read-all";

describe("auto-read-all discovery fallback", () => {
  it("walks the tree when git and ripgrep are unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hashline-auto-read-all-walk-"));
    try {
      await writeFile(join(cwd, "top.txt"), "top\n");
      await mkdir(join(cwd, "sub"));
      await writeFile(join(cwd, "sub", "nested.md"), "nested\n");
      await mkdir(join(cwd, "node_modules"));
      await writeFile(join(cwd, "node_modules", "dep.js"), "dep\n");
      await mkdir(join(cwd, ".git"));
      await writeFile(join(cwd, ".git", "config"), "git\n");
      await mkdir(join(cwd, "dist"));
      await writeFile(join(cwd, "dist", "out.js"), "out\n");

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.source).toBe("walk");
      expect(discovery.files).toEqual(["sub/nested.md", "top.txt"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
