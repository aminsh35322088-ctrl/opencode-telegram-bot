import type { FavoriteModel, ModelInfo, ProviderInfo } from "../app/types/model.js";
import type {
  CapabilityRoute,
  ModelRoutingCapability,
  UnifiedModelCatalogEntry,
} from "../app/types/model-capability.js";
import { detectModelCapabilities } from "../app/services/model-capability-detection-service.js";
import { detectModelExecutionCapabilities } from "../app/services/model-execution-capability-service.js";
import { formatModelRoutingSummary } from "../app/services/model-routing-summary-formatter.js";
import type { ModelCenterDataSource } from "../bot/menus/model-center-menu.js";
import type { FleetTopic } from "./control-store.js";
import type { LegacyUiAdapter } from "./legacy-ui-adapter.js";

export type LegacyModelScope = { kind: "global" } | { kind: "topic"; topic: FleetTopic };

interface CatalogCache {
  at: number;
  providers: unknown[];
  verified?: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const key = (model: Pick<ModelInfo, "providerID" | "modelID">) =>
  `${model.providerID}/${model.modelID}`;

export class LegacyModelAdapter {
  private generalRefresh?: Promise<CatalogCache>;
  constructor(private readonly ui: LegacyUiAdapter) {}

  async current(topic?: FleetTopic): Promise<ModelInfo | undefined> {
    const selected = topic
      ? this.ui.getTopicSelection(topic).model
      : String(record(record(this.ui.getGlobalSnapshot()?.data.configuration).runtime).model ?? "");
    if (!selected) return undefined;
    const slash = selected.indexOf("/");
    if (slash < 1) return undefined;
    const providerID = selected.slice(0, slash),
      modelID = selected.slice(slash + 1);
    const scope: LegacyModelScope = topic ? { kind: "topic", topic } : { kind: "global" };
    const advertised = (await this.models(scope, providerID)).find(
      (model) => model.modelID === modelID,
    );
    return { providerID, modelID, ...(advertised?.name ? { name: advertised.name } : {}) };
  }

  async routingSummary(scope: LegacyModelScope, primary: ModelInfo): Promise<string> {
    const providers = await this.catalog(scope);
    const catalog: UnifiedModelCatalogEntry[] = [];
    for (const providerValue of providers) {
      const provider = record(providerValue);
      const providerID = String(provider.id ?? "");
      if (!providerID) continue;
      for (const [modelID, modelValue] of Object.entries(record(provider.models))) {
        const metadata = record(modelValue);
        const detected = detectModelCapabilities(metadata, { source: "model-catalog" });
        const execution = detectModelExecutionCapabilities(metadata);
        catalog.push({
          providerID,
          providerName: String(provider.name ?? providerID),
          modelID,
          modelName: String(metadata.name ?? modelID),
          capabilities: detected.capabilities,
          execution: execution.execution,
          capabilityDetection: detected.detection,
          availability: "available",
          origin: "opencode-runtime",
        });
      }
    }
    const entry = catalog.find(
      (model) => model.providerID === primary.providerID && model.modelID === primary.modelID,
    );
    const supports = (capability: ModelRoutingCapability): boolean => {
      if (!entry) return false;
      if (capability === "vision")
        return (
          entry.capabilities.modalities.input.image === true &&
          entry.capabilities.modalities.output.text === true
        );
      if (capability === "imageGenerate")
        return entry.capabilities.operations.imageGenerate === true;
      if (capability === "textToSpeech") return entry.capabilities.operations.textToSpeech === true;
      return (
        entry.capabilities.modalities.input.audio === true &&
        entry.execution?.nativeAudioFileInput === true
      );
    };
    const capabilities: readonly ModelRoutingCapability[] = [
      "vision",
      "voiceInput",
      "imageGenerate",
      "textToSpeech",
    ];
    const routes = new Map<ModelRoutingCapability, CapabilityRoute>(
      capabilities.map((capability) => {
        const native = supports(capability);
        return [
          capability,
          {
            capability,
            ...(native
              ? { model: { providerID: primary.providerID, modelID: primary.modelID } }
              : {}),
            routeSource: native ? "primary-native" : "unavailable",
            primarySupportsCapability: native,
          },
        ];
      }),
    );
    return formatModelRoutingSummary(primary, catalog, routes);
  }

  source(scope: LegacyModelScope): ModelCenterDataSource {
    return {
      favorites: () => this.favorites(scope),
      recent: () => this.recent(scope),
      providers: () => this.providers(scope),
      models: (providerID) => this.models(scope, providerID),
    };
  }

  async providers(scope: LegacyModelScope): Promise<ProviderInfo[]> {
    const providers = await this.catalog(scope);
    return providers
      .map((item) => {
        const provider = record(item);
        const models = record(provider.models);
        return {
          id: String(provider.id ?? ""),
          name: String(provider.name ?? provider.id ?? "Unknown"),
          modelCount: Object.keys(models).length,
        };
      })
      .filter((provider) => provider.id);
  }

  async models(scope: LegacyModelScope, providerID: string): Promise<FavoriteModel[]> {
    const providers = await this.catalog(scope);
    const provider = providers.map(record).find((item) => String(item.id ?? "") === providerID);
    if (!provider) return [];
    return Object.entries(record(provider.models)).map(([modelID, value]) => ({
      providerID,
      modelID,
      name: typeof record(value).name === "string" ? String(record(value).name) : undefined,
    }));
  }

