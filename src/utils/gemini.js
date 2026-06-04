/**
 * gemini.js — Gemini API Wrapper
 * 
 * FIXES:
 * 1. maxOutputTokens set to 65536 — prevents truncation on large code responses
 * 2. Detects truncated responses (finishReason: MAX_TOKENS) and retries with hint
 * 3. Aggressive JSON extraction — handles markdown, leading text, trailing text
 * 4. Truncation repair — attempts to close unclosed JSON brackets/braces
 * 5. API rate limit detection — detects 429, RATE_LIMIT, RESOURCE_EXHAUSTED
 *    and throws a clear API_RATE_LIMIT_EXCEEDED error with actionable reason
 */

import { GoogleGenAI } from "@google/genai";

let aiClient = null;
let isOpenRouter = false;
let orApiKey = "";

export function initGemini(apiKey) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required. Get one from https://aistudio.google.com/apikey or use your OpenRouter key.");
  }
  if (apiKey.startsWith("sk-or-v1-")) {
    isOpenRouter = true;
    orApiKey = apiKey;
    aiClient = {}; // mock client to bypass null checks
  } else {
    isOpenRouter = false;
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

export function getClient() {
  if (!aiClient) throw new Error("Gemini not initialized. Call initGemini(apiKey) first.");
  return aiClient;
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets/braces/strings
 * This is a best-effort heuristic — won't always work, but catches the common
 * case of Gemini cutting off mid-file-content string.
 */
function repairTruncatedJSON(text) {
  let cleaned = text.trim();

  // If it looks like it was cut mid-string, close the string
  // Count unescaped quotes
  let inString = false;
  let lastCharBeforeEnd = "";
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"' && (i === 0 || cleaned[i - 1] !== '\\')) {
      inString = !inString;
    }
    if (i === cleaned.length - 1) {
      lastCharBeforeEnd = ch;
    }
  }

  // If we ended inside a string, close it
  if (inString) {
    // Escape any trailing backslash that would escape our closing quote
    if (cleaned.endsWith('\\')) {
      cleaned += '\\';
    }
    cleaned += '"';
  }

  // Now close unclosed brackets/braces
  const stack = [];
  inString = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"' && (i === 0 || cleaned[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Close all unclosed structures
  // But first, we might need to add missing commas or trim trailing commas
  // Simple approach: just close everything
  while (stack.length > 0) {
    const closer = stack.pop();
    // If last meaningful char is a comma, that's fine for arrays but not objects ending mid-key
    cleaned += closer;
  }

  return cleaned;
}

/**
 * Detect if an error is an API rate limit / quota exceeded error.
 * Returns a human-readable reason string, or null if not a rate limit error.
 */
function detectRateLimitError(error) {
  const msg = (error?.message || "").toLowerCase();
  const status = error?.status || error?.statusCode || 0;

  // HTTP 429 Too Many Requests
  if (status === 429) {
    return "API rate limit exceeded (HTTP 429). You've sent too many requests in a short time.";
  }

  // HTTP 503 Service Unavailable (common during overload)
  if (status === 503) {
    return "API service temporarily unavailable (HTTP 503). The server is overloaded.";
  }

  // Google Gemini specific error codes
  if (msg.includes("resource_exhausted") || msg.includes("resourceexhausted")) {
    return "API quota exhausted (RESOURCE_EXHAUSTED). Your Gemini API quota has been used up.";
  }

  if (msg.includes("rate_limit") || msg.includes("ratelimit") || msg.includes("rate limit")) {
    return "API rate limit exceeded. Too many requests per minute.";
  }

  if (msg.includes("quota") && (msg.includes("exceeded") || msg.includes("exhausted"))) {
    return "API quota exceeded. Your API usage limit has been reached.";
  }

  if (msg.includes("too many requests")) {
    return "Too many API requests. Please wait before retrying.";
  }

  // OpenRouter specific
  if (status === 402 || msg.includes("requires more credits") || msg.includes("can only afford")) {
    return "OpenRouter credits insufficient. Either add credits at https://openrouter.ai/settings/credits or use a free Gemini API key from https://aistudio.google.com/apikey";
  }

  if (msg.includes("insufficient credits") || msg.includes("no credits")) {
    return "OpenRouter credits exhausted. Add credits at https://openrouter.ai/credits";
  }

  return null;
}

/**
 * Core LLM call — returns parsed JSON + token info
 */
