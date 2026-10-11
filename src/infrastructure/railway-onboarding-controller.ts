import type { StoredRailwayInfrastructureCredential } from "./railway-credential-store.js";
import type { RailwayCredentialValidation } from "./railway-credential-validation.js";

interface CredentialClient {
  readonly configured: boolean;
  configureCredential(value: string): void;
}
interface CredentialStore {
  load(): Promise<StoredRailwayInfrastructureCredential | undefined>;
  save(value: StoredRailwayInfrastructureCredential): Promise<void>;
}
interface Options {
  controlProjectId: string;
  client: CredentialClient;
  store: CredentialStore;
  validate(input: { token: string; controlProjectId: string }): Promise<RailwayCredentialValidation>;
  activateWorkspace(workspaceId: string): Promise<void>;
  now?: () => number;
}
export type RailwayOnboardingStatus =
  | { configured: false }
  | { configured: true; tokenType: "account" | "workspace"; workspaceId: string; workspaceName?: string };

const PENDING_TTL_MS = 5 * 60_000;

export class RailwayOnboardingController {
  private current?: StoredRailwayInfrastructureCredential;
  private pending?: { token: string; validation: Extract<RailwayCredentialValidation, {valid:true}>; expiresAt: number };
  private readonly now: () => number;
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }

  async initialize(): Promise<void> {
    const stored = await this.options.store.load();
    if (!stored) return;
    this.options.client.configureCredential(stored.token);
    await this.options.activateWorkspace(stored.workspaceId);
    this.current = stored;
  }

  async status(): Promise<RailwayOnboardingStatus> {
    if (!this.current) return { configured: false };
    return {
      configured: true,
      tokenType: this.current.tokenType,
      workspaceId: this.current.workspaceId,
      ...(this.current.workspaceName ? { workspaceName: this.current.workspaceName } : {}),
    };
  }

  async begin(token: string): Promise<RailwayCredentialValidation> {
    this.pending = undefined;
    const validation = await this.options.validate({ token, controlProjectId: this.options.controlProjectId });
    if (!validation.valid) return validation;
    this.pending = { token, validation, expiresAt: this.now() + PENDING_TTL_MS };
    return validation;
  }

  async selectWorkspace(workspaceId: string): Promise<RailwayOnboardingStatus> {
    const pending = this.pending;
    if (!pending || pending.expiresAt < this.now()) { this.pending = undefined; throw new Error("Railway setup expired"); }
    const workspace = pending.validation.workspaces.find(item => item.id === workspaceId);
    if (!workspace) throw new Error("Railway workspace selection denied");
    const stored: StoredRailwayInfrastructureCredential = {
      token: pending.token,
      tokenType: pending.validation.tokenType,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    };
    this.options.client.configureCredential(stored.token);
    await this.options.activateWorkspace(stored.workspaceId);
    await this.options.store.save(stored);
    this.current = stored;
    this.pending = undefined;
    return this.status();
  }
}
