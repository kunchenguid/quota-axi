export const AGY_MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/i;

export function agyBoundWindowId(
  groupId: string,
  period: "5h" | "weekly",
): string {
  return `${groupId}_${period}`;
}

export function agyUnrecognizedWindowId(
  groupId: string,
  bucketId: string,
): string {
  return `${groupId}:bucket:${encodeURIComponent(Buffer.from(bucketId).toString())}`;
}
