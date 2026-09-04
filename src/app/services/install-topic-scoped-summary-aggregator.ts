import { summaryAggregator } from "../managers/summary-aggregation-manager.js";
import { installTopicScopedSingleton } from "./topic-scoped-singleton.js";

// SummaryAggregator holds mutable per-session streaming state. Scope its
// singleton by Telegram topic so concurrent Topics cannot overwrite each
// other's in-flight summary state.
installTopicScopedSingleton(summaryAggregator);
