// Implemented foundation declarations only; not the complete proposed C1 SDK.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ContractError {
  code: string;
  retryable: boolean;
  field?: string;
  details?: JsonObject;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };

export interface FoundationConfiguration {
  schemaVersion: 1;
  enabled: false;
  mode: "observe";
  permissions: { modelProfiles: readonly string[]; actions: readonly string[] };
  observability: {
    detail: "standard";
    capture: {
      documents: "none";
      prompts: "none";
      toolDescriptions: "none";
      toolArguments: "none";
      toolResults: "none";
      modelResponses: "none";
      images: "none";
      reasoning: "none";
    };
  };
}
