import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const PRIMARY_GEMINI_MODEL = sanitizeModel(
  Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash",
);
const GEMINI_MODELS = [
  ...new Set([
    PRIMARY_GEMINI_MODEL,
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
  ]),
];
const MAX_BODY_LENGTH = 6_500_000;
const MAX_IMAGE_LENGTH = 5_000_000;
const modelCooldowns = new Map<string, number>();

const tutorStepSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short title for this step, at most 6 words." },
    instruction: { type: "string", description: "A concise imperative instruction for the user." },
    detail: { type: "string", description: "One short helpful explanation, including what success looks like." },
    targetLabel: { type: ["string", "null"], description: "The exact visible label of the UI target, or null." },
    target: {
      anyOf: [
        {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
      description: "Visible target bounds normalized to a 0-1000 coordinate space, or null.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    completed: { type: "boolean" },
    needsClarification: { type: "boolean" },
    clarification: { type: ["string", "null"] },
  },
  required: [
    "title",
    "instruction",
    "detail",
    "targetLabel",
    "target",
    "confidence",
    "completed",
    "needsClarification",
    "clarification",
  ],
  additionalProperties: false,
};

const tutorPlanSchema = {
  type: "object",
  properties: {
    responseType: {
      type: "string",
      enum: ["guide", "explanation", "troubleshooting"],
      description: "The presentation style that best matches the user request.",
    },
    title: { type: "string", description: "A short title for the complete tutorial." },
    summary: { type: "string", description: "A concise direct answer or description of the overall approach." },
    sections: {
      type: "array",
      description: "Explanatory or diagnostic sections. Use an empty array for a straightforward guide.",
      minItems: 0,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short section heading." },
          content: { type: "string", description: "A concise paragraph written for the user." },
          points: {
            type: "array",
            minItems: 0,
            maxItems: 6,
            items: { type: "string" },
            description: "Optional supporting facts, observations, or cautions.",
          },
        },
        required: ["title", "content", "points"],
        additionalProperties: false,
      },
    },
    steps: {
      type: "array",
      description: "Ordered user actions for guides and troubleshooting. Use an empty array for explanations.",
      minItems: 0,
      maxItems: 12,
      items: tutorStepSchema,
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    completed: { type: "boolean" },
  },
  required: ["responseType", "title", "summary", "sections", "steps", "confidence", "completed"],
  additionalProperties: false,
};

const nestedExplanationSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "A clearer plain-language explanation of this one step." },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      description: "An ordered mini-guide whose steps use the same shape and behavior as the main guide.",
      items: tutorStepSchema,
    },
    tip: { type: ["string", "null"], description: "One useful caution or recognition tip, or null." },
  },
  required: ["summary", "steps", "tip"],
  additionalProperties: false,
};

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function sanitizeModel(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "") || "gemini-3.8-flash";
}

function text(value: unknown, maxLength: number) {
  return String(value || "").trim().slice(0, maxLength);
}

function limitedJson(value: unknown, maxLength = 40_000) {
  if (value == null) return "";
  const serialized = JSON.stringify(value);
  if (serialized.length > maxLength) throw new HttpError("The tutorial context is too large.", 413);
  return serialized;
}

function imageFrom(body: Record<string, unknown>) {
  const imageData = typeof body.imageData === "string" ? body.imageData : "";
  if (!imageData || imageData.length > MAX_IMAGE_LENGTH) {
    throw new HttpError("A valid screen capture is required.", imageData ? 413 : 400);
  }
  return imageData;
}

function extractInteractionText(response: Record<string, unknown>) {
  const steps = Array.isArray(response.steps) ? response.steps : [];
  const fromSteps = steps
    .filter((step): step is Record<string, unknown> => Boolean(step && typeof step === "object" && (step as Record<string, unknown>).type === "model_output"))
    .flatMap((step) => Array.isArray(step.content) ? step.content : [])
    .filter((content): content is Record<string, unknown> => Boolean(content && typeof content === "object" && (content as Record<string, unknown>).type === "text"))
    .map((content) => typeof content.text === "string" ? content.text : "")
    .join("");
  return fromSteps || (typeof response.output_text === "string" ? response.output_text : "");
}

function rateLimitCooldownMs(retryAfter: string | null, responseBody: string) {
  let delayMs = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  }
  if (!(delayMs > 0)) {
    try {
      const details = JSON.parse(responseBody)?.error?.details;
      const retryDelay = Array.isArray(details)
        ? details.find((detail: unknown) => detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).retryDelay === "string")?.retryDelay
        : undefined;
      const match = typeof retryDelay === "string" ? retryDelay.match(/^(\d+(?:\.\d+)?)s$/) : null;
      if (match) delayMs = Number(match[1]) * 1000;
    } catch {
      // Use the default cooldown.
    }
  }
  return Math.max(1000, Math.min(delayMs > 0 ? delayMs : 60_000, 15 * 60_000));
}

