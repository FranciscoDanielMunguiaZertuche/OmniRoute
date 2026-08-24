import {
  finalizePendingRequest,
  finalizePendingRequestById,
  updatePendingRequest,
  updatePendingRequestById,
  type PendingRequestMetadata,
} from "./usageHistory";

export type PendingRequestScope = {
  id: string | null | undefined;
  model: string;
  provider: string;
  connectionId: string | null;
  videoTranscriptSensitive?: boolean;
  videoTranscriptDescriptionFingerprints?: readonly string[];
};

export function updatePendingScope(scope: PendingRequestScope, metadata: PendingRequestMetadata) {
  const protectedMetadata = {
    ...metadata,
    ...(scope.videoTranscriptSensitive ? { videoTranscriptSensitive: true } : {}),
    ...(scope.videoTranscriptDescriptionFingerprints?.length
      ? { videoTranscriptDescriptionFingerprints: scope.videoTranscriptDescriptionFingerprints }
      : {}),
  };
  if (!updatePendingRequestById(scope.id || null, protectedMetadata)) {
    updatePendingRequest(scope.model, scope.provider, scope.connectionId, protectedMetadata);
  }
}

export function finalizePendingScope(scope: PendingRequestScope, metadata: PendingRequestMetadata) {
  const protectedMetadata = {
    ...metadata,
    ...(scope.videoTranscriptSensitive ? { videoTranscriptSensitive: true } : {}),
    ...(scope.videoTranscriptDescriptionFingerprints?.length
      ? { videoTranscriptDescriptionFingerprints: scope.videoTranscriptDescriptionFingerprints }
      : {}),
  };
  if (!finalizePendingRequestById(scope.id, protectedMetadata)) {
    finalizePendingRequest(scope.model, scope.provider, scope.connectionId, protectedMetadata);
  }
}
