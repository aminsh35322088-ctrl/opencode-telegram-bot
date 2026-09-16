import { describe, expect, it } from "vitest";
import { parseTelegramBlocks } from "../../../src/bot/render/block-parser.js";
import { toRichBlock } from "../../../src/bot/render/rich-blocks.js";

describe("bot/render HTML tag support", () => {
  it("parses HTML anchors as Telegram rich links", () => {
    const [block] = parseTelegramBlocks('Read <a href="https://example.com/docs">the docs</a>.');

    expect(block).toEqual({
      type: "paragraph",
      inlines: [
        { type: "text", text: "Read " },
        {
          type: "link",
          text: [{ type: "text", text: "the docs" }],
          url: "https://example.com/docs",
        },
        { type: "text", text: "." },
      ],
    });
    expect(block && toRichBlock(block)).toEqual({
      type: "paragraph",
      text: [
        "Read ",
        { type: "url", text: "the docs", url: "https://example.com/docs" },
        ".",
      ],
    });
  });

  it("decodes HTML entities in anchor attributes", () => {
    expect(parseTelegramBlocks('Read <a href="https://example.com/?a=1&amp;b=2">the docs</a>.')).toEqual([
      {
        type: "paragraph",
        inlines: [
          { type: "text", text: "Read " },
          {
            type: "link",
            text: [{ type: "text", text: "the docs" }],
            url: "https://example.com/?a=1&b=2",
          },
          { type: "text", text: "." },
        ],
      },
    ]);
  });

  it("keeps anchors without href visible instead of dropping markup", () => {
    expect(parseTelegramBlocks("A <a>label</a> here")).toEqual([
      {
        type: "paragraph",
        inlines: [{ type: "text", text: "A <a>label</a> here" }],
      },
    ]);
  });

  it("parses a plain HTML pre block as code", () => {
    expect(parseTelegramBlocks("<pre>const answer = 42;</pre>")).toEqual([
      { type: "code", text: "const answer = 42;" },
    ]);
  });

  it("decodes named and numeric entities inside HTML pre blocks", () => {
    expect(
      parseTelegramBlocks(
        '<pre><code class="language-typescript">if (a &lt; b &amp;&amp; c &#x3E; 0) return &quot;ok&quot;;</code></pre>',
      ),
    ).toEqual([
      { type: "code", language: "typescript", text: 'if (a < b && c > 0) return "ok";' },
    ]);
  });

  it("parses pre/code blocks before generic pre blocks and preserves language", () => {
    expect(
      parseTelegramBlocks(
        '<pre class="outer"><code class="highlight language-typescript extra">const answer = 42;</code></pre>',
      ),
    ).toEqual([
      { type: "code", language: "typescript", text: "const answer = 42;" },
    ]);
  });

  it("does not turn unrelated HTML blocks into code", () => {
    expect(parseTelegramBlocks("<div>hello</div>")).toEqual([
      { type: "plain", text: "<div>hello</div>" },
    ]);
  });
});
