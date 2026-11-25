// Prefer the fastest model verified against this project's API key, then keep
// independent fallbacks for provider outages and retired model IDs.
export const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];

// Statuses that mean this model/request can be retried on another model.
const TRANSIENT_STATUSES = new Set([
  "404",
  "408",
  "429",
  "500",
  "502",
  "503",
  "504",
]);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "GEMINI_REQUEST_TIMEOUT",
]);
const TIMEOUT_ERROR_CODE = "GEMINI_REQUEST_TIMEOUT";
const HEDGE_DELAY_MS = 8000;
const MAX_PARALLEL_MODELS = 2;
const MODEL_ATTEMPT_TIMEOUT_MS = 18000;

// This deadline covers every model attempt, not each one individually.
export const GEMINI_BUDGET_MS = 45000;

export function geminiErrorStatus(error) {
  const status =
    error?.status ??
    error?.statusCode ??
    error?.cause?.status ??
    error?.cause?.statusCode;
  if (/^\d{3}$/.test(String(status ?? ""))) return String(status);
  return error?.message?.match(/\[(\d{3})[^\]]*\]/)?.[1];
}

export function describeGeminiError(error) {
  const status = geminiErrorStatus(error);
  const code = error?.code ?? error?.cause?.code;

  if (status === "429") {
    return "The AI provider has reached its request limit. Please try again later.";
  }
  if (status === "401" || status === "403") {
    return "AI generation is temporarily unavailable due to a configuration issue. Please contact support.";
  }
  if (code === TIMEOUT_ERROR_CODE) {
    return "AI generation timed out after trying the available models. Please try again.";
  }
  if (status === "404") {
    return "The configured AI models are unavailable. Please contact support.";
  }
  if (TRANSIENT_STATUSES.has(status) || isTransientGeminiError(error)) {
    return "AI generation is temporarily unavailable after trying the available models. Please try again shortly.";
  }
  return "AI generation failed. Please try again.";
}

function isTransientGeminiError(error) {
  const code = error?.code ?? error?.cause?.code;
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  return /fetch failed|network error|socket hang up|connection reset|timed out/i.test(
    error?.message ?? "",
  );
}

function generateWithTimeout(operation, timeoutMs, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Generation timed out after ${timeoutMs}ms`);
      error.code = TIMEOUT_ERROR_CODE;
      controller.abort();
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(
    () => clearTimeout(timer),
  );
}

/**
 * Starts a backup model if the first has not answered after a short delay. Returns
 * the first success, aborts other requests, and shares one deadline across attempts.
 */
export async function withGeminiModels(
  {
    generationConfig,
    models = GEMINI_MODELS,
    prompt,
    timeoutMs = GEMINI_BUDGET_MS,
  },
  call,
) {
  const deadline = Date.now() + timeoutMs;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY is not configured");
    error.status = "401";
    throw error;
  }

  let lastError;
  let nextModelIndex = 0;
  const active = new Map();
  const controllers = new Set();

  const startModel = (name) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;

    const controller = new AbortController();
    controllers.add(controller);
    const model = {
      generateContent: async (contentPrompt) => {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: contentPrompt }] }],
              generationConfig,
            }),
            signal: controller.signal,
          },
        );
        const responseBody = await response.text();
        let data;

        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch (cause) {
          const error = new Error("Gemini returned an invalid response body", {
            cause,
          });
          error.status = response.status;
          throw error;
        }

        if (!response.ok) {
          const error = new Error(
            data?.error?.message ?? `Gemini request failed (${response.status})`,
          );
          error.status = response.status;
          throw error;
        }

        const text = data?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("");
        if (!text?.trim()) {
          throw new Error(
            `Gemini returned no text (${data?.candidates?.[0]?.finishReason ?? "unknown reason"})`,
          );
        }

        return { response: { text: () => text } };
      },
    };
    const run = call ?? ((m) => m.generateContent(prompt));
    const startedAt = Date.now();
    let request;

    try {
      request = generateWithTimeout(
        () => run(model, remaining),
        Math.min(remaining, MODEL_ATTEMPT_TIMEOUT_MS),
        controller,
      );
    } catch (error) {
      request = Promise.reject(error);
    }

    let tracked;
    tracked = request.then(
      (result) => ({
        name,
        result,
        elapsed: Date.now() - startedAt,
        request: tracked,
      }),
      (error) => ({
        name,
        error,
        elapsed: Date.now() - startedAt,
        request: tracked,
      }),
    );
    active.set(tracked, controller);
  };

  const abortActive = () => {
    for (const controller of controllers) controller.abort();
  };

  while (nextModelIndex < models.length && active.size === 0) {
    startModel(models[nextModelIndex++]);
  }

  let nextHedgeAt = Date.now() + HEDGE_DELAY_MS;

  try {
    while (active.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const pending = [...active.keys()];
      const canHedge =
        nextModelIndex < models.length && active.size < MAX_PARALLEL_MODELS;
      let hedgeTimer;
      const hedge = canHedge
        ? new Promise((resolve) => {
            hedgeTimer = setTimeout(
              () => resolve({ hedge: true }),
              Math.max(0, Math.min(nextHedgeAt - Date.now(), remaining)),
            );
          })
        : null;

      const outcome = await Promise.race(hedge ? [...pending, hedge] : pending);
      clearTimeout(hedgeTimer);

      if (outcome.hedge) {
        startModel(models[nextModelIndex++]);
        nextHedgeAt = Date.now() + HEDGE_DELAY_MS;
        continue;
      }

      const completedController = active.get(outcome.request);
      active.delete(outcome.request);
      controllers.delete(completedController);

      if (outcome.error) {
        lastError = outcome.error;
        const status = geminiErrorStatus(outcome.error);
        const transient =
          TRANSIENT_STATUSES.has(status) || isTransientGeminiError(outcome.error);
        const errorLabel = status ?? outcome.error?.code ?? "request error";
        console.error(
          `Gemini ${outcome.name} failed after ${outcome.elapsed}ms: ${errorLabel}`,
        );
        if (!transient) {
          abortActive();
          throw outcome.error;
        }

        if (nextModelIndex < models.length && active.size < MAX_PARALLEL_MODELS) {
          startModel(models[nextModelIndex++]);
          nextHedgeAt = Date.now() + HEDGE_DELAY_MS;
        }
        continue;
      }

      console.info(`Gemini ${outcome.name} completed in ${outcome.elapsed}ms`);
      abortActive();
      return outcome.result;
    }
  } finally {
    abortActive();
  }

  throw lastError ?? new Error("All AI models timed out before responding");
}
