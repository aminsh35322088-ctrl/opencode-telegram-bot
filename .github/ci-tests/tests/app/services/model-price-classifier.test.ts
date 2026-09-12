import { describe, expect, it } from "vitest";
import { classifyModelPrice, PRICE_LEGEND } from "../../../src/app/services/model-price-classifier.js";
describe("advertised text price evidence", () => {
  it.each([
  [
    {
      "pricing": {
        "prompt": "0",
        "completion": "0"
      }
    },
    "free"
  ],
  [
    {
      "pricing": {
        "request": 0,
        "image": 0
      }
    },
    "unknown"
  ],
  [
    {
      "pricing": {
        "prompt": 0,
        "input": 1,
        "completion": 0
      }
    },
    "conflict"
  ],
  [
    {
      "free": true,
      "is_free": false
    },
    "conflict"
  ],
  [
    {
      "free": true,
      "metadata": {
        "free": false
      }
    },
    "conflict"
  ],
  [
    {
      "free": "true",
      "pricing": {
        "prompt": 1
      }
    },
    "conflict"
  ],
  [
    {
      "is_free": false,
      "pricing": {
        "input": 0,
        "output": 0
      }
    },
    "conflict"
  ],
  [
    {
      "pricing": {
        "input": 0,
        "output": 0,
        "request": 1
      }
    },
    "paid"
  ],
  [
    {
      "pricing": {
        "input": 0,
        "output": 0,
        "internal_reasoning": 1
      }
    },
    "paid"
  ],
  [
    {
      "pricing": {
        "input": 0,
        "output": 0,
        "image": 1
      }
    },
    "free"
  ],
  [
    {
      "pricing": {
        "input": 0,
        "output": 0,
        "unknown_charge": 1
      }
    },
    "unknown"
  ],
  [
    {
      "pricing": {
        "input": 0,
        "output": "oops"
      }
    },
    "unknown"
  ],
  [
    {
      "pricing": {
        "input": 0,
        "output": -1
      }
    },
    "unknown"
  ],
  [
    {
      "pricing": {
        "input": 0,
        "output": "",
        "completion": 0
      }
    },
    "unknown"
  ],
  [
    {
      "pricing": [
        {
          "input": 0
        },
        {
          "output": 0
        }
      ]
    },
    "unknown"
  ],
  [
    {
      "pricing": [
        {
          "input": 0,
          "output": 0
        },
        {
          "input": 0,
          "output": 0
        }
      ]
    },
    "free"
  ],
  [
    {
      "pricing": [
        {
          "input": 0,
          "output": 0
        },
        {
          "input": 1,
          "output": 2
        }
      ]
    },
    "conditional"
  ],
  [
    {
      "pricing": []
    },
    "unknown"
  ],
  [
    {
      "free": true,
      "pricing": {
        "input": "bad",
        "output": 0
      }
    },
    "hint"
  ],
  [
    {
      "id": "generic:free"
    },
    "hint"
  ],
  [
    {
      "name": "Free model"
    },
    "hint"
  ],
  [
    {
      "id": "ordinary"
    },
    "unknown"
  ],
  [
    {
      "metadata": {
        "is_free": "TRUE"
      }
    },
    "free"
  ]
])("classifies %j as %s", (record, group) => {
    expect(classifyModelPrice(record).group).toBe(group);
  });
  it("trusts the suffix only with the provider contract and checks contradictions", () => {
    expect(classifyModelPrice({ id: "model:free" }, { officialFreeSuffix: true }).group).toBe("free");
    expect(classifyModelPrice({ id: "model:free", is_free: false }, { officialFreeSuffix: true }).group).toBe("conflict");
    expect(classifyModelPrice({ id: "model:free", pricing: { input: 1 } }, { officialFreeSuffix: true }).group).toBe("conflict");
  });
  it("fits the Telegram alert limit", () => { expect(PRICE_LEGEND.length).toBeLessThanOrEqual(200); });
});
