type ToolDefinition = { description?: string; args?: unknown; execute: (...args: any[]) => unknown };

const schemaNode = {
  optional() { return this; },
  describe(_text: string) { return this; },
};

export const tool = Object.assign(
  <T extends ToolDefinition>(definition: T): T => definition,
  {
    schema: {
      string: () => Object.create(schemaNode),
      number: () => Object.create(schemaNode),
    },
  },
);
