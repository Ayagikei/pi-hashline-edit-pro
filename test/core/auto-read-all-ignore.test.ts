import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAutoReadAllFiles, buildAutoReadAllInjection, normalizeAutoReadAllIgnoreList, isExcludedByCustomIgnore } from "../../src/auto-read-all";
import { parseAutoReadAllIgnore, setAutoReadAllIgnore, setAutoReadAllIgnoreFromText, readConfig } from "../../src/config";
import { configRows, HashlineConfigOverlay } from "../../src/config-ui";
import { makeTempDir, rmRetry, withTempDir } from "../support/fixtures";

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
}

describe("normalizeAutoReadAllIgnoreList", () => {
  it("trims slashes and lowercases with dedupe", () => {
    expect(normalizeAutoReadAllIgnoreList([" Docs ", "/tmp/", "docs", "SRC//TMP", "\\src\\tmp\\"])).toEqual(["docs", "tmp", "src/tmp"]);
  });
  it("drops empty and non-string entries", () => {
    expect(normalizeAutoReadAllIgnoreList(["", "  ", "/", undefined as never, 42 as never])).toEqual([]);
  });
  it("returns empty for undefined", () => {
    expect(normalizeAutoReadAllIgnoreList(undefined)).toEqual([]);
  });
});

describe("isExcludedByCustomIgnore", () => {
  it("matches single segments case-insensitively", () => {
    expect(isExcludedByCustomIgnore("Docs/readme.md", ["docs"])).toBe(true);
    expect(isExcludedByCustomIgnore("src/DOCS/file.txt", ["docs"])).toBe(true);
    expect(isExcludedByCustomIgnore("src/main.ts", ["docs"])).toBe(false);
  });
  it("does not match partial segment names", () => {
    expect(isExcludedByCustomIgnore("vendor_notes.txt", ["vendor"])).toBe(false);
    expect(isExcludedByCustomIgnore("src/vendor_notes/file.txt", ["vendor"])).toBe(false);
  });
  it("matches slash entries as folder paths", () => {
    expect(isExcludedByCustomIgnore("src/tmp/file.txt", ["src/tmp"])).toBe(true);
    expect(isExcludedByCustomIgnore("a/src/tmp/b/c.txt", ["src/tmp"])).toBe(true);
    expect(isExcludedByCustomIgnore("src/tmp", ["src/tmp"])).toBe(true);
    expect(isExcludedByCustomIgnore("src/tmp2/file.txt", ["src/tmp"])).toBe(false);
    expect(isExcludedByCustomIgnore("src/other/file.txt", ["src/tmp"])).toBe(false);
  });
  it("returns false for empty ignore list", () => {
    expect(isExcludedByCustomIgnore("a/b.txt", [])).toBe(false);
  });
});

describe("parseAutoReadAllIgnore", () => {
  it("parses arrays with trimming and dedupe", () => {
    expect(parseAutoReadAllIgnore([" docs ", "tmp", "docs", "", 42])).toEqual(["docs", "tmp"]);
  });
  it("parses comma-separated strings", () => {
    expect(parseAutoReadAllIgnore("docs, tmp,, Docs")).toEqual(["docs", "tmp"]);
  });
  it("returns empty for missing or wrong shapes", () => {
    expect(parseAutoReadAllIgnore(undefined)).toEqual([]);
    expect(parseAutoReadAllIgnore(42)).toEqual([]);
  });
});

describe("setAutoReadAllIgnore", () => {
  it("persists normalized folders", async () => {
    await withTempDir("ignore-config-", async () => {
      expect(await setAutoReadAllIgnore([" docs ", "tmp", "docs"])).toEqual(["docs", "tmp"]);
      expect((await readConfig()).autoReadAllIgnore).toEqual(["docs", "tmp"]);
      expect(await setAutoReadAllIgnoreFromText("a, b, a")).toEqual(["a", "b"]);
      expect((await readConfig()).autoReadAllIgnore).toEqual(["a", "b"]);
    });
  });
});

