import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../../src/config";
import { withTempDir, makePiStub } from "../support/fixtures";


async function registerExtension(pi: any) {
  const { default: register } = await import("../../index");
  register(pi);
}

describe("session_start lifecycle", () => {
  it("removes the built-in edit and grep tools while keeping anchor_grep", async () => {
    await withTempDir("lifecycle-tools-", async (dir) => {
      const { pi, handlers } = makePiStub();
      pi.setActiveTools(["read", "replace", "edit", "grep", "anchor_grep", "bash"]);
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeDefined();
      await sessionStart!({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect(pi.getActiveTools()).toEqual(["read", "replace", "anchor_grep", "bash"]);
    });
  });

  it("notifies when PI_HASHLINE_DEBUG is enabled", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "1");
    try {
      await withTempDir("lifecycle-debug-", async (dir) => {
        const { pi, handlers, notify } = makePiStub();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify } });
        expect(notify).toHaveBeenCalledWith("Hashline Edit mode active", "info");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stays silent without PI_HASHLINE_DEBUG", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "0");
    try {
      await withTempDir("lifecycle-quiet-", async (dir) => {
        const { pi, handlers, notify } = makePiStub();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify } });
        expect(notify).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads auto-read preference from config", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "0");
    try {
      await withTempDir("lifecycle-config-", async (dir) => {
        const { mkdir, writeFile } = await import("fs/promises");
        const { join } = await import("path");
        await mkdir(join(dir, ".config", "pi-hashline-edit-pro"), { recursive: true });
        await writeFile(
          join(dir, ".config", "pi-hashline-edit-pro", "config.json"),
          JSON.stringify({ autoRead: false }),
          "utf-8",
        );
        const { pi, handlers } = makePiStub();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect((await readConfig()).autoRead).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the sidecar of a session whose file does not exist yet", async () => {
    await withTempDir("lifecycle-pending-session-", async (dir) => {
      const { readFile, readdir } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const ctx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "pending" } };
      await handlers.get("session_start")!({}, ctx);
      const { allocateAnchor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      await withAnchorSession(ctx, () => allocateAnchor("a.ts", "ck"));
      const sidecars = await readdir(sessionClaimsDir());
      expect(sidecars).toHaveLength(1);
      const lines = (await readFile(join(sessionClaimsDir(), sidecars[0]!), "utf-8")).split("\n");
      expect(JSON.parse(lines[0]!).kind).toBe("session");
      expect(JSON.parse(lines[1]!).kind).toBe("allocate");
    });
  });
});

describe("hashline-config command", () => {
  it("is registered alongside clear-anchors", async () => {
    await withTempDir("lifecycle-config-cmd-", async (dir) => {
      const { pi, handlers, commands, notify } = makePiStub();
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start")!;
      await sessionStart({}, { cwd: dir, ui: { notify } });
      expect(commands.has("hashline-config")).toBe(true);
      expect(commands.has("clear-anchors")).toBe(true);
    });
  });

  it("requires interactive mode", async () => {
    await withTempDir("lifecycle-config-tty-", async (dir) => {
      const { pi, handlers, commands, notify } = makePiStub();
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start")!;
      await sessionStart({}, { cwd: dir, ui: { notify } });
      const command = commands.get("hashline-config");
      expect(command).toBeDefined();
      await command!.handler([], { cwd: dir, hasUI: false, ui: { notify } });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
    });
  });
});

describe("session_shutdown lifecycle", () => {
  it("releases the session's anchor registry", async () => {
    await withTempDir("lifecycle-shutdown-", async (dir) => {
      const { rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const sessionFile = join(dir, "session.jsonl");
      await writeFile(sessionFile, "", "utf-8");
      const { pi, handlers } = makePiStub();
      await registerExtension(pi);
      const ctx = { cwd: dir, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "shutdown" } };
      await handlers.get("session_start")!({}, ctx);
      const { allocateAnchor, ownerOf, sessionKeyFor, withAnchorSession } = await import("../../src/anchor-registry");
      const { sessionClaimsDir } = await import("../../src/paths");
      const anchor = await withAnchorSession(ctx, () => allocateAnchor("a.ts", "ck"));
      await rm(join(sessionClaimsDir(), `${sessionKeyFor(ctx)!}.registry.jsonl`), { force: true });
      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
      expect(await withAnchorSession(ctx, () => ownerOf(anchor))).toBeUndefined();
    });
  });
});
