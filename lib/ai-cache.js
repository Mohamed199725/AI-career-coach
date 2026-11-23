import { createHash } from "crypto";
import { db } from "./prisma";

// Every Gemini round trip costs ~15s of fixed server-side overhead on this key
// (a 3-character answer takes just as long as a full paragraph). Repeated
// requests are common here -- users re-run "improve with AI" on the same bullet,
// or re-open a cover letter for the same job -- so a hit on this cache is the
// only way to make those near-instant.
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function cacheKey(model, prompt) {
  return createHash("sha256").update(`${model}\n${prompt}`).digest("hex");
}

// In-flight requests are shared, so two clicks that arrive together trigger one
// model call instead of two (each of which would cost the full ~15s).
const inFlight = new Map();

/**
 * Runs `generate` (which must return a string) unless the same model+prompt was
 * generated within the TTL, in which case the stored text is returned.
 * Cache failures are swallowed: a broken cache must never break the feature.
 */
export async function withCache(model, prompt, generate) {
  const key = cacheKey(model, prompt);

  try {
    const hit = await db.aiCache.findUnique({ where: { key } });
    if (hit && Date.now() - hit.createdAt.getTime() < CACHE_TTL_MS) {
      return hit.content;
    }
  } catch (error) {
    console.error("AI cache read failed:", error?.message);
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    const content = await generate();
    try {
      await db.aiCache.upsert({
        where: { key },
        update: { content, createdAt: new Date() },
        create: { key, content },
      });
    } catch (error) {
      console.error("AI cache write failed:", error?.message);
    }
    return content;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
