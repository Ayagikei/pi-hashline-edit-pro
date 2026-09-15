import { afterEach } from "vitest";
import { resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests } from "../../src/batch";
import { clearAutoReadAllComplete } from "../../src/auto-read-all-state";

afterEach(() => {
  resetRegistryForTests();
  resetBatchStateForTests();
  clearAutoReadAllComplete();
});
