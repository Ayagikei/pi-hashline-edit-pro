import { join } from "path";
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { compPreview, editToolSchema, regReplace } from "../../src/replace";
import { makeFakePiRegistry, withTempFile, useTestHome } from "../support/fixtures";
useTestHome();

describe("editToolSchema", () => {
  it("has remove_from, remove_to, and replacement_lines at top level", () => {
    const schema = editToolSchema as any;
    expect(schema.type).toBe("object");
    const props = schema.properties;
    expect(props.path).toBeUndefined();
    expect(props.remove_from).toBeDefined();
    expect(props.remove_to).toBeDefined();
    expect(props.replacement_lines).toBeDefined();
    expect(props.changes).toBeUndefined();
    expect(schema.additionalProperties).toBe(true);
  });
});

describe("regReplace", () => {
  it("registers a tool named 'replace'", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplace(pi);
    const tool = getTool("replace");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("replace");
    expect(tool.parameters).toBe(editToolSchema);
  });

  it("prepareArguments normalizes replace_from/replace_to to remove_from/remove_to", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplace(pi);
    const tool = getTool("replace");
    const result = tool.prepareArguments({
      replace_from: "ATIm", replace_to: "BeSR",
      replacement_lines: ["new"],
    });
    expect(result.remove_from).toBe("ATIm");
    expect(result.remove_to).toBe("BeSR");
    expect(result.replace_from).toBeUndefined();
    expect(result.replace_to).toBeUndefined();
  });



  it("replaces a single line via execute", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BeSR"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("ignores a numeric path sentinel from grok (path: -1)", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BeSR"],
          path: -1,
        } as any,
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(await readFile(join(cwd, "sample.txt"), "utf-8")).toBe("aaa\nBeSR\nccc\n");
    });
  });

  it("ignores an extra string path in anchor-only mode", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BeSR"],
          path: "sample.txt",
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
    });
  });

  it("replaces a single line via the replace_from/replace_to aliases", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          replace_from: hashes[1]!, replace_to: hashes[1]!,
          replacement_lines: ["BeSR"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("replaces a single line via the from/to aliases", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          from: hashes[1]!, to: hashes[1]!,
          replacement_lines: ["BeSR"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it("replaces a range of lines via execute", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\nddd\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[2]!,
          replacement_lines: ["BeSR", "DAfo"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 2 line(s), removed 2 line(s).");
    });
  });

  it("deletes a line via execute (empty content_lines)", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: [],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).toContain("Added 0 line(s), removed 1 line(s).");
    });
  });

  it("reports noop when content is unchanged", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["bbb"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("No changes made to sample.txt");
      expect(result.details.classification).toBe("noop");
    });
  });

  it("rejects stale anchors with [E_STALE_ANCHOR]", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");

      await expect(
        tool.execute(
          "e1",
          {
            remove_from: "PyBY", remove_to: "PyBY",
            replacement_lines: ["x"],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("rejects deleting an entire non-empty file", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\n", join(cwd, "sample.txt"));

      await expect(
        tool.execute(
          "e1",
          {
            remove_from: hashes[0]!, remove_to: hashes[1]!,
            replacement_lines: [],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_WOULD_EMPTY/);
    });
  });

  it("rejects unknown fields at top level via schema validation", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      await expect(
        tool.execute(
          "e1",
          {
            remove_from: hashes[1]!, remove_to: hashes[1]!,
            replacement_lines: ["BeSR"],
            unknown_field: "bad",
          } as any,
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/unknown_field/);
    });
  });

  it("reports metrics with edits_attempted = 1", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BeSR"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.details.metrics.edits_attempted).toBe(1);
      expect(result.details.metrics.classification).toBe("applied");
    });
  });

  it("preserves CRLF line endings", async () => {
    await withTempFile("crlf.txt", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);

      await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
    });
  });

  it("expands a stringified replacement_lines array", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ['["B1", "B2"]'],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(await readFile(path, "utf-8")).toBe("aaa\nB1\nB2\nccc\n");
    });
  });

  it("applies stringified arrays with trailing commas and single quotes", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ["['B1', 'B2',]"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(await readFile(path, "utf-8")).toBe("aaa\nB1\nB2\nccc\n");
    });
  });

  it("rejects a NUL byte in replacement_lines and leaves the file unchanged", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      const nul = String.fromCharCode(0);

      await expect(tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: [`a${nul}b`],
        },
        undefined,
        undefined,
        { cwd } as any,
      )).rejects.toThrow(/NUL byte/);

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("rejects a NUL byte decoded from stringified array text", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);
      const backslash = String.fromCharCode(92);

      await expect(tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: [`["${backslash}u0000"]`],
        },
        undefined,
        undefined,
        { cwd } as any,
      )).rejects.toThrow(/NUL byte/);

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("warns instead of writing unparseable string-array text literally", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      const result = await tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ['["B1", 7]'],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("looked like a JSON array but could not be parsed");
      expect(await readFile(path, "utf-8")).toBe('aaa\n["B1", 7]\nccc\n');
    });
  });

  it("rejects unparseable string-array text in strict-input mode", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      await mkdir(join(cwd, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(
        join(cwd, ".config", "pi-hashline-edit-pro", "config.json"),
        JSON.stringify({ autoRead: true, strictInput: true }),
        "utf-8",
      );
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", path);

      await expect(tool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!,
          replacement_lines: ['["B1", 7]'],
        },
        undefined,
        undefined,
        { cwd } as any,
      )).rejects.toThrow("[E_BAD_SHAPE] Strict-input mode rejects auto-fixable input");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("rejects unresolvable anchors before any file I/O", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplace(pi);
    const tool = getTool("replace");
    await expect(tool.execute(
      "e1",
      { remove_from: "!!!!", remove_to: "!!!!", replacement_lines: ["x"] },
      undefined, undefined, { cwd: "/tmp" } as any,
    )).rejects.toThrow(/\[E_BAD_REF\]/);
  });

  it("does not reject a passed path in anchor-only mode", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplace(pi);
    const tool = getTool("replace");
    await expect(tool.execute(
      "e1",
      { path: "sample.ts", remove_from: "PyBY", remove_to: "PyBY", replacement_lines: ["x"] } as any,
      undefined, undefined, { cwd: "/tmp" } as any,
    )).rejects.toThrow(/E_STALE_ANCHOR/);
  });

  it("rethrows aborts from preview computation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(compPreview({ remove_from: "!!!!", remove_to: "!!!!", replacement_lines: ["x"] }, "/tmp", controller.signal)).rejects.toThrow();
  });
});

