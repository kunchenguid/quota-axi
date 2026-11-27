export type SubscriptionWindowIdentity = {
  id: string;
  kind?: string;
};

export type SubscriptionIdentity = {
  accountId?: string;
  plan?: string;
  email?: string;
  userId?: string;
  windows: readonly SubscriptionWindowIdentity[];
};

/** Missing identity evidence never conflicts; two known values must agree. */
export function sameSubscription(
  left: SubscriptionIdentity,
  right: SubscriptionIdentity,
): boolean {
  if (!left.accountId || !right.accountId || left.accountId !== right.accountId)
    return false;
  for (const key of ["plan", "email", "userId"] as const) {
    if (left[key] && right[key] && left[key] !== right[key]) return false;
  }
  if (left.windows.length === 0 || right.windows.length === 0) return true;
  const leftWindows = new Set(
    left.windows.map(({ id, kind }) => `${id}\u0000${kind ?? ""}`),
  );
  const rightWindows = new Set(
    right.windows.map(({ id, kind }) => `${id}\u0000${kind ?? ""}`),
  );
  return (
    leftWindows.size === rightWindows.size &&
    [...leftWindows].every((window) => rightWindows.has(window))
  );
}
