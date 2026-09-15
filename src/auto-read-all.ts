import { execFile } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import {
  AUTO_READ_ALL_MAX_BUDGET_BYTES,
  AUTO_READ_ALL_MAX_FILE_BYTES,
  AUTO_READ_ALL_MAX_FILES,
  AUTO_READ_ALL_MIN_BUDGET_BYTES,
  SNIFF_BYTES,
} from "./constants";
import { markServed as markServedScoped } from "./anchor-registry";
import { readNormFile } from "./file-reader";
import { resolveRgPath } from "./grep";
import { MAX_HASH_LINES } from "./hashline";
import { fmtReadPreview } from "./read";
import { buildServedMap } from "./served";
import { splitLines } from "./utils";

const EXEC_TIMEOUT_MS = 20_000;
const EXEC_MAX_BYTES = 64 * 1024 * 1024;
const SCAN_CONCURRENCY = 32;
const SCAN_LIMIT_MULTIPLIER = 4;
const MAX_REPORTED_OMISSIONS = 50;

const HEADER =
  "[hashline auto-read-all] The content of every non-ignored project file is attached below with live hashline anchors. Each anchor│content row is already owned and served for this session, so replace and insert can target those anchors directly without calling read first. Rows with a truncation hint are only partially shown; call read with the hinted offset to see the rest.";

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".jxl",
  ".png",
  ".psd",
  ".tif",
  ".tiff",
  ".webp",
]);

export const AUTO_READ_ALL_EXCLUDED_NAMES = ["package-lock.json"];

const EXCLUDED_NAME_SET = new Set(AUTO_READ_ALL_EXCLUDED_NAMES);

const WALK_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".tmp",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

export type AutoReadAllSource = "git" | "rg" | "walk";

export interface AutoReadAllDiscovery {
  files: string[];
  source: AutoReadAllSource;
  discovered: number;
  skippedBinary: number;
  skippedLarge: number;
  skippedOther: number;
  skippedByName: number;
}

export interface AutoReadAllInjection {
  text: string;
  files: number;
  bytes: number;
  omitted: string[];
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolveResult) => {
    execFile(command, args, { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BYTES }, (error, stdout) => {
      if (error === null) {
        resolveResult({ stdout: stdout ?? "", code: 0 });
        return;
      }
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolveResult({ stdout: stdout ?? "", code });
    });
  });
}