async function requestStructured(prompt: string, imageData: string, schema: unknown) {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new HttpError("The tutor service is not configured.", 503);

  let sawRateLimit = false;
  let lastServerError = "";
  for (const model of GEMINI_MODELS) {
    if ((modelCooldowns.get(model) || 0) > Date.now()) {
      sawRateLimit = true;
      continue;
    }

    let rateLimited = false;
    let serverFailed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            store: false,
            input: [
              { type: "text", text: prompt },
              { type: "image", mime_type: "image/jpeg", data: imageData },
            ],
            generation_config: { thinking_level: "high" },
            response_format: { type: "text", mime_type: "application/json", schema },
          }),
        });

        if (!response.ok) {
          const raw = await response.text();
          let upstreamCode = "";
          let upstreamMessage = "";
          try {
            const parsedError = JSON.parse(raw)?.error;
            upstreamCode = typeof parsedError?.code === "string" ? parsedError.code.slice(0, 80) : "";
            upstreamMessage = typeof parsedError?.message === "string" ? parsedError.message.slice(0, 300) : "";
          } catch {
            // Keep the upstream response body private.
          }
          if (response.status === 429) {
            modelCooldowns.set(model, Date.now() + rateLimitCooldownMs(response.headers.get("retry-after"), raw));
            sawRateLimit = true;
            rateLimited = true;
            break;
          }
          if (response.status >= 500) {
            console.error("Gemini upstream failure", {
              status: response.status,
              model,
              code: upstreamCode || "unknown",
              message: upstreamMessage || "No upstream message",
            });
            lastServerError = upstreamMessage;
            if (attempt === 0) {
              await new Promise((resolve) => setTimeout(resolve, 900));
              continue;
            }
            serverFailed = true;
            break;
          }
          const detail = upstreamMessage ? ` ${upstreamMessage}` : "";
          throw new HttpError(`Gemini rejected the request (${response.status}).${detail}`, 502);
        }

        modelCooldowns.delete(model);
        const json = await response.json() as Record<string, unknown>;
        if (json.status === "incomplete") {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 900));
            continue;
          }
          throw new HttpError("Gemini stopped before finishing the tutorial. Please try again.", 502);
        }
        if (json.status === "failed" || json.status === "cancelled") {
          throw new HttpError("Gemini could not complete the tutorial request. Please try again.", 502);
        }

        const output = extractInteractionText(json);
        if (!output) throw new HttpError("Gemini returned an empty response.", 502);
        try {
          return JSON.parse(output);
        } catch (error) {
          if (attempt === 0 && error instanceof SyntaxError) {
            await new Promise((resolve) => setTimeout(resolve, 900));
            continue;
          }
          throw new HttpError("Gemini returned incomplete structured data. Please try again.", 502);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new HttpError("Gemini did not respond within 90 seconds. Try a smaller window capture.", 504);
        }
        if (attempt === 0 && error instanceof TypeError) {
          await new Promise((resolve) => setTimeout(resolve, 900));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (rateLimited) continue;
    if (serverFailed) continue;
  }

  if (sawRateLimit) throw new HttpError("Gemini is busy right now. Please try again shortly.", 429);
  if (lastServerError) {
    throw new HttpError(`Gemini is temporarily unavailable. ${lastServerError}`.slice(0, 500), 502);
  }
  throw new HttpError("Unable to reach Gemini after two attempts.", 502);
}

function buildAskRequest(body: Record<string, unknown>) {
  const question = text(body.question, 2000);
  const sourceName = text(body.sourceName, 300);
  const imageData = imageFrom(body);
  if (!question) throw new HttpError("A tutorial question is required.", 400);
  if (!sourceName) throw new HttpError("A screen source name is required.", 400);

  const previousPlan = body.previousPlan == null ? "" : limitedJson(body.previousPlan);
  const issue = text(body.issue, 1000);
  const stepIndex = Number.isInteger(body.currentStepIndex) ? Number(body.currentStepIndex) : 0;
  const revisionContext = previousPlan
    ? `\nExisting plan: ${previousPlan}\nThe user reported a problem at step ${Math.max(0, stepIndex) + 1}: ${issue || "The step did not work"}\nRewrite the complete plan to fit the newly visible screen. Preserve already completed steps at the beginning and revise the current and remaining steps.`
    : "";
  const prompt = `You are ScreenProf, a careful desktop software tutor.\n\nUser request: ${question}\nVisible source: ${sourceName}${revisionContext}\n\nFirst identify the request type, then shape the response for that use case:\n- guide: The user wants to perform or complete a task. Return the complete ordered procedure in steps and normally leave sections empty.\n- explanation: The user wants to understand what, why, or how something works without performing a task. Set steps to an empty array and return 1 to 6 readable sections with useful supporting points.\n- troubleshooting: The user wants to diagnose or fix a problem. Use sections for visible evidence and likely causes, then return ordered diagnostic or corrective steps.\n\nRules:\n- Set responseType to exactly guide, explanation, or troubleshooting.\n- For guide and troubleshooting responses, return every necessary action now, up to 12 concise steps. Do not make the user wait for a separate AI request after every step.\n- Each step must contain exactly one user action.\n- Only claim a control or condition is currently visible when supported by the screenshot.\n- Coordinates use the screenshot itself, normalized from 0 to 1000.\n- Supply target coordinates only for a control visible on this screenshot; use null for controls that appear on later screens.\n- Explanations must be informative prose, not artificial action steps, and must use an empty steps array.\n- If an actionable goal is already complete, set completed true.\n- If a step is uncertain, say what the user should look for and use a null target instead of inventing UI.\n- Do not request or expose passwords, financial data, authentication codes, API keys, or other secrets.\n- Warn before irreversible or consequential actions.\n- Keep all content crisp, practical, and tailored to the classified request type.`;

  return { prompt, imageData, schema: tutorPlanSchema };
}

