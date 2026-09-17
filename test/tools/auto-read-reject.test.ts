import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, rmRetry, setupIntegrationTest } from "../support/fixtures";
function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
}
async function writeConfig(cwd: string, config: Record<string, unknown>): Promise<void> {
  const configDir = join(cwd, ".config", "pi-hashline-edit-pro");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify(config), "utf-8");
}
function sessionContext(cwd: string, sessionFile?: string): unknown {
  return {
    cwd,
    hasUI: false,
    ui: { notify() {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionFile,
    },
  };
}
describe("auto-read-all read rejection", () => {
  it("rejects a read of an unchanged complete file", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-reject-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeConfig(cwd, { autoRead: true, anchorGrepEnabled: true, autoReadAll: "on" });
      const { handlers, getTool } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd) as never;
      await handlers.get("session_start")!({}, ctx);
      const injected = await handlers.get("before_agent_start")!({}, ctx) as { message?: { content?: string } } | undefined;
      expect(injected?.message?.content).toContain("=== sample.txt ===");
      await expect(getTool("read").execute("r1", { path: "sample.txt" }, undefined, undefined, ctx)).rejects.toThrow("[E_AUTO_READ_ALL]");
    } finally {
      await rmRetry(cwd);
    }
  });
  it("allows a read after the file changed externally", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-reject-changed-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeConfig(cwd, { autoRead: true, anchorGrepEnabled: true, autoReadAll: "on" });
      const { handlers, getTool } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd) as never;
      await handlers.get("session_start")!({}, ctx);
      await handlers.get("before_agent_start")!({}, ctx);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
      const result = await getTool("read").execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("│gamma");
    } finally {
      await rmRetry(cwd);
    }
  });
  it("allows a read when auto-read-all is off", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-reject-off-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      const { getTool } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd) as never;
      const result = await getTool("read").execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("│alpha");
    } finally {
      await rmRetry(cwd);
    }
  });
  it("does not reject a read in a session that did not attach the file", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-reject-scope-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeConfig(cwd, { autoRead: true, anchorGrepEnabled: true, autoReadAll: "on" });
      const { handlers, getTool } = setupIntegrationTest(cwd);
      const sessionA = sessionContext(cwd, join(cwd, "session-a.jsonl")) as never;
      await handlers.get("session_start")!({}, sessionA);
      const injected = await handlers.get("before_agent_start")!({}, sessionA) as { message?: { content?: string } } | undefined;
      expect(injected?.message?.content).toContain("=== sample.txt ===");
      await expect(getTool("read").execute("rA", { path: "sample.txt" }, undefined, undefined, sessionA)).rejects.toThrow("[E_AUTO_READ_ALL]");

      const sessionB = sessionContext(cwd, join(cwd, "session-b.jsonl")) as never;
      const first = await getTool("read").execute("r1", { path: "sample.txt" }, undefined, undefined, sessionB);
      expect(first.content[0].text).toContain("│alpha");
      const second = await getTool("read").execute("r2", { path: "sample.txt" }, undefined, undefined, sessionB);
      expect(second.content[0].text).toContain("│alpha");
    } finally {
      await rmRetry(cwd);
    }
  });
});