async function listFromGit(cwd: string): Promise<string[] | undefined> {
  const result = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
  if (result.code !== 0) return undefined;
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

async function listFromRg(cwd: string): Promise<string[] | undefined> {
  let rgPath: string;
  try {
    rgPath = await resolveRgPath();
  } catch {
    return undefined;
  }
  const result = await runCommand(rgPath, ["--files", "--hidden", "--no-require-git", "--glob", "!.git", "--null"], cwd);
  if (result.code === 1) return [];
  if (result.code !== 0) return undefined;
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

async function walkDir(dir: string, base: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_IGNORED_DIRS.has(entry.name)) continue;
      await walkDir(full, base, out);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(base, full)));
    }
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const base = baseNameOf(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

async function hasNulByte(path: string): Promise<boolean | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function forEachLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

export async function discoverAutoReadAllFiles(cwd: string): Promise<AutoReadAllDiscovery> {
  let source: AutoReadAllSource = "git";
  let candidates = await listFromGit(cwd);
  if (candidates === undefined) {
    candidates = await listFromRg(cwd);
    source = "rg";
  }
  if (candidates === undefined) {
    source = "walk";
    const walked: string[] = [];
    await walkDir(cwd, cwd, walked);
    candidates = walked;
  }

  const unique = [...new Set(candidates.map(toPosix))].sort();
  const includable: string[] = [];
  let skippedByName = 0;
  for (const file of unique) {
    if (EXCLUDED_NAME_SET.has(baseNameOf(file).toLowerCase())) skippedByName += 1;
    else includable.push(file);
  }
  const scanWindow = includable.slice(0, AUTO_READ_ALL_MAX_FILES * SCAN_LIMIT_MULTIPLIER);
  const sized: string[] = [];
  let skippedBinary = 0;
  let skippedLarge = 0;
  let skippedOther = 0;

  await forEachLimit(scanWindow, SCAN_CONCURRENCY, async (file) => {
    let stats;
    try {
      stats = await lstat(resolve(cwd, file));
    } catch {
      skippedOther += 1;
      return;
    }
    if (!stats.isFile()) {
      skippedOther += 1;
      return;
    }
    if (stats.size > AUTO_READ_ALL_MAX_FILE_BYTES) {
      skippedLarge += 1;
      return;
    }
    if (IMAGE_EXTENSIONS.has(extensionOf(file))) {
      skippedBinary += 1;
      return;
    }
    sized.push(file);
  });

  const textual: string[] = [];
  await forEachLimit(sized, SCAN_CONCURRENCY, async (file) => {
    const nul = await hasNulByte(resolve(cwd, file));
    if (nul === undefined) skippedOther += 1;
    else if (nul) skippedBinary += 1;
    else textual.push(file);
  });
  textual.sort();
  const files = textual.slice(0, AUTO_READ_ALL_MAX_FILES);

  return { files, source, discovered: unique.length, skippedBinary, skippedLarge, skippedOther, skippedByName };
}

async function renderFile(file: string, cwd: string): Promise<string | undefined> {
  try {
    const { normalized, fileHashes, absolutePath } = await readNormFile(file, cwd, { maxLines: MAX_HASH_LINES });
    const preview = await fmtReadPreview(normalized, {}, fileHashes, absolutePath, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES);
    markServedScoped(absolutePath, buildServedMap(fileHashes, splitLines(normalized), preview.servedHashes), new Set(fileHashes));
    return `=== ${file} ===\n${preview.text}`;
  } catch (error) {
    console.error(`Auto-read all: skipped ${file}:`, error);
    return undefined;
  }
}

function buildFooter(attached: number, discovery: AutoReadAllDiscovery, omitted: string[]): string {
  const notes: string[] = [];
  const beyondCap = Math.max(
    0,
    discovery.discovered - discovery.files.length - discovery.skippedBinary - discovery.skippedLarge - discovery.skippedOther - discovery.skippedByName,
  );
  if (beyondCap > 0) notes.push(`${beyondCap} file(s) beyond the ${AUTO_READ_ALL_MAX_FILES}-file cap skipped`);
  if (discovery.skippedBinary > 0) notes.push(`${discovery.skippedBinary} binary or image file(s) skipped`);
  if (discovery.skippedLarge > 0) notes.push(`${discovery.skippedLarge} file(s) over ${formatSize(AUTO_READ_ALL_MAX_FILE_BYTES)} skipped`);
  if (discovery.skippedOther > 0) notes.push(`${discovery.skippedOther} unreadable path(s) skipped`);
  if (discovery.skippedByName > 0) notes.push(`${discovery.skippedByName} file(s) skipped by name (${AUTO_READ_ALL_EXCLUDED_NAMES.join(", ")})`);
  const listed = omitted.slice(0, MAX_REPORTED_OMISSIONS).join(", ");
  const more = omitted.length > MAX_REPORTED_OMISSIONS ? `, ... (+${omitted.length - MAX_REPORTED_OMISSIONS} more)` : "";
  const omissionNote = omitted.length > 0 ? ` Not attached: ${listed}${more}. Use read for those.` : "";
  const summary = notes.length > 0 ? notes.join("; ") + "." : "all discovered files attached.";
  return `[hashline auto-read-all: ${attached} file(s) attached from ${discovery.source}; ${summary}${omissionNote}]`;
}

export async function buildAutoReadAllInjection(cwd: string, budgetBytes: number): Promise<AutoReadAllInjection | undefined> {
  const discovery = await discoverAutoReadAllFiles(cwd);
  if (discovery.files.length === 0) return undefined;
  const sections: string[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const file of discovery.files) {
    const section = await renderFile(file, cwd);
    if (section === undefined) {
      omitted.push(file);
      continue;
    }
    const sectionBytes = Buffer.byteLength(section, "utf-8") + 1;
    if (sections.length > 0 && bytes + sectionBytes > budgetBytes) {
      omitted.push(file);
      continue;
    }
    sections.push(section);
    bytes += sectionBytes;
  }
  if (sections.length === 0) return undefined;
  const text = `${HEADER}\n\n${sections.join("\n\n")}\n\n${buildFooter(sections.length, discovery, omitted)}`;
  return { text, files: sections.length, bytes, omitted };
}

export function autoReadAllBudget(model: { contextWindow?: number } | undefined): number {
  const contextWindow = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 0;
  const fromContext = Math.floor(contextWindow * 1.5);
  return Math.min(AUTO_READ_ALL_MAX_BUDGET_BYTES, Math.max(AUTO_READ_ALL_MIN_BUDGET_BYTES, fromContext));
}
