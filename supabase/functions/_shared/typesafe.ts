/**
 * TypeSafe (Jev) client — the one place edge functions talk to the model
 * (M12). The questions, thresholds and policies live in
 * packages/shared/src/understanding.ts; this file only makes the HTTP call.
 *
 * Contract: `askJev` NEVER throws and NEVER blocks a user past `timeoutMs`.
 * It returns null for anything short of a well-formed answer — no key, a
 * timeout, a 4xx/5xx, a malformed body — and callers treat null as
 * "unavailable" and fall back (fail-open). Nothing sent to the model is ever
 * logged: warnings carry a status word only, never the state, a comment or a
 * search string.
 */
import {
  JEV_MODEL,
  type TypeSafeQuestion,
} from "../../../packages/shared/src/understanding.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Wait before the single retry on 429/529. */
const RETRY_DELAY_MS = 300;
/** A retry is only worth starting if this much of the budget is left. */
const RETRY_MIN_REMAINING_MS = 800;

export type JevAnswer = {
  type?: string;
  /** Noul answers */
  noul?: number;
  /** Choice answers */
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type JevResult = {
  answers: Record<string, JevAnswer>;
  model: string;
};

/** Every question must come back answered with the shape its type promises. */
function validAnswers(
  questions: Record<string, TypeSafeQuestion>,
  answers: unknown,
): answers is Record<string, JevAnswer> {
  if (!answers || typeof answers !== "object") return false;
  const a = answers as Record<string, JevAnswer | undefined>;
  for (const [id, q] of Object.entries(questions)) {
    const ans = a[id];
    if (!ans || typeof ans !== "object") return false;
    if (q.type === "noul") {
      if (typeof ans.noul !== "number" || !(ans.noul >= 0 && ans.noul <= 1)) {
        return false;
      }
    } else {
      const p = ans.probabilities;
      if (!p || typeof p !== "object") return false;
      const values = Object.values(p);
      if (values.length === 0) return false;
      if (!values.every((v) => typeof v === "number" && v >= 0 && v <= 1)) {
        return false;
      }
    }
  }
  return true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askJev(
  state: unknown,
  questions: Record<string, TypeSafeQuestion>,
  { timeoutMs }: { timeoutMs: number },
): Promise<JevResult | null> {
  const key = Deno.env.get("TYPESAFE_API_KEY");
  if (!key) return null;

  const deadline = Date.now() + timeoutMs;
  const body = JSON.stringify({ state, model: JEV_MODEL, questions });

  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn("typesafe: timeout");
      return null;
    }

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (e) {
      // Name only (TimeoutError / AbortError / TypeError) — never the message,
      // which could echo request details.
      console.warn(`typesafe: request failed (${(e as Error)?.name ?? "error"})`);
      return null;
    }

    if (
      (res.status === 429 || res.status === 529) && attempt === 0 &&
      deadline - Date.now() > RETRY_MIN_REMAINING_MS
    ) {
      await res.body?.cancel().catch(() => {});
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    if (!res.ok) {
      console.warn(`typesafe: HTTP ${res.status}`);
      await res.body?.cancel().catch(() => {});
      return null;
    }

    let parsed: { answers?: unknown; model?: unknown } | null;
    try {
      parsed = await res.json();
    } catch {
      console.warn("typesafe: malformed body");
      return null;
    }
    const answers = parsed?.answers;
    if (!validAnswers(questions, answers)) {
      console.warn("typesafe: unexpected answer shape");
      return null;
    }
    return {
      answers,
      model: typeof parsed?.model === "string" ? parsed.model : JEV_MODEL,
    };
  }
  return null;
}
