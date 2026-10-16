import { describe, expect, it } from "vitest";
import { parseInlineThinking } from "../../../src/app/managers/inline-thinking-parser.js";

describe("app/managers/inline-thinking-parser", () => {
  it("separates a standard think block from the final answer", () => {
    expect(parseInlineThinking("<think>Check the files.</think>Done.")).toEqual({
      answerText: "Done.",
      thinkingText: "Check the files.",
      isThinking: false,
      hasThinkMarker: true,
    });
  });

  it("handles streams that use closing markers as both boundaries", () => {
    expect(parseInlineThinking("</think>Check the files.</think>Done.")).toEqual({
      answerText: "Done.",
      thinkingText: "Check the files.",
      isThinking: false,
      hasThinkMarker: true,
    });
  });

  it("keeps an unfinished reasoning block live and withholds partial tags", () => {
    expect(parseInlineThinking("<think>Still checking. </thi")).toEqual({
      answerText: "",
      thinkingText: "Still checking. ",
      isThinking: true,
      hasThinkMarker: true,
    });
  });

  it("finishes an unterminated inline block with the entire text in reasoning", () => {
    expect(parseInlineThinking("</think>Still checking.", { final: true })).toEqual({
      answerText: "",
      thinkingText: "Still checking.",
      isThinking: false,
      hasThinkMarker: true,
    });
  });

  it("passes through ordinary assistant text unchanged", () => {
    expect(parseInlineThinking("Here is the answer.")).toEqual({
      answerText: "Here is the answer.",
      thinkingText: "",
      isThinking: false,
      hasThinkMarker: false,
    });
  });
});
