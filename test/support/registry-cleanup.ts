import { afterEach } from "vitest";
import { resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests } from "../../src/batch";
import { clearAllAutoReadAllComplete } from "../../src/auto-read-all-state";

afterEach(() => {
  resetRegistryForTests();
  resetBatchStateForTests();
  clearAllAutoReadAllComplete();
});