  async favorites(scope: LegacyModelScope): Promise<FavoriteModel[]> {
    return this.readList(this.scopeKey(scope, "favorites"));
  }

  async recent(scope: LegacyModelScope): Promise<FavoriteModel[]> {
    return this.readList(this.scopeKey(scope, "recent"));
  }

  async setFavorite(scope: LegacyModelScope, model: ModelInfo, enabled: boolean): Promise<void> {
    const available = await this.contains(scope, model);
    if (!available) throw new Error("model_unavailable");
    const list = await this.favorites(scope);
    const next = enabled
      ? [model, ...list.filter((item) => key(item) !== key(model))].slice(0, 64)
      : list.filter((item) => key(item) !== key(model));
    this.ui.setUiState(this.scopeKey(scope, "favorites"), next);
  }

  async toggleFavorite(scope: LegacyModelScope, model: ModelInfo): Promise<boolean> {
    const list = await this.favorites(scope);
    const enabled = !list.some((item) => key(item) === key(model));
    await this.setFavorite(scope, model, enabled);
    return enabled;
  }

  async select(scope: LegacyModelScope, model: ModelInfo): Promise<void> {
    if (!(await this.contains(scope, model, true))) throw new Error("model_unavailable");
    if (scope.kind === "topic") {
      const inspection = await this.ui.rpc<{ connected: boolean; available: boolean }>(
        scope.topic,
        "model.inspect",
        { providerID: model.providerID, modelID: model.modelID },
      );
      if (!inspection.connected || !inspection.available) throw new Error("model_unavailable");
      this.ui.setTopicSelection(scope.topic, { model: key(model) });
    } else {
      const snapshot = this.ui.getGlobalSnapshot();
      if (!snapshot) throw new Error("snapshot_unavailable");
      const configuration = record(snapshot.data.configuration);
      await this.ui.commitGlobal(snapshot.revision, {
        ...snapshot.data,
        configuration: {
          ...configuration,
          runtime: { ...record(configuration.runtime), model: key(model) },
        },
      });
    }
    const recent = await this.recent(scope);
    this.ui.setUiState(
      this.scopeKey(scope, "recent"),
      [model, ...recent.filter((item) => key(item) !== key(model))].slice(0, 16),
    );
  }

  private async contains(
    scope: LegacyModelScope,
    model: ModelInfo,
    refresh = false,
  ): Promise<boolean> {
    if (refresh) {
      if (scope.kind === "topic") await this.refresh(scope.topic);
      else await this.refreshGeneral();
    }
    return (await this.models(scope, model.providerID)).some(
      (item) => item.modelID === model.modelID,
    );
  }

  private async catalog(scope: LegacyModelScope): Promise<unknown[]> {
    if (scope.kind === "topic") this.ui.assertWritableTopic(scope.topic);
    const cached = this.ui.getUiState<CatalogCache>("legacy:model:catalog");
    if (cached && (cached.providers.length || cached.verified) && cached.at > Date.now() - 60_000)
      return cached.providers;
    if (scope.kind === "topic") return (await this.refresh(scope.topic)).providers;
    const failedAt = this.ui.getUiState<number>("legacy:model:unavailableAt") ?? 0;
    if (failedAt > Date.now() - 15_000) return cached?.providers ?? [];
    try {
      return (await this.refreshGeneral()).providers;
    } catch {
      this.ui.setUiState("legacy:model:unavailable", true);
      this.ui.setUiState("legacy:model:unavailableAt", Date.now());
      return cached?.providers ?? [];
    }
  }

  catalogUnavailable(): boolean {
    return this.ui.getUiState<boolean>("legacy:model:unavailable") === true;
  }
  private refreshGeneral(): Promise<CatalogCache> {
    if (this.generalRefresh) return this.generalRefresh;
    const pending = (async () => {
      for (const topic of this.ui.catalogTopics().slice(0, 3)) {
        try {
          const catalog = await this.refresh(topic);
          this.ui.setUiState("legacy:model:unavailable", false);
          this.ui.setUiState("legacy:model:unavailableAt", 0);
          return catalog;
        } catch {
          /* Reject stale or unsigned responses; try another current Worker. */
        }
      }
      throw new Error("model_catalog_unavailable");
    })();
    this.generalRefresh = pending;
    void pending
      .finally(() => {
        if (this.generalRefresh === pending) this.generalRefresh = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  private async refresh(topic: FleetTopic): Promise<CatalogCache> {
    const result = await this.ui.rpc<unknown>(topic, "models.list");
    if (!Array.isArray(record(result).providers)) throw new Error("worker_model_catalog_invalid");
    const providers = record(result).providers as unknown[];
    const cache = { at: Date.now(), providers, verified: true };
    this.ui.setUiState("legacy:model:catalog", cache);
    return cache;
  }

  private scopeKey(scope: LegacyModelScope, name: string): string {
    return scope.kind === "global"
      ? `legacy:model:${name}:global`
      : `legacy:model:${name}:${scope.topic.chatId}:${scope.topic.threadId}:${scope.topic.generation}`;
  }

  private readList(stateKey: string): FavoriteModel[] {
    const value = this.ui.getUiState<unknown>(stateKey);
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => record(item))
      .filter((item) => typeof item.providerID === "string" && typeof item.modelID === "string")
      .map((item) => ({
        providerID: String(item.providerID),
        modelID: String(item.modelID),
        name: typeof item.name === "string" ? item.name : undefined,
      }));
  }
}
