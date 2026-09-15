/** Image topics have no OpenCode session or workspace. Credentials are resolved by ID at execution. */
export interface ImageChatProfile {
  mode: "gemini" | "tools";
  connectionID: string;
  modelID: string;
  imageProviderID?: string;
  imageEndpoint?: string;
  endpoint: string;
  imageModelID?: string;
  imageEditModelID?: string;
}

export interface ImageReference {
  fileID: string;
  mimeType: string;
  messageID?: number;
}

export interface ImageChatPart {
  text?: string;
  image?: ImageReference;
  thoughtSignature?: string;
  thought?: boolean;
}
export interface ImageChatTurn {
  role: "user" | "model";
  parts: ImageChatPart[];
}
export interface ImageChatSettings {
  silentDelivery?: boolean;
  messageFormat?: "raw" | "markdown";
}

export interface ImageChatLastRequest {
  text: string;
  images: ImageReference[];
  replyImage?: ImageReference;
}

export interface ImageChatState {
  kind: "image";
  chatID: number;
  threadID: number;
  title: string;
  profile: ImageChatProfile;
  revision: number;
  turns: ImageChatTurn[];
  currentImage?: ImageReference;
  updatedAt: number;
  settings?: ImageChatSettings;
  lastRequest?: ImageChatLastRequest;
  /** Bounded durable deduplication: a timed out operation is never replayed after restart. */
  handledMessageIDs: number[];
}

export interface MediaImage { buffer: Buffer; mimeType: string }
export interface ImageChatResultPart {
  text?: string;
  image?: MediaImage;
  thoughtSignature?: string;
  thought?: boolean;
}
