import { describe, expect, it } from "vitest";
import { throwIfStrictInput } from "../../src/edit-common";
import { readConfig, writeConfig } from "../../src/config";
import { withTempDir } from "../support/fixtures";


describe("throwIfStrictInput", () => {
  it("passes through warnings when strict input is off", async () => {
    await withTempDir("pi-hashline-edit-common-test-", async () => {
      await expect(throwIfStrictInput(["[W_BAD_REF] stripped prefix"])).resolves.toBeUndefined();
      expect((await readConfig()).strictInput).toBe(false);
    });
  });

  it("rejects auto-fixable warnings when strict input is on", async () => {
    await withTempDir("pi-hashline-edit-common-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, strictInput: true });
      await expect(throwIfStrictInput(["[W_BAD_REF] stripped prefix"])).rejects.toThrow(
        "[E_BAD_SHAPE] Strict-input mode rejects auto-fixable input",
      );
    });
  });

  it("ignores messages that are not auto-fix warnings", async () => {
    await withTempDir("pi-hashline-edit-common-test-", async () => {
      await writeConfig({ autoRead: true, anchorGrepEnabled: true, strictInput: true });
      await expect(throwIfStrictInput(["plain message"])).resolves.toBeUndefined();
    });
  });
});