describe("regReplace - stringified replacement_lines payloads", () => {
  const glmMapPayload = '["    \\"pi-hashline-edit-pro\\": \\"^4.3.5\\","].map(s => s)';
  const glmSlicePayload = '["    \\"@cortexkit/aft\\": \\"^0.57.0\\",", "    \\"@cortexkit/aft-pi\\": \\"^0.57.0\\","].slice(0, 3)';
  const glmMalformedPayload = '["    \\"pi-hashline-edit-pro\\": \\"^4.3.5\\",""]';

  it("writes the intended line for a method-chained stringified array", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: glmMapPayload },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(result.content[0].text).not.toContain("[W_BAD_SHAPE]");
      expect(await readFile(path, "utf-8")).toBe('aaa\n    "pi-hashline-edit-pro": "^4.3.5",\nccc\n');
    });
  });

  it("writes every line of a method-chained stringified array", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: glmSlicePayload },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      expect(await readFile(path, "utf-8")).toBe('aaa\n    "@cortexkit/aft": "^0.57.0",\n    "@cortexkit/aft-pi": "^0.57.0",\nccc\n');
    });
  });

  it("warns and keeps a malformed stringified array literal", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplace(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "sample.txt"));

      const result = await tool.execute(
        "e1",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: glmMalformedPayload },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("[W_BAD_SHAPE]");
      expect(await readFile(path, "utf-8")).toBe('aaa\n["    \\"pi-hashline-edit-pro\\": \\"^4.3.5\\",""]\nccc\n');
    });
  });
});