function buildExplainRequest(body: Record<string, unknown>) {
  const question = text(body.question, 2000);
  const sourceName = text(body.sourceName, 300);
  const imageData = imageFrom(body);
  if (!question) throw new HttpError("A tutorial goal is required.", 400);
  if (!sourceName) throw new HttpError("A screen source name is required.", 400);

  const step = body.step && typeof body.step === "object" ? body.step as Record<string, unknown> : null;
  const instruction = text(step?.instruction, 800);
  const detail = text(step?.detail, 1200);
  if (!instruction) throw new HttpError("A tutorial step is required.", 400);

  const ancestry = Array.isArray(body.ancestry)
    ? body.ancestry.slice(0, 20).map((item) => text(item, 300)).filter(Boolean)
    : [];
  const issue = text(body.issue, 1000);
  const ancestryContext = ancestry.length ? `\nParent path: ${ancestry.join(" > ")}` : "";
  const issueContext = issue ? `\nThe user reported this problem with the selected step: ${issue}` : "";
  const prompt = `You are ScreenProf. The user wants a clearer inline mini-guide for one step in an existing desktop tutorial.\n\nOverall goal: ${question}\nApplication or screen: ${sourceName}${ancestryContext}\nSelected step: ${instruction}\nExisting detail: ${detail}${issueContext}\n\nExplain only this selected step as 2 to 6 tiny, ordered steps. Every returned step must contain exactly one user action and use the same full step shape as a main tutorial step, including a concise detail and success cue. The returned steps may themselves be expanded later, so make each one independently understandable. Supply target coordinates only for controls visibly supported by this screenshot; otherwise use null. Do not repeat the whole tutorial, branch to another task, or include actions that belong after the selected parent step. Use plain, concise language.`;

  return { prompt, imageData, schema: nestedExplanationSchema };
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405, headers: { Allow: "POST" } });
    }

    try {
      const declaredLength = Number(req.headers.get("content-length") || 0);
      if (declaredLength > MAX_BODY_LENGTH) throw new HttpError("The screen capture is too large.", 413);
      const rawBody = await req.text();
      if (rawBody.length > MAX_BODY_LENGTH) throw new HttpError("The screen capture is too large.", 413);

      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HttpError("A valid JSON request is required.", 400);
      }
      const body = parsed as Record<string, unknown>;
      const request = body.operation === "ask"
        ? buildAskRequest(body)
        : body.operation === "explain"
        ? buildExplainRequest(body)
        : null;
      if (!request) throw new HttpError("Unsupported tutor operation.", 400);

      const userId = typeof ctx.userClaims?.id === "string"
        ? ctx.userClaims.id
        : typeof ctx.jwtClaims?.sub === "string"
        ? ctx.jwtClaims.sub
        : "";
      if (!userId) throw new HttpError("Sign in to use ScreenProf.", 401);
      const { data: allowed, error: quotaError } = await ctx.supabaseAdmin.rpc(
        "consume_tutor_request",
        { p_user_id: userId, p_limit: 30 },
      );
      if (quotaError) throw new HttpError("The tutor usage check is unavailable.", 503);
      if (!allowed) throw new HttpError("You have reached the hourly tutor limit. Please try again later.", 429);

      const result = await requestStructured(request.prompt, request.imageData, request.schema);
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : error instanceof SyntaxError
        ? 400
        : 500;
      const message = error instanceof HttpError
        ? error.message
        : error instanceof SyntaxError
        ? "A valid JSON request is required."
        : "The tutor service could not complete the request.";
      return Response.json({ error: message }, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    }
  }),
};
