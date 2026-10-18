import { Type } from "typebox";
import { isRec, normalizeRequest, rejectUnknownFields, assertNoNul } from "./utils";
import { TEXT_NOT_STRING_MSG, NEW_CONTENT_NOT_STRING_MSG } from "./constants";

const textSchema = Type.String({
  description:
    'The exact text to write in place of the removed range. "" deletes the range. A trailing line break sets the newline of the last line written instead of adding a blank line; a lone newline writes one blank line.',
});

const removeFromSchema = Type.String({
  description:
    "4-char anchor of the FIRST line to remove (never the row content).",
});

const removeToSchema = Type.String({
  description:
    "4-char anchor of the LAST line to remove.",
});
const pathRequiredSchema = Type.String({
  description:
    "Path to the file the anchors were served for; required and must match anchor ownership.",
});

export const editToolSchema = Type.Object(
  {
    remove_from: removeFromSchema,
    remove_to: removeToSchema,
    text: textSchema,
  },
  { additionalProperties: true },
);

export function buildEditToolSchema(requirePath: boolean): typeof editToolSchema {
  if (!requirePath) return editToolSchema;
  return Type.Object(
    {
      path: pathRequiredSchema,
      remove_from: removeFromSchema,
      remove_to: removeToSchema,
      text: textSchema,
    },
    { additionalProperties: true },
  ) as typeof editToolSchema;
}

export type ReqParams = {
  path?: string;
  remove_from: string;
  remove_to: string;
  text: string;
};

export type RawReqParams = {
  path?: string;
  remove_from: string;
  remove_to: string;
  text: string | string[];
};


function dropNonStringPath(request: Record<string, unknown>): void {
  if (typeof request.path !== "string") delete request.path;
}

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "text"]);
export function assertReq(request: unknown): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }
  rejectUnknownFields(request, ROOT_KS, "Edit request");
  dropNonStringPath(request);
  if (
    typeof request.remove_from !== "string" ||
    typeof request.remove_to !== "string"
  ) {
    throw new Error(
      '[E_BAD_SHAPE] Edit request requires "remove_from" and "remove_to" anchor strings and a "text" string with the exact text to write.',
    );
  }
  if (typeof request.text !== "string") {
    throw new Error(NEW_CONTENT_NOT_STRING_MSG);
  }
  assertNoNul([request.text]);
}

export { normalizeRequest as normReq } from "./utils";

export function getPreviewInput(args: unknown): { path?: string; remove_from: string; remove_to: string; text: string } | null {
  let normalized: unknown;
  try {
    normalized = normalizeRequest(args, "remove");
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.remove_from !== "string" ||
    typeof normalized.remove_to !== "string" ||
    typeof normalized.text !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    remove_from: normalized.remove_from as string,
    remove_to: normalized.remove_to as string,
    text: normalized.text,
  };
}

const INSERT_KS = new Set(["path", "anchor", "direction", "text"]);

export interface InsertReq {
  path?: string;
  anchor: string;
  direction: "before" | "after";
  text: string;
}

export function assertInsertReq(request: unknown): asserts request is InsertReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Insert request must be an object.");
  }
  rejectUnknownFields(request, INSERT_KS, "Insert request");
  dropNonStringPath(request);
  if (typeof request.anchor !== "string" || request.anchor.length === 0) {
    throw new Error('[E_BAD_SHAPE] Insert request requires an "anchor" string (4-char anchor from read output).');
  }
  if (request.direction !== "before" && request.direction !== "after") {
    throw new Error('[E_BAD_SHAPE] Insert request "direction" must be "before" or "after".');
  }
  if (typeof request.text !== "string") {
    throw new Error(TEXT_NOT_STRING_MSG);
  }
  assertNoNul([request.text]);
}

const TRANSFER_KEYS = new Set(["path", "source_from", "source_to", "insert_after"]);

export interface TransferReq {
  path?: string;
  source_from: string;
  source_to: string;
  insert_after: string;
}

