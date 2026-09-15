import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { beforeAll, afterAll, afterEach, vi } from "vitest";
import { initHasher } from "../../src/hashline";
import { Compile } from "typebox/compile";
import register from "../../index";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests } from "../../src/batch";
import { errCode } from "../../src/utils";
const envRestores: Array<() => void> = [];

afterEach(() => {
  while (envRestores.length > 0) envRestores.pop()!();
  resetRegistryForTests();
  resetBatchStateForTests();
});

export async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}
export async function rmRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = errCode(error);
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      await loadHashStore().catch(() => undefined);
      shutdownHashStore();
      if (attempt === 9) throw error;
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}
export async function setupTestHome(): Promise<{
  home: string;
  testPath: string;
  cleanup: () => Promise<void>;
}> {
  await initHasher();
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-"));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('XDG_CONFIG_HOME', "");
  const testPath = join(tmpHome, "test.txt");
  return {
    home: tmpHome,
    testPath,
    cleanup: async () => {
      await loadHashStore().catch(() => undefined);
      shutdownHashStore();
      vi.unstubAllEnvs();
      await rmRetry(tmpHome);
    },
  };
}
export function useTestHome(): { testPath: string } {
  const state: { testPath: string } = { testPath: "" };
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const s = await setupTestHome();
    state.testPath = s.testPath;
    cleanup = s.cleanup;
  });
  afterAll(async () => {
    await cleanup?.();
  });
  return state;
}
export function withHome(home: string | undefined): () => void {
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = "";
  return () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  };
}
async function freshCwd(): Promise<{ cwd: string; restoreHome: () => void }> {
  const cwd = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-test-"));
  return { cwd, restoreHome: withHome(cwd) };
}
export async function withTempFile(
  name: string,
  content: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const { cwd, restoreHome } = await freshCwd();
  const path = join(cwd, name);
  try {
    await writeFile(path, content, "utf-8");
    await run({ cwd, path });
  } finally {
    await loadHashStore().catch(() => undefined);
    shutdownHashStore();
    await rmRetry(cwd);
    restoreHome();
  }
}
export async function withTempBytes(
  name: string,
  bytes: Uint8Array,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const { cwd, restoreHome } = await freshCwd();
  const path = join(cwd, name);
  try {
    await writeFile(path, bytes);
    await run({ cwd, path });
  } finally {
    await loadHashStore().catch(() => undefined);
    shutdownHashStore();
    await rmRetry(cwd);
    restoreHome();
  }
}
export async function withTempSubdir(
  name: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const { cwd, restoreHome } = await freshCwd();
  const path = join(cwd, name);
  try {
    await mkdir(path, { recursive: true });
    await run({ cwd, path });
  } finally {
    await loadHashStore().catch(() => undefined);
    shutdownHashStore();
    await rmRetry(cwd);
    restoreHome();
  }
}
export async function withTempDir(
  prefix: string,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  const restoreHome = withHome(dir);
  try {
    await run(dir);
  } finally {
    await loadHashStore().catch(() => undefined);
    shutdownHashStore();
    await rmRetry(dir);
    restoreHome();
  }
}
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  envRestores.push(withHome(dir));
  return dir;
}
export function makeFakePiRegistry() {
  const tools = new Map<string, any>();
  let activeTools: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    pi: {
      registerTool(tool: any) {
        const originalExecute = tool.execute;
        const validator = Compile(tool.parameters);
        tool.execute = async function(
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          ctx: unknown,
        ) {
          const prepared = tool.prepareArguments
            ? tool.prepareArguments(params)
            : params;
          if (!validator.Check(prepared)) {
            const errors = [...validator.Errors(prepared)]
              .map((e: any) => `  - ${e.message}`)
              .join("\n");
            const msg = "[E_BAD_SHAPE] Schema validation failed for tool \"" + tool.name + "\" after prepareArguments. The prepareArguments return value does not match the registered schema.\n" + errors;
            throw new Error(msg);
          }
          return originalExecute.call(this, toolCallId, prepared, signal, onUpdate, ctx);
        };
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      getActiveTools: () => activeTools,
      setActiveTools(next: string[]) {
        activeTools = next;
      },
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
    } as any,
    handlers,
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool;
    },
  };
}
export function setupIntegrationTest(cwd: string) {
  resetRegistryForTests();
  resetBatchStateForTests();
  initRegistry(undefined);
  const { pi, handlers, getTool } = makeFakePiRegistry();
  register(pi);
  const ctx = { cwd, ui: { notify() {} } } as any;
  return { pi, handlers, getTool, ctx, readTool: getTool("read"), editTool: getTool("replace") };
}
export function setupReadTest(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return { readTool: getTool("read"), ctx: { cwd } as any };
}
export function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}
export function extractHash(line: string): string {
  const m = line.match(/([A-Za-z0-9]{4})│/);
  return m ? m[1]! : line.split("│")[0]!;
}

export function anchorFor(text: string, needle: string): string {
  return extractHash(text.split("\n").find((line) => line.includes(`│${needle}`))!);
}

export function toolCall(id: string, name: string, args: unknown) {
  return { type: "toolCall", id, name, arguments: args };
}

export function assistantMessage(calls: Array<{ type: string; id: string; name: string; arguments: unknown }>) {
  return { role: "assistant", content: calls };
}

export function makePiStub(initialTools: string[] = []) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
  const tools = new Map<string, any>();
  const notify = vi.fn();
  let active = [...initialTools];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, def: { description: string; handler: (...args: any[]) => any }) {
      commands.set(name, def);
    },
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, handler);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  } as any;
  const getTool = (name: string) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool;
  };
  return { pi, handlers, commands, tools, notify, getTool, getActive: () => [...active] };
}
export function expectedEditContent(
  lines: string[],
  s: number,
  e: number,
  repl: string[],
  trailingNewline: boolean,
): string {
  const expected = [...lines.slice(0, s - 1), ...repl, ...lines.slice(e)].join("\n");
  if (trailingNewline) return expected + "\n";
  if (e === lines.length && repl.length === 0 && s >= 2 && lines[s - 2]!.length === 0) {
    return expected + "\n";
  }
  if (
    e === lines.length &&
    repl.length > 0 &&
    repl[repl.length - 1]!.length === 0 &&
    !(lines.length === 1 && lines[0]!.length === 0 && repl.length === 1 && repl[0]!.length === 0)
  ) {
    return expected + "\n";
  }
  return expected;
}
export async function makeTag(content: string, line: number, path: string): Promise<{ hash: string }> {
  const { lineHashes } = await import("../../src/hashline");
  const hashes = await lineHashes(content, path);
  return { hash: hashes[line - 1]! };
}