describe("discoverAutoReadAllFiles with custom ignores", () => {
  it("skips single-segment folders anywhere in the tree", async () => {
    const cwd = await makeTempDir("pi-hashline-ignore-seg-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");
      await mkdir(join(cwd, "docs"), { recursive: true });
      await writeFile(join(cwd, "docs", "readme.md"), "hi\n");
      await mkdir(join(cwd, "src", "docs"), { recursive: true });
      await writeFile(join(cwd, "src", "docs", "nested.md"), "hi\n");
      const plain = await discoverAutoReadAllFiles(cwd, "on", []);
      expect(plain.files).toContain("docs/readme.md");
      const ignored = await discoverAutoReadAllFiles(cwd, "on", ["docs"]);
      expect(ignored.files).toEqual(["keep.ts"]);
      expect(ignored.skippedByName).toBeGreaterThan(plain.skippedByName);
    } finally {
      await rmRetry(cwd);
    }
  });
  it("matches case-insensitively and supports nested paths", async () => {
    const cwd = await makeTempDir("pi-hashline-ignore-path-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");
      await mkdir(join(cwd, "Tmp"), { recursive: true });
      await writeFile(join(cwd, "Tmp", "a.txt"), "hi\n");
      await mkdir(join(cwd, "src", "tmp"), { recursive: true });
      await writeFile(join(cwd, "src", "tmp", "b.txt"), "hi\n");
      await mkdir(join(cwd, "src", "other"), { recursive: true });
      await writeFile(join(cwd, "src", "other", "c.txt"), "hi\n");
      const seg = await discoverAutoReadAllFiles(cwd, "on", ["TMP"]);
      expect(seg.files).toEqual(["keep.ts", "src/other/c.txt"]);
      const nested = await discoverAutoReadAllFiles(cwd, "on", ["src/tmp"]);
      expect(nested.files).toEqual(["Tmp/a.txt", "keep.ts", "src/other/c.txt"]);
    } finally {
      await rmRetry(cwd);
    }
  });
  it("injection omits ignored folders", async () => {
    const cwd = await makeTempDir("pi-hashline-ignore-inject-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");
      await mkdir(join(cwd, "secret"), { recursive: true });
      await writeFile(join(cwd, "secret", "hidden.txt"), "hi\n");
      const injection = await buildAutoReadAllInjection(cwd, 1_000_000, "on", ["secret"]);
      expect(injection).toBeDefined();
      expect(injection!.text).toContain("=== keep.ts ===");
      expect(injection!.text).not.toContain("=== secret/hidden.txt ===");
    } finally {
      await rmRetry(cwd);
    }
  });
});

describe("configRows ignore folders", () => {
  it("exposes folders and empty state", async () => {
    await withTempDir("ignore-rows-", async () => {
      await setAutoReadAllIgnore([]);
      const empty = configRows(await readConfig()).find((row) => row.key === "autoReadAllIgnore")!;
      expect(empty.folders).toEqual([]);
      expect(empty.enabled).toBe(false);
      await setAutoReadAllIgnore(["docs", "tmp"]);
      const filled = configRows(await readConfig()).find((row) => row.key === "autoReadAllIgnore")!;
      expect(filled.folders).toEqual(["docs", "tmp"]);
      expect(filled.enabled).toBe(true);
    });
  });
});

function makeOverlay(onToggle: (key: string, delta?: number, value?: string) => Promise<void>): HashlineConfigOverlay {
  const theme = { fg: (_area: string, text: string) => text, bold: (text: string) => text } as never;
  return new HashlineConfigOverlay({ tui: { requestRender() {} }, theme, done() {}, onToggle: onToggle as never });
}

describe("HashlineConfigOverlay ignore editing", () => {
  it("enters edit mode with space and commits typed text", async () => {
    await withTempDir("ignore-overlay-", async () => {
      await setAutoReadAllIgnore([]);
      const seen: Array<{ key: string; value?: string }> = [];
      const overlay = makeOverlay(async (key, _delta, value) => {
        seen.push({ key, value });
      });
      await overlay.load();
      overlay.handleInput("j");
      overlay.handleInput("j");
      overlay.handleInput(" ");
      overlay.handleInput("d");
      overlay.handleInput("o");
      overlay.handleInput("c");
      overlay.handleInput("s");
      overlay.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen.length).toBe(1);
      expect(seen[0]!.key).toBe("autoReadAllIgnore");
      expect(seen[0]!.value).toBe("docs");
    });
  });
  it("starts editing with e and cancels with escape", async () => {
    await withTempDir("ignore-overlay-cancel-", async () => {
      await setAutoReadAllIgnore(["keep"]);
      let calls = 0;
      const overlay = makeOverlay(async () => {
        calls += 1;
      });
      await overlay.load();
      overlay.handleInput("j");
      overlay.handleInput("j");
      overlay.handleInput("e");
      overlay.handleInput("x");
      overlay.handleInput("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(0);
      const rendered = overlay.render(80).join("\n");
      expect(rendered).toContain("Ignore folders");
    });
  });
  it("supports backspace and ctrl-u while editing", async () => {
    await withTempDir("ignore-overlay-editkeys-", async () => {
      await setAutoReadAllIgnore([]);
      const seen: string[] = [];
      const overlay = makeOverlay(async (_key, _delta, value) => {
        seen.push(value ?? "");
      });
      await overlay.load();
      overlay.handleInput("j");
      overlay.handleInput("j");
      overlay.handleInput(" ");
      overlay.handleInput("a");
      overlay.handleInput("b");
      overlay.handleInput("\x7f");
      overlay.handleInput("c");
      overlay.handleInput("\x15");
      overlay.handleInput("z");
      overlay.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen).toEqual(["z"]);
    });
  });
  it("renders count box and folder list", async () => {
    await withTempDir("ignore-overlay-render-", async () => {
      await setAutoReadAllIgnore(["docs", "tmp"]);
      const overlay = makeOverlay(async () => {});
      await overlay.load();
      const rendered = overlay.render(80).join("\n");
      expect(rendered).toContain("[2]");
      expect(rendered).toContain("Ignore folders");
      expect(rendered).toContain("docs");
    });
  });
});
