import type { FavoriteModel, ModelInfo, ProviderInfo } from "../app/types/model.js";
import type { ModelCenterDataSource } from "../bot/menus/model-center-menu.js";
import type { FleetTopic } from "./control-store.js";
import type { LegacyUiAdapter } from "./legacy-ui-adapter.js";

export type LegacyModelScope = { kind: "global" } | { kind: "topic"; topic: FleetTopic };

interface CatalogCache {
  at: number;
  providers: unknown[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const key = (model: Pick<ModelInfo, "providerID" | "modelID">) =>
  `${model.providerID}/${model.modelID}`;

export class LegacyModelAdapter {
  constructor(private readonly ui: LegacyUiAdapter) {}

  async current(topic?: FleetTopic): Promise<ModelInfo | undefined> {
    const selected = topic
      ? this.ui.getTopicSelection(topic).model
      : String(record(record(this.ui.getGlobalSnapshot()?.data.configuration).runtime).model ?? "");
    if (!selected) return undefined;
    const slash = selected.indexOf("/");
    if (slash < 1) return undefined;
    return { providerID: selected.slice(0, slash), modelID: selected.slice(slash + 1) };
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
      const topic = scope.kind === "topic" ? scope.topic : this.ui.catalogTopic();
      if (topic) await this.refresh(topic);
    }
    return (await this.models(scope, model.providerID)).some(
      (item) => item.modelID === model.modelID,
    );
  }

  private async catalog(scope: LegacyModelScope): Promise<unknown[]> {
    if (scope.kind === "topic") this.ui.assertWritableTopic(scope.topic);
    const cached = this.ui.getUiState<CatalogCache>("legacy:model:catalog");
    if (cached?.providers.length && cached.at > Date.now() - 60_000) return cached.providers;
    const topic = scope.kind === "topic" ? scope.topic : this.ui.catalogTopic();
    if (!topic) return cached?.providers ?? [];
    return (await this.refresh(topic)).providers;
  }

  private async refresh(topic: FleetTopic): Promise<CatalogCache> {
    const result = await this.ui.rpc<unknown>(topic, "models.list");
    if (!Array.isArray(record(result).providers)) throw new Error("worker_model_catalog_invalid");
    const providers = record(result).providers as unknown[];
    const cache = { at: Date.now(), providers };
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
