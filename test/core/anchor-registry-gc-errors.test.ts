import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gcRegistrySidecars, initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { sessionClaimsDir } from "../../src/paths";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    open: vi.fn(actual.open),
    stat: vi.fn(actual.stat),
    rm: vi.fn(actual.rm),
  };
});

let dir: string;

beforeEach(async () => {
  resetRegistryForTests();
  const root = resolve(".tmp");
  await mkdir(root, { recursive: true });
  dir = await mkdtemp(join(root, "registry-gc-errors-"));
  vi.stubEnv("PI_HASHLINE_DIR", dir);
  await mkdir(sessionClaimsDir());
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(readdir).mockImplementation(actual.readdir as never);
  vi.mocked(open).mockImplementation(actual.open as never);
  vi.mocked(stat).mockImplementation(actual.stat as never);
  vi.mocked(rm).mockImplementation(actual.rm as never);
  vi.unstubAllEnvs();
  resetRegistryForTests();
  rmSync(dir, { recursive: true, force: true });
});

const operations = ["list", "read", "session-stat", "remove", "temp-stat", "temp-remove"] as const;

async function sidecarFor(operation: typeof operations[number]): Promise<{ path: string; content: string }> {
  const temporary = operation.startsWith("temp-");
  const path = join(sessionClaimsDir(), temporary ? "old.registry.jsonl.compact-test" : "old.registry.jsonl");
  const content = JSON.stringify({ kind: "session", sessionFile: join(dir, "missing-session.jsonl") }) + "\n";
  await writeFile(path, content);
  if (temporary) await utimes(path, new Date(0), new Date(0));
  return { path, content };
}

function failOperation(operation: typeof operations[number], error: Error): void {
  switch (operation) {
    case "list": vi.mocked(readdir).mockRejectedValueOnce(error); break;
    case "read": vi.mocked(open).mockRejectedValueOnce(error); break;
    case "session-stat":
    case "temp-stat": vi.mocked(stat).mockRejectedValueOnce(error); break;
    case "remove":
    case "temp-remove": vi.mocked(rm).mockRejectedValueOnce(error); break;
  }
}

describe.each(["EPERM", "EACCES"])("registry GC with %s", (code) => {
  it.each(operations)("preserves sidecars without logging on %s failure", async (operation) => {
    const { path, content } = await sidecarFor(operation);
    failOperation(operation, Object.assign(new Error("permission denied"), { code }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(gcRegistrySidecars()).resolves.toBeUndefined();
    expect(await readFile(path, "utf-8")).toBe(content);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe("registry GC unexpected errors", () => {
  it.each(operations)("keeps %s failures observable", async (operation) => {
    const { path, content } = await sidecarFor(operation);
    const error = Object.assign(new Error("I/O error"), { code: "EIO" });
    failOperation(operation, error);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    if (operation === "remove") {
      await expect(gcRegistrySidecars()).rejects.toBe(error);
    } else {
      await gcRegistrySidecars();
      expect(errors).toHaveBeenCalledWith(expect.any(String), error);
    }
    expect(await readFile(path, "utf-8")).toBe(content);
  });
});

describe("registry GC bounded inspection", () => {
  it("inspects at most eight sidecars concurrently and deletes in listed order", async () => {
    const names = Array.from({ length: 9 }, (_, index) => `${String(index).padStart(2, "0")}.registry.jsonl`);
    const missing = join(dir, "batched-missing.jsonl");
    const content = Buffer.from(`${JSON.stringify({ kind: "session", sessionFile: missing })}\n`);
    vi.mocked(readdir).mockResolvedValueOnce(names as never);
    let inflight = 0;
    let max = 0;
    const events: string[] = [];
    vi.mocked(open).mockImplementation(((path: string) => {
      const name = basename(path);
      inflight += 1;
      max = Math.max(max, inflight);
      events.push(`start:${name}`);
      const handle = {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (position >= content.length) return { bytesRead: 0 };
          const bytesRead = Math.min(length, content.length - position);
          content.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
        close: async () => {},
      };
      return new Promise((resolve) => {
        void Promise.resolve().then(() => {
          inflight -= 1;
          events.push(`end:${name}`);
          resolve(handle as never);
        });
      });
    }) as never);
    vi.mocked(stat).mockImplementation((async (path: string) => {
      if (path === missing) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return actual.stat(path);
    }) as never);
    const removed: string[] = [];
    vi.mocked(rm).mockImplementation((async (path: string) => {
      const name = basename(path);
      removed.push(name);
      events.push(`rm:${name}`);
    }) as never);

    await gcRegistrySidecars();

    expect(max).toBe(8);
    expect(max).toBeLessThanOrEqual(8);
    expect(events.indexOf("rm:00.registry.jsonl")).toBeGreaterThan(events.indexOf("start:07.registry.jsonl"));
    expect(events.indexOf("start:08.registry.jsonl")).toBeGreaterThan(events.indexOf("rm:07.registry.jsonl"));
    expect(removed).toEqual(names);
  });

  it("does not read a sidecar that is already claimed", async () => {
    const sessionFile = join(dir, "already-claimed.jsonl");
    await writeFile(sessionFile, "");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    await initRegistry(sessionFile);
    await rm(sessionFile, { force: true });
    const opened: string[] = [];
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation((async (path: string, flags?: string) => {
      opened.push(String(path));
      return actual.open(path, flags);
    }) as never);
    await gcRegistrySidecars();
    expect(opened).not.toContain(sidecar);
    await expect(readFile(sidecar, "utf-8")).resolves.toContain("session");
  });

  it("keeps a sidecar claimed after inspection and before deletion", async () => {
    const sessionFile = join(dir, "claimed-later.jsonl");
    await writeFile(sessionFile, "");
    const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
    const sidecar = join(sessionClaimsDir(), `${key}.registry.jsonl`);
    const missing = join(dir, "claimed-later-missing.jsonl");
    await writeFile(sidecar, `${JSON.stringify({ kind: "session", sessionFile: missing })}\n`);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let claimedDuringInspect = false;
    vi.mocked(stat).mockImplementation((async (path: string) => {
      if (path === missing) {
        await initRegistry(sessionFile);
        claimedDuringInspect = true;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return actual.stat(path);
    }) as never);
    await gcRegistrySidecars();
    expect(claimedDuringInspect).toBe(true);
    await expect(readFile(sidecar, "utf-8")).resolves.toContain("session");
  });

  it("removes compact files older than one hour and keeps newer ones", async () => {
    const stale = join(sessionClaimsDir(), "stale.registry.jsonl.compact-old");
    const fresh = join(sessionClaimsDir(), "fresh.registry.jsonl.compact-new");
    await writeFile(stale, "old");
    await writeFile(fresh, "new");
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, oldTime, oldTime);
    await gcRegistrySidecars();
    await expect(readFile(stale, "utf-8")).rejects.toThrow();
    await expect(readFile(fresh, "utf-8")).resolves.toBe("new");
  });
});
