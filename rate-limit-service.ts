export type PublicRateLimitWindow = {
  limitId: string;
  limitName: string;
  windowKind: "primary" | "secondary";
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
  planType?: string;
};

export type PublicRateLimits = {
  refreshedAt: string;
  limits: PublicRateLimitWindow[];
};

const MAX_LIMITS = 64;

function cleanString(value: unknown, maxLength = 160) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function cleanNumber(value: unknown, { min, max }: { min: number; max: number }) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function cleanWindow(
  snapshot: any,
  fallbackId: string,
  windowKind: PublicRateLimitWindow["windowKind"],
): PublicRateLimitWindow | null {
  const window = snapshot?.[windowKind];
  const usedPercent = cleanNumber(window?.usedPercent, { min: 0, max: 100 });
  if (usedPercent === null) return null;
  const limitId = cleanString(snapshot?.limitId, 128) || fallbackId;
  const limitName = cleanString(snapshot?.limitName, 160) || limitId;
  const duration = window?.windowDurationMins == null
    ? null
    : cleanNumber(window.windowDurationMins, { min: 0, max: 10 * 365 * 24 * 60 });
  const reset = window?.resetsAt == null
    ? null
    : cleanNumber(window.resetsAt, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const planType = cleanString(snapshot?.planType, 64);
  return {
    limitId,
    limitName,
    windowKind,
    usedPercent,
    windowDurationMins: duration === null ? null : Math.round(duration),
    resetsAt: reset === null ? null : Math.round(reset),
    ...(planType ? { planType } : {}),
  };
}

export function normalizeRateLimits(raw: any, now = Date.now()): PublicRateLimits {
  const byId = raw?.rateLimitsByLimitId;
  const entries: Array<[string, any]> = byId && typeof byId === "object" && !Array.isArray(byId) && Object.keys(byId).length
    ? Object.entries(byId).slice(0, MAX_LIMITS)
    : [["default", raw?.rateLimits]];
  const limits: PublicRateLimitWindow[] = [];
  const seen = new Set<string>();

  for (const [rawId, snapshot] of entries) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const fallbackId = cleanString(rawId, 128) || "default";
    for (const kind of ["primary", "secondary"] as const) {
      const limit = cleanWindow(snapshot, fallbackId, kind);
      if (!limit) continue;
      const key = [limit.limitId, limit.windowKind, limit.windowDurationMins, limit.resetsAt].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      limits.push(limit);
      if (limits.length >= MAX_LIMITS) break;
    }
    if (limits.length >= MAX_LIMITS) break;
  }

  return { refreshedAt: new Date(now).toISOString(), limits };
}

export function createRateLimitLoader(
  load: () => Promise<unknown>,
  { ttlMs = 45_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
) {
  let generation = 0;
  let cache: { expiresAt: number; value: PublicRateLimits } | null = null;
  let inFlight: { generation: number; promise: Promise<PublicRateLimits> } | null = null;

  const invalidate = () => {
    generation += 1;
    cache = null;
    inFlight = null;
  };

  const get = () => {
    const current = now();
    if (cache && cache.expiresAt > current) return Promise.resolve(cache.value);
    const currentGeneration = generation;
    if (inFlight?.generation === currentGeneration) return inFlight.promise;
    const promise = load()
      .then(raw => normalizeRateLimits(raw, now()))
      .then(value => {
        if (generation === currentGeneration) cache = { expiresAt: now() + ttlMs, value };
        return value;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { generation: currentGeneration, promise };
    return promise;
  };

  return { get, invalidate };
}
