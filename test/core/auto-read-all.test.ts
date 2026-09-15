import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { autoReadAllBudget, buildAutoReadAllInjection, discoverAutoReadAllFiles } from "../../src/auto-read-all";
import { ownersForPath, servedForPath } from "../../src/anchor-registry";
import { resolveTarget } from "../../src/fs-write";
import { shutdownHashStore } from "../../src/hash-store";
import { makeTempDir, withHome } from "../support/fixtures";

const restoreHome = withHome(process.env.HOME);

afterAll(restoreHome);

async function cleanupCwd(cwd: string): Promise<void> {
  shutdownHashStore();
  await rm(cwd, { recursive: true, force: true });
}

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
}

describe("discoverAutoReadAllFiles", () => {
  it("lists tracked and untracked files while skipping ignored, binary, image, and oversized files", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-git-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "tracked.ts"), "export const a = 1;\n");
      execFileSync("git", ["add", "tracked.ts"], { cwd });
      await writeFile(join(cwd, "untracked.md"), "# hi\n");
      await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
      await writeFile(join(cwd, "ignored.txt"), "nope\n");
      await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      await writeFile(join(cwd, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
      await writeFile(join(cwd, "huge.txt"), "x".repeat(250_000));

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.source).toBe("git");
      expect(discovery.files).toEqual([".gitignore", "tracked.ts", "untracked.md"]);
      expect(discovery.discovered).toBe(6);
      expect(discovery.skippedBinary).toBe(2);
      expect(discovery.skippedLarge).toBe(1);
      expect(discovery.skippedOther).toBe(0);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("falls back to ripgrep outside a git repository and honors .gitignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hashline-auto-read-all-rg-"));
    try {
      await writeFile(join(cwd, "keep.txt"), "keep\n");
      await writeFile(join(cwd, ".gitignore"), "secret.txt\n");
      await writeFile(join(cwd, "secret.txt"), "no\n");

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.source).toBe("rg");
      expect(discovery.files).toEqual([".gitignore", "keep.txt"]);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips tracked files that are missing from the working tree", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-deleted-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "gone.txt"), "gone\n");
      execFileSync("git", ["add", "gone.txt"], { cwd });
      await rm(join(cwd, "gone.txt"));

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.files).toEqual([]);
      expect(discovery.skippedOther).toBe(1);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips package-lock.json anywhere in the tree", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-lock-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "package-lock.json"), "{}\n");
      await mkdir(join(cwd, "sub"));
      await writeFile(join(cwd, "sub", "package-lock.json"), "{}\n");
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.files).toEqual(["keep.ts"]);
      expect(discovery.discovered).toBe(3);
      expect(discovery.skippedByName).toBe(2);

      const injection = await buildAutoReadAllInjection(cwd, 1_000_000);
      expect(injection).toBeDefined();
      expect(injection!.text).toContain("=== keep.ts ===");
      expect(injection!.text).not.toContain("=== package-lock.json ===");
      expect(injection!.text).not.toContain("=== sub/package-lock.json ===");
      expect(injection!.text).toContain("2 file(s) skipped by name (package-lock.json)");
    } finally {
      await cleanupCwd(cwd);
    }
  });
});

describe("buildAutoReadAllInjection", () => {
  it("attaches anchored file content and serves the anchors", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-inject-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeFile(join(cwd, "empty.txt"), "");

      const injection = await buildAutoReadAllInjection(cwd, 1_000_000);
      expect(injection).toBeDefined();
      expect(injection!.files).toBe(2);
      expect(injection!.text).toContain("[hashline auto-read-all]");
      expect(injection!.text).toContain("=== sample.txt ===");
      const anchor = injection!.text.match(/([A-Za-z0-9]{4})│alpha/);
      expect(anchor).not.toBeNull();

      const resolved = await resolveTarget(join(cwd, "sample.txt"));
      expect(ownersForPath(resolved).has(anchor![1]!)).toBe(true);
      expect(servedForPath(resolved)?.has(anchor![1]!)).toBe(true);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("stops attaching files once the byte budget is spent", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-budget-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "a.txt"), "a\n".repeat(2000));
      await writeFile(join(cwd, "b.txt"), "b\n".repeat(2000));

      const injection = await buildAutoReadAllInjection(cwd, 3000);
      expect(injection).toBeDefined();
      expect(injection!.files).toBe(1);
      expect(injection!.omitted).toEqual(["b.txt"]);
      expect(injection!.text).toContain("Not attached: b.txt");
    } finally {
      await cleanupCwd(cwd);
    }
  });
});

describe("autoReadAllBudget", () => {
  it("clamps small and unknown context windows to the minimum", () => {
    expect(autoReadAllBudget(undefined)).toBe(200_000);
    expect(autoReadAllBudget({ contextWindow: 128_000 })).toBe(200_000);
  });

  it("scales with the context window", () => {
    expect(autoReadAllBudget({ contextWindow: 400_000 })).toBe(600_000);
  });

  it("clamps very large context windows to the maximum", () => {
    expect(autoReadAllBudget({ contextWindow: 4_000_000 })).toBe(2_000_000);
  });
});
