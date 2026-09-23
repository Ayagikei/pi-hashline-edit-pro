import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ lockStats: 0, lockRms: 0, replaceInode: false, failFirstLockStat: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (target: any, options?: any) => {
      if (String(target).endsWith(".lock")) {
        state.lockStats += 1;
        if (state.failFirstLockStat && state.lockStats === 1) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        const stats = await (actual.stat as any)(target, options);
        if (state.replaceInode && state.lockStats > 1) return Object.assign(stats, { ino: stats.ino + 1 });
        return stats;
      }
      return (actual.stat as any)(target, options);
    },
    rm: async (target: any, options?: any) => {
      if (String(target).endsWith(".lock")) state.lockRms += 1;
      return (actual.rm as any)(target, options);
    },
  };
});

import { lstat } from "node:fs/promises";
import { updateConfig } from "../../src/config";
import { configPath } from "../../src/paths";
import { withTempDir } from "../support/fixtures";

beforeEach(() => {
  state.lockStats = 0;
  state.lockRms = 0;
  state.replaceInode = false;
  state.failFirstLockStat = false;
});

describe("config lock release identity", () => {
  it("removes the lock it acquired", async () => {
    await withTempDir("pi-hashline-lock-identity-", async () => {
      await updateConfig((config) => {
        config.autoRead = false;
      });
      expect(state.lockStats).toBe(2);
      expect(state.lockRms).toBe(1);
      await expect(lstat(`${configPath()}.lock`)).rejects.toThrow();
    });
  });

  it("keeps a lock that was replaced after acquisition", async () => {
    state.replaceInode = true;
    await withTempDir("pi-hashline-lock-replaced-", async () => {
      await updateConfig((config) => {
        config.autoRead = false;
      });
      expect(state.lockStats).toBe(2);
      expect(state.lockRms).toBe(0);
      expect((await lstat(`${configPath()}.lock`)).isDirectory()).toBe(true);
    });
  });

  it("relinquishes the lock and retries when it cannot verify the lock identity", async () => {
    state.failFirstLockStat = true;
    await withTempDir("pi-hashline-lock-unverifiable-", async () => {
      const config = await updateConfig((current) => {
        current.autoRead = false;
      });
      expect(config.autoRead).toBe(false);
      expect(state.lockStats).toBe(3);
      expect(state.lockRms).toBe(2);
      await expect(lstat(`${configPath()}.lock`)).rejects.toThrow();
    });
  });
});