export function assertTransferReq(request: unknown): asserts request is TransferReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Copy/move request must be an object.");
  }
  rejectUnknownFields(request, TRANSFER_KEYS, "Copy/move request");
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Copy/move request field "path" must be a string when provided.');
  }
  if (typeof request.source_from !== "string" || request.source_from.length === 0) {
    throw new Error('[E_BAD_SHAPE] Copy/move request requires a "source_from" string (4-char anchor from read output).');
  }
  if (typeof request.source_to !== "string" || request.source_to.length === 0) {
    throw new Error('[E_BAD_SHAPE] Copy/move request requires a "source_to" string (4-char anchor from read output).');
  }
  if (typeof request.insert_after !== "string" || request.insert_after.length === 0) {
    throw new Error('[E_BAD_SHAPE] Copy/move request requires an "insert_after" string (4-char anchor from read output).');
  }
}

const MATCH_KS = new Set(["path", "replace_from", "replace_to", "old_string", "new_string"]);

export interface ReplaceMatchReq {
  path?: string;
  replace_from: string;
  replace_to: string;
  old_string: string;
  new_string: string;
}

export function assertReplaceMatchReq(request: unknown): asserts request is ReplaceMatchReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Replace-match request must be an object.");
  }
  rejectUnknownFields(request, MATCH_KS, "Replace-match request");
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Replace-match request field "path" must be a string when provided.');
  }
  for (const key of ["replace_from", "replace_to", "old_string", "new_string"] as const) {
    if (typeof (request as Record<string, unknown>)[key] !== "string") {
      throw new Error(`[E_BAD_SHAPE] Replace-match request requires a "${key}" string.`);
    }
  }
  const within = request as unknown as ReplaceMatchReq;
  if (within.replace_from.length === 0 || within.replace_to.length === 0) {
    throw new Error('[E_BAD_SHAPE] Replace-match request requires non-empty "replace_from" and "replace_to" anchors.');
  }
  if (within.old_string.length === 0) {
    throw new Error('[E_BAD_SHAPE] Replace-match request field "old_string" must be a non-empty string holding the exact text to find.');
  }
  assertNoNul([within.new_string]);
}

export function getReplaceMatchInput(args: unknown): { path?: string; replace_from: string; replace_to: string; old_string: string; new_string: string } | null {
  let normalized: unknown;
  try {
    normalized = normalizeRequest(args, "replace");
  } catch {
    return null;
  }
  if (!isRec(normalized)) return null;
  if (
    typeof normalized.replace_from !== "string" ||
    typeof normalized.replace_to !== "string" ||
    typeof normalized.old_string !== "string" ||
    typeof normalized.new_string !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof normalized.path === "string" ? { path: normalized.path } : {}),
    replace_from: normalized.replace_from,
    replace_to: normalized.replace_to,
    old_string: normalized.old_string,
    new_string: normalized.new_string,
  };
}

const replaceMatchFromSchema = Type.String({
  description:
    "4-char anchor of the FIRST line of the range searched (never the row content).",
});
const replaceMatchToSchema = Type.String({
  description:
    "4-char anchor of the LAST line of the range searched; same as replace_from for a single line.",
});
const replaceMatchOldStringSchema = Type.String({
  description:
    "The exact text to find inside the selected line(s), copied from the served row. Every occurrence inside the range is replaced; the text around each match is left untouched. Matching uses LF line breaks and excludes the last line's terminator.",
});
const replaceMatchNewStringSchema = Type.String({
  description:
    'The exact replacement for every matched occurrence. "" deletes the matches. A trailing line break sets the newline of the last line written instead of adding a blank line; a lone newline writes one blank line; the rest of the range is kept byte-for-byte.',
});
const replaceMatchPathRequiredSchema = Type.String({
  description:
    "Path to the file the anchors were served for; required and must match anchor ownership.",
});

export const replaceMatchToolSchema = Type.Object(
  {
    replace_from: replaceMatchFromSchema,
    replace_to: replaceMatchToSchema,
    old_string: replaceMatchOldStringSchema,
    new_string: replaceMatchNewStringSchema,
  },
  { additionalProperties: true },
);

export function buildReplaceMatchToolSchema(requirePath: boolean): typeof replaceMatchToolSchema {
  if (!requirePath) return replaceMatchToolSchema;
  return Type.Object(
    {
      path: replaceMatchPathRequiredSchema,
      replace_from: replaceMatchFromSchema,
      replace_to: replaceMatchToSchema,
      old_string: replaceMatchOldStringSchema,
      new_string: replaceMatchNewStringSchema,
    },
    { additionalProperties: true },
  ) as typeof replaceMatchToolSchema;
}