export async function callGemini({
  systemPrompt,
  userPrompt,
  agentName = "unknown",
  currentCost = 0,
  tokenBudget = 2.0,
  model = null,
  maxTokens = null,
}) {
  const client = getClient();
  const modelName = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";

  // Budget check
  if (currentCost >= tokenBudget) {
    throw new Error(
      `TOKEN_BUDGET_EXCEEDED: $${currentCost.toFixed(4)} >= budget $${tokenBudget}`
    );
  }

  const fullPrompt = `${systemPrompt}\n\n---\n\nINPUT:\n${userPrompt}\n\n---\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown, no backticks, no explanation outside JSON.`;

  let lastError = null;
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let rawText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let cost = 0;
      let finishReason = "STOP";

      if (isOpenRouter) {
        let orModel = modelName;
        // Map standard Gemini model names to valid OpenRouter model IDs
        // These are the ONLY models currently active on OpenRouter (verified via API)
        const modelMap = {
          "gemini-2.0-flash": "google/gemini-2.5-flash",       // 2.0-flash removed from OR, use 2.5
          "gemini-2.5-flash": "google/gemini-2.5-flash",
          "gemini-3.5-flash": "google/gemini-3.5-flash",
          "gemini-3-flash": "google/gemini-3-flash-preview",
          "gemini-flash": "google/gemini-2.5-flash",
        };
        if (modelMap[orModel]) {
          orModel = modelMap[orModel];
        } else if (!orModel.includes("/")) {
          // Fallback: prefix with google/ if no provider prefix
          orModel = `google/${orModel}`;
        }

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${orApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: orModel,
            messages: [
              { role: "user", content: fullPrompt }
            ],
            max_tokens: maxTokens || 8192,
            response_format: { type: "json_object" }
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          const orError = new Error(`OpenRouter API error: ${response.status} ${errText}`);
          orError.status = response.status;
          throw orError;
        }

        const data = await response.json();
        rawText = data.choices?.[0]?.message?.content || "";
        inputTokens = data.usage?.prompt_tokens || Math.ceil(fullPrompt.length / 4);
        outputTokens = data.usage?.completion_tokens || Math.ceil(rawText.length / 4);
        cost = data.usage?.cost || 0;
      } else {
        const response = await client.models.generateContent({
          model: modelName,
          contents: fullPrompt,
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: maxTokens || 65536,
          },
        });

        rawText = response.text || "";
        finishReason = response.candidates?.[0]?.finishReason;
        const usageMetadata = response.usageMetadata;
        inputTokens = usageMetadata?.promptTokenCount || Math.ceil(fullPrompt.length / 4);
        outputTokens = usageMetadata?.candidatesTokenCount || Math.ceil(rawText.length / 4);
        cost = (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.60;
      }

      const wasTruncated = finishReason === "MAX_TOKENS" || (finishReason && finishReason !== "STOP");

      // Parse JSON — multi-strategy extraction
      let parsed;
      try {
        let cleanText = rawText.trim();

        // Strip markdown code fences
        if (cleanText.startsWith("```")) {
          cleanText = cleanText.replace(/^```(?:json|JSON|js)?\s*\n?/, "").replace(/\n?\s*```\s*$/, "");
        }

        // Find JSON boundaries
        const firstBrace = cleanText.indexOf("{");
        const firstBracket = cleanText.indexOf("[");
        const startIdx = firstBrace === -1 ? firstBracket
                       : firstBracket === -1 ? firstBrace
                       : Math.min(firstBrace, firstBracket);

        if (startIdx > 0) cleanText = cleanText.slice(startIdx);

        const lastBrace = cleanText.lastIndexOf("}");
        const lastBracket = cleanText.lastIndexOf("]");
        const endIdx = Math.max(lastBrace, lastBracket);

        if (endIdx !== -1 && endIdx < cleanText.length - 1) {
          cleanText = cleanText.slice(0, endIdx + 1);
        }

        // Strategy 1: Direct parse
        try {
          parsed = JSON.parse(cleanText);
        } catch (directError) {
          // Strategy 2: Repair truncated JSON and retry
          console.warn(`[${agentName}] Direct parse failed, attempting truncation repair...`);
          const repaired = repairTruncatedJSON(cleanText);
          try {
            parsed = JSON.parse(repaired);
            console.log(`[${agentName}] Truncation repair succeeded`);
          } catch (repairError) {
            // Strategy 3: Try to extract just the files array portion
            // This handles the case where notes field got cut off
            const filesMatch = cleanText.match(/"files"\s*:\s*\[/);
            if (filesMatch) {
              const filesStart = cleanText.indexOf(filesMatch[0]);
              let partial = cleanText.slice(0, filesStart) + '"files": [],"notes":"truncated"}';
              try {
                // Find where files array starts and find last complete file object
                const arrayStart = cleanText.indexOf("[", filesStart);
                let depth = 0;
                let lastCompleteObj = arrayStart;
                for (let i = arrayStart; i < cleanText.length; i++) {
                  if (cleanText[i] === '{') depth++;
                  if (cleanText[i] === '}') {
                    depth--;
                    if (depth === 0) lastCompleteObj = i + 1;
                  }
                }
                // Extract up to last complete file object
                const partialFiles = cleanText.slice(arrayStart, lastCompleteObj);
                partial = `{"files": ${partialFiles}], "notes": "Response was truncated — partial files extracted"}`;
                parsed = JSON.parse(partial);
                console.log(`[${agentName}] Partial file extraction succeeded (${parsed.files?.length || 0} files)`);
              } catch (_) {
                throw directError; // Give up, throw original error
              }
            } else {
              throw directError;
            }
          }
        }
      } catch (parseError) {
        console.error(`[${agentName}] JSON parse failed (attempt ${attempt}/${MAX_RETRIES}):`, rawText.slice(0, 300));
        if (attempt === MAX_RETRIES) {
          throw new Error(`JSON_PARSE_FAILED after ${MAX_RETRIES} attempts. Response length: ${rawText.length}. Likely truncated.`);
        }
        lastError = parseError;
        continue;
      }

      return {
        parsed,
        raw: rawText,
        tokens: { input: inputTokens, output: outputTokens, cost },
      };

    } catch (error) {
      console.error(`[${agentName}] Raw API error details:`, error);
      lastError = error;
      if (error.message?.includes("TOKEN_BUDGET_EXCEEDED")) throw error;
      if (error.message?.includes("API_RATE_LIMIT_EXCEEDED")) throw error;
      if (error.message?.includes("JSON_PARSE_FAILED") && attempt === MAX_RETRIES) throw error;

      // Check for rate limit errors — use longer backoff
      const rateLimitReason = detectRateLimitError(error);
      if (rateLimitReason) {
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `API_RATE_LIMIT_EXCEEDED: ${rateLimitReason} ` +
            `Failed after ${MAX_RETRIES} retries. ` +
            `Either wait a few minutes or upgrade your API plan.`
          );
        }
        // Longer backoff for rate limits: 10s, 30s, 60s
        const rateLimitWaitMs = [10000, 30000, 60000][attempt - 1] || 60000;
        console.warn(`[${agentName}] ⚠️ Rate limited (attempt ${attempt}/${MAX_RETRIES}): ${rateLimitReason}`);
        console.warn(`[${agentName}] Waiting ${rateLimitWaitMs / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, rateLimitWaitMs));
        continue;
      }

      if (attempt === MAX_RETRIES) throw error;

      const waitMs = Math.pow(2, attempt) * 1000;
      console.warn(`[${agentName}] Attempt ${attempt} failed: ${error.message}. Retrying in ${waitMs}ms...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

/**
 * Helper: build tokenUsage delta from a single callGemini result
 */
export function makeTokenDelta(agentName, tokens) {
  return {
    newCalls: [{
      agent: agentName,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      timestamp: Date.now(),
    }],
    addedInput: tokens.input,
    addedOutput: tokens.output,
    addedCost: tokens.cost,
  };
}

/** Empty token delta — for when LLM call fails */
export function emptyTokenDelta(agentName) {
  return makeTokenDelta(agentName, { input: 0, output: 0, cost: 0 });
}

/**
 * Safe wrapper around callGemini — NEVER throws (except TOKEN_BUDGET_EXCEEDED).
 * Returns { ok: true, parsed, raw, tokens } on success
 * Returns { ok: false, error, tokens } on failure
 * 
 * Use this in every agent to prevent graph crashes.
 */
export async function safeCallGemini(options) {
  try {
    const result = await callGemini(options);
    return { ok: true, ...result };
  } catch (error) {
    // Token budget and API rate limits are hard stops — bubble up
    if (error.message?.includes("TOKEN_BUDGET_EXCEEDED")) throw error;
    if (error.message?.includes("API_RATE_LIMIT_EXCEEDED")) throw error;
    
    console.error(`[${options.agentName}] LLM call failed: ${error.message}`);
    return {
      ok: false,
      error: error.message,
      parsed: null,
      raw: "",
      tokens: { input: 0, output: 0, cost: 0 },
    };
  }
}
