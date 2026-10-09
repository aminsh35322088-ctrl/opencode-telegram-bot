import { describe, expect, it } from "vitest";
import {
  renderTelegramBlocks,
  renderTelegramParts,
  toRenderedBlocks,
} from "../../../src/bot/render/pipeline.js";
import { countRichBlocks, countRichChars } from "../../../src/bot/render/rich-blocks.js";
import { defined } from "../../helpers/defined.js";

describe("bot/render/pipeline", () => {
  it("renders markdown into native blocks paired with plain projections", () => {
    expect(renderTelegramBlocks("# Title\n\nParagraph with **bold**\n\n- item")).toEqual([
      {
        block: { type: "heading", text: "Title", size: 1 },
        plainText: "Title",
      },
      {
        block: { type: "paragraph", text: ["Paragraph with ", { type: "bold", text: "bold" }] },
        plainText: "Paragraph with bold",
      },
      {
        block: { type: "list", items: [{ blocks: [{ type: "paragraph", text: "item" }] }] },
        plainText: "• item",
      },
    ]);
  });

  it("preserves a nested native list and exact ordered numbering", () => {
    const markdown = ["1. one", "2. two", "   - child", "3. three"].join("\n");

    expect(renderTelegramBlocks(markdown).map((rendered) => rendered.block)).toEqual([
      {
        type: "list",
        items: [
          { type: "1", value: 1, blocks: [{ type: "paragraph", text: "one" }] },
          {
            type: "1",
            value: 2,
            blocks: [
              { type: "paragraph", text: "two" },
              { type: "list", items: [{ blocks: [{ type: "paragraph", text: "child" }] }] },
            ],
          },
          { type: "1", value: 3, blocks: [{ type: "paragraph", text: "three" }] },
        ],
      },
    ]);
  });

  it("preserves ordered sub-list hierarchy inside its owning item", () => {
    const markdown = ["1. one", "   1. sub a", "   2. sub b", "2. two"].join("\n");

    expect(renderTelegramBlocks(markdown).map((rendered) => rendered.block)).toEqual([
      {
        type: "list",
        items: [
          {
            type: "1",
            value: 1,
            blocks: [
              { type: "paragraph", text: "one" },
              {
                type: "list",
                items: [
                  { type: "1", value: 1, blocks: [{ type: "paragraph", text: "sub a" }] },
                  { type: "1", value: 2, blocks: [{ type: "paragraph", text: "sub b" }] },
                ],
              },
            ],
          },
          { type: "1", value: 2, blocks: [{ type: "paragraph", text: "two" }] },
        ],
      },
    ]);
  });

  it("preserves three-level native lists without losing ordered numbering", () => {
    const markdown = ["1. one", "   1. sub a", "      - deep bullet", "   2. sub b", "2. two"].join(
      "\n",
    );

    expect(renderTelegramBlocks(markdown).map((rendered) => rendered.block)).toEqual([
      {
        type: "list",
        items: [
          {
            type: "1",
            value: 1,
            blocks: [
              { type: "paragraph", text: "one" },
              {
                type: "list",
                items: [
                  {
                    type: "1",
                    value: 1,
                    blocks: [
                      { type: "paragraph", text: "sub a" },
                      {
                        type: "list",
                        items: [{ blocks: [{ type: "paragraph", text: "deep bullet" }] }],
                      },
                    ],
                  },
                  { type: "1", value: 2, blocks: [{ type: "paragraph", text: "sub b" }] },
                ],
              },
            ],
          },
          { type: "1", value: 2, blocks: [{ type: "paragraph", text: "two" }] },
        ],
      },
    ]);
  });

  it("keeps owned code and native sub-list in the same ordered item", () => {
    const markdown = [
      "1. one",
      "   1. sub a",
      "",
      "   ```ts",
      "   const a = 1;",
      "   ```",
      "",
      "2. two",
    ].join("\n");

    expect(renderTelegramBlocks(markdown).map((rendered) => rendered.block)).toEqual([
      {
        type: "list",
        items: [
          {
            type: "1",
            value: 1,
            blocks: [
              { type: "paragraph", text: "one" },
              {
                type: "list",
                items: [{ type: "1", value: 1, blocks: [{ type: "paragraph", text: "sub a" }] }],
              },
              { type: "pre", text: "const a = 1;", language: "ts" },
            ],
          },
          { type: "1", value: 2, blocks: [{ type: "paragraph", text: "two" }] },
        ],
      },
    ]);
  });

  it("keeps a sub-list inside its item when the list stays native", () => {
    const markdown = ["- one", "- two", "  - child"].join("\n");

    expect(renderTelegramBlocks(markdown).map((rendered) => rendered.block)).toEqual([
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "one" }] },
          {
            blocks: [
              { type: "paragraph", text: "two" },
              { type: "list", items: [{ blocks: [{ type: "paragraph", text: "child" }] }] },
            ],
          },
        ],
      },
    ]);
  });

  it("renders a whole reply as a single part", () => {
    const markdown = [
      "# Title",
      "",
      "Paragraph with **bold**",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "> quoted",
      "",
      "- item",
    ].join("\n");

    const parts = renderTelegramParts(markdown);

    expect(parts).toHaveLength(1);
    expect(defined(parts[0]).source).toBe("blocks");
    expect(defined(parts[0]).blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "table",
      "blockquote",
      "list",
    ]);
    expect(defined(parts[0]).fallbackText).toContain("Paragraph with bold");
  });

  it("splits long replies into independently safe normal-message fallbacks", () => {
    const markdown = Array.from(
      { length: 60 },
      (_, index) => `Paragraph ${index} ${"x".repeat(100)}`,
    ).join("\n\n");

    const parts = renderTelegramParts(markdown);

    expect(markdown.length).toBeGreaterThan(4096);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.fallbackText.length <= 3800)).toBe(true);
    expect(parts.map((part) => part.fallbackText).join("\n\n")).toBe(markdown);
  });

  it("splits an oversized reply so that every part fits both budgets", () => {
    const markdown = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}`).join("\n\n");

    const parts = renderTelegramParts(markdown, { maxChars: 60, maxBlocks: 5 });

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const chars = part.blocks.reduce((total, block) => total + countRichChars(block), 0);
      const units = part.blocks.reduce((total, block) => total + countRichBlocks(block), 0);
      expect(chars).toBeLessThanOrEqual(60);
      expect(units).toBeLessThanOrEqual(5);
    }
  });

  it("splits an oversized code fence into several preformatted blocks", () => {
    const parts = renderTelegramParts(
      "```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\n```",
      { maxChars: 20 },
    );

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((part) => part.blocks).every((block) => block.type === "pre")).toBe(true);
  });

  it("splits an oversized table by rows and repeats the header", () => {
    const rows = Array.from({ length: 12 }, (_, index) => `| api${index}.js | +${index} |`);
    const parts = renderTelegramParts(["| Name | Score |", "| --- | --- |", ...rows].join("\n"), {
      maxChars: 100_000,
      maxBlocks: 6,
    });

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      for (const block of part.blocks) {
        expect(block.type).toBe("table");
        if (block.type === "table") {
          expect(defined(block.cells[0]?.[0]).text).toBe("Name");
        }
      }
    }
  });

  it("accepts pre-parsed blocks for the streaming path", () => {
    expect(toRenderedBlocks([{ type: "plain", text: "## literal" }])).toEqual([
      { block: { type: "paragraph", text: "## literal" }, plainText: "## literal" },
    ]);
  });
});
