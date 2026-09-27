export const EXTENSION_KINDS = ["integration", "mcp", "skill", "model-provider", "plugin"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const EXTENSION_AUTH_TYPES = ["none", "oauth", "api-key", "bearer"] as const;
export type ExtensionAuthType = (typeof EXTENSION_AUTH_TYPES)[number];

export interface ExtensionCredentialSchema {
  id: string;
  label: string;
  type: "api-key" | "bearer";
  transport: {
    kind: "authorization-bearer" | "api-key-header" | "provider-api-key";
  };
}

export interface ExtensionRecord {
  id: string;
  name: string;
  kind: ExtensionKind;
  source: string;
  purpose?: string;
  authType: ExtensionAuthType;
  credentialSchemas: ExtensionCredentialSchema[];
  resource:
    | { kind: "mcp"; serverName: string; projectDirectory: string }
    | { kind: "skill"; skillName: string }
    | { kind: "model-provider"; providerId: string }
    | { kind: "plugin"; specifier: string }
    | { kind: "integration"; adapter: string };
  createdAt: string;
  updatedAt: string;
  managed: boolean;
}

export interface ExtensionEnsureRequest {
  id: string;
  sessionId: string;
  projectDirectory: string;
  name: string;
  kind: ExtensionKind;
  source: string;
  purpose: string;
  authType: ExtensionAuthType;
  createdAt: number;
  expiresAt: number;
  status: "awaiting-approval" | "approved" | "cancelled" | "installing" | "awaiting-credential" | "ready" | "failed";
  error?: string;
}

export interface ExtensionSummary {
  id: string;
  name: string;
  kind: ExtensionKind;
  source: string;
  authType: ExtensionAuthType;
  status: "ready" | "needs-auth" | "unknown";
  managed: boolean;
}
