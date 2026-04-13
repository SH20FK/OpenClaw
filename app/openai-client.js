import { AgentClient, normalizeAgentResult } from "./agent-client.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a senior coding agent helping a Telegram user modify a local project.",
  "Return valid JSON only.",
  "Schema:",
  '{"text":"short final user-facing answer","operations":[{"type":"write|mkdir|rename|delete",...}]}',
  "Rules:",
  "- Think through the task before answering, but never reveal chain-of-thought.",
  "- Prefer the smallest safe change that fully solves the task.",
  "- Respect the existing architecture and avoid unrelated rewrites.",
  "- Use operations only for concrete file changes.",
  "- Paths must be relative paths inside the project root.",
  "- For write operations, return the full final file content.",
  "- If no file changes are needed, return an empty operations array.",
  "- Keep text concise, practical, and in Russian when possible.",
].join("\n");

const FILE_FLOW_SYSTEM_PROMPT = [
  "You are a senior product designer and frontend engineer.",
  "The user wants a polished, production-quality interface or website.",
  "Return file contents only. No JSON wrapper. No explanations outside file blocks.",
  "",
  "For each file use EXACTLY this format:",
  "=== FILE: path/to/file.ext ===",
  "<full file content>",
  "",
  "Creative direction:",
  "- Pick one strong visual direction that fits the task. Make it feel intentional, not generic.",
  "- Avoid bland default SaaS layouts, weak spacing, random gradients, and placeholder filler.",
  "- Use expressive typography, layered backgrounds, clear hierarchy, and strong rhythm.",
  "- Build a coherent design system with CSS variables for color, spacing, radius, shadows, and type.",
  "- Use modern CSS: grid, flexbox, clamp(), minmax(), fluid spacing, and responsive composition.",
  "- Make buttons, links, cards, and sections feel designed as one system.",
  "- Add restrained motion and hover states where they improve quality.",
  "- Prefer gradients, shapes, masks, patterns, and illustration-like CSS over stock placeholders.",
  "",
  "Quality requirements:",
  "- Use semantic HTML5 tags.",
  "- Keep the page polished on both desktop and mobile.",
  "- Hero sections need a clear headline, supporting copy, and a primary action.",
  "- Include only sections that improve the page. Fewer, better sections beat filler.",
  "- Inline CSS in index.html unless a separate stylesheet is clearly justified.",
  "- Inline JS unless the task clearly benefits from a separate script file.",
  "- Do not use external CDNs unless the user explicitly asks for a framework.",
  "",
  "File rules:",
  "- Use relative paths only.",
  "- Return complete file contents.",
  "- Prefer a minimal, focused set of files.",
  "- When possible, return a single self-contained index.html with inline CSS/JS.",
  "- Start directly with the first === FILE: line.",
].join("\n");

const CREATIVE_BUILD_PATTERNS = [
  /landing page/i,
  /\blanding\b/i,
  /\bhomepage\b/i,
  /\bwebsite\b/i,
  /\bweb page\b/i,
  /\bpromo page\b/i,
  /\bportfolio\b/i,
  /\bbusiness card\b/i,
  /\bhero section\b/i,
  /\bui kit\b/i,
  /\bredesign\b.*\b(page|website|landing|ui)\b/i,
  /лендинг/i,
  /сайт/i,
  /портфолио/i,
  /визитк/i,
  /промо-?страниц/i,
  /геро[йи]?[ -]?секц/i,
  /интерфейс/i,
];

const CREATIVE_VERBS = [
  "build",
  "create",
  "design",
  "make",
  "redesign",
  "craft",
  "generate",
  "сделай",
  "создай",
  "задизайн",
  "оформи",
  "сверстай",
  "переделай дизайн",
  "нарисуй",
];

const CREATIVE_TARGETS = [
  "landing",
  "page",
  "website",
  "homepage",
  "portfolio",
  "promo",
  "dashboard",
  "ui",
  "ux",
  "screen",
  "лендинг",
  "сайт",
  "страниц",
  "портфолио",
  "визитк",
  "дашборд",
  "интерфейс",
  "экран",
];

const NON_CREATIVE_HINTS = [
  "bug",
  "fix",
  "bugfix",
  "error",
  "crash",
  "stack",
  "trace",
  "api",
  "backend",
  "bot",
  "telegram",
  "companion",
  "session",
  "json",
  "model",
  "auth",
  "database",
  "migration",
  "refactor",
  "почини",
  "исправ",
  "ошиб",
  "краш",
  "бот",
  "телеграм",
  "компаньон",
  "модель",
  "бэкенд",
  "сервер",
  "рефактор",
];

function isCreativeTask(task) {
  const normalized = String(task || "").toLowerCase();

  if (NON_CREATIVE_HINTS.some((keyword) => normalized.includes(keyword))) {
    return false;
  }

  if (CREATIVE_BUILD_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const hasVerb = CREATIVE_VERBS.some((keyword) => normalized.includes(keyword));
  const hasTarget = CREATIVE_TARGETS.some((keyword) => normalized.includes(keyword));
  return hasVerb && hasTarget;
}

function toChatMessages(history, prompt) {
  const messages = [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }];
  for (const item of history || []) {
    if (!item?.text) continue;
    messages.push({ role: item.role === "assistant" ? "assistant" : "user", content: item.text });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

function toRepairMessages(history, prompt, brokenContent) {
  return [
    { role: "system", content: DEFAULT_SYSTEM_PROMPT },
    ...((history || [])
      .filter((item) => item?.text)
      .map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.text }))),
    { role: "user", content: prompt },
    {
      role: "assistant",
      content: typeof brokenContent === "string" ? brokenContent : String(brokenContent || ""),
    },
    {
      role: "user",
      content: [
        "Your previous answer was invalid or truncated JSON.",
        "Return valid JSON only.",
        'Use exactly this schema: {"text":"short final user-facing answer","operations":[{"type":"write|mkdir|rename|delete",...}]}',
        "Do not add markdown fences, explanations, or extra text.",
        "If you are unsure about file changes, return an empty operations array.",
      ].join("\n"),
    },
  ];
}

function toFileFlowMessages(history, prompt) {
  const messages = [{ role: "system", content: FILE_FLOW_SYSTEM_PROMPT }];
  for (const item of history || []) {
    if (!item?.text) continue;
    messages.push({ role: item.role === "assistant" ? "assistant" : "user", content: item.text });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

function toFileFlowRepairMessages(history, prompt, brokenContent) {
  return [
    { role: "system", content: FILE_FLOW_SYSTEM_PROMPT },
    ...((history || [])
      .filter((item) => item?.text)
      .map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.text }))),
    { role: "user", content: prompt },
    {
      role: "assistant",
      content: typeof brokenContent === "string" ? brokenContent : String(brokenContent || ""),
    },
    {
      role: "user",
      content: [
        "Rewrite your previous answer so it strictly follows the file format.",
        "Start directly with the first === FILE: line.",
        "Return a compact result that fully fits in the response.",
        "Prefer one self-contained index.html with inline CSS/JS unless a second file is necessary.",
        "Do not add prose, markdown fences, or explanations.",
      ].join("\n"),
    },
  ];
}

function normalizeRelativePath(filePath) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function uniquePush(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function parseFilesIntoOperations(rawContent) {
  const text = String(rawContent || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const markerRe = /^===\s*FILE:\s*(.+?)\s*===\s*$/gm;
  const markers = [...text.matchAll(markerRe)];

  if (markers.length === 0) {
    return parseFilesLoosely(text);
  }

  const operations = [];
  const createdDirs = [];

  for (let i = 0; i < markers.length; i += 1) {
    const match = markers[i];
    const filePath = normalizeRelativePath(match[1]);
    if (!filePath) {
      continue;
    }

    const contentStart = match.index + match[0].length + 1;
    const contentEnd = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const content = text.slice(contentStart, contentEnd).replace(/\n+$/, "");
    if (!content) {
      continue;
    }

    const parts = filePath.split("/").filter(Boolean);
    for (let depth = 1; depth < parts.length; depth += 1) {
      uniquePush(createdDirs, parts.slice(0, depth).join("/"));
    }

    operations.push({
      type: "write",
      path: filePath,
      content: `${content}\n`,
    });
  }

  if (operations.length === 0) {
    return parseFilesLoosely(text);
  }

  return [
    ...createdDirs.map((dirPath) => ({ type: "mkdir", path: dirPath })),
    ...operations,
  ];
}

function parseFilesLoosely(text) {
  const htmlFence = text.match(/```html\s*([\s\S]+?)```/i);
  if (htmlFence) {
    const content = htmlFence[1].trim();
    if (content.length > 50) {
      return [{ type: "write", path: "index.html", content: `${content}\n` }];
    }
  }

  const htmlBlock = text.match(/(<!DOCTYPE[\s\S]+|<html[\s\S]+)/i);
  if (htmlBlock) {
    const content = htmlBlock[1].trim();
    if (content.length > 100) {
      return [{ type: "write", path: "index.html", content: `${content}\n` }];
    }
  }

  return [];
}

function buildFileFlowSummary(writeCount) {
  if (writeCount <= 0) {
    return "Подготовил ответ, но не смог выделить файлы для записи.";
  }
  return `Подготовил ${writeCount} файл(ов) для проекта.`;
}

function truncateDebug(text, max = 500) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function createFileFlowError(code, rawContent = "", payload = null) {
  const error = new Error(code);
  error.code = code;
  error.rawContent = rawContent;
  error.payload = payload;
  return error;
}

function isTruncatedPayload(payload) {
  const finishReason = payload?.choices?.[0]?.finish_reason;
  return finishReason === "length" || finishReason === "max_tokens";
}

function createInvalidJsonError(text) {
  const error = new Error(`Model returned invalid JSON: ${text.slice(0, 500)}`);
  error.code = "INVALID_JSON";
  error.rawContent = text;
  return error;
}

function extractJsonObject(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    return null;
  }

  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function parseJsonContent(content) {
  const text = Array.isArray(content)
    ? content.map((item) => item?.text || "").join("\n")
    : String(content || "");

  const trimmed = text.trim();

  if (trimmed.startsWith("```")) {
    const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return parseJsonContent(unfenced);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractJsonObject(trimmed);
    if (extracted) {
      return extracted;
    }
    throw createInvalidJsonError(text);
  }
}

function buildFallbackFromBrokenJson(error) {
  const rawText = String(error?.rawContent || error?.message || "");
  const trimmed = rawText.trim();
  const textMatch = trimmed.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
  let fallbackText = "";

  if (textMatch?.[1]) {
    try {
      fallbackText = JSON.parse(`"${textMatch[1]}"`);
    } catch {
      fallbackText = textMatch[1].replaceAll("\\n", "\n").replaceAll('\\"', '"').trim();
    }
  }

  const hadOperations = /"operations"\s*:\s*\[/i.test(trimmed);
  const message = fallbackText || "Модель прислала неполный ответ.";

  return {
    text: hadOperations
      ? `${message}\n\nНе удалось надёжно разобрать изменения по файлам. Попробуй повторить запрос или используй модель посильнее.`
      : `${message}\n\nОтвет модели был неполным, поэтому изменения по файлам не применялись.`,
    operations: [],
  };
}

export class OpenAICompatibleClient extends AgentClient {
  constructor(options) {
    super();
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.siteUrl = options.siteUrl;
    this.appName = options.appName;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
    this.fileFlowEnabled = options.fileFlowEnabled !== false;
    this.fileFlowMaxTokens = Number.isFinite(options.fileFlowMaxTokens) ? options.fileFlowMaxTokens : 10_000;
    this.currentModel = null;
  }

  async postChatCompletions(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(
          `LLM request timed out after ${Math.round(this.timeoutMs / 1000)}s. ` +
          "Check model/provider availability or try a faster model."
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(this.siteUrl ? { "HTTP-Referer": this.siteUrl } : {}),
      ...(this.appName ? { "X-Title": this.appName } : {}),
    };
  }

  async readJsonPayload(response, label) {
    const raw = await response.text();

    if (!raw.trim()) {
      throw new Error(`LLM API returned empty JSON payload for ${label}`);
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`LLM API returned invalid JSON for ${label}: ${truncateDebug(raw)}`);
    }
  }

  async health() {
    return { ok: true, backend: "openai" };
  }

  async requestJsonResult(messages) {
    const body = {
      model: this.currentModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages,
    };

    let response = await this.postChatCompletions(body);

    if (!response.ok) {
      const text = await response.text();
      const mayRetryWithoutFormat =
        response.status < 500 && /response_format|json_object|schema/i.test(text);

      if (!mayRetryWithoutFormat) {
        throw new Error(`LLM API ${response.status}: ${text || response.statusText}`);
      }

      delete body.response_format;
      response = await this.postChatCompletions(body);

      if (!response.ok) {
        const retryText = await response.text();
        throw new Error(`LLM API ${response.status}: ${retryText || response.statusText}`);
      }
    }

    const payload = await this.readJsonPayload(response, "chat/completions");
    const message = payload?.choices?.[0]?.message;
    const parsed = parseJsonContent(message?.content);
    return { payload, parsed, rawContent: message?.content };
  }

  async requestTextResult(messages, maxTokens, temperature = 0.4) {
    const body = {
      model: this.currentModel,
      temperature,
      max_tokens: maxTokens,
      messages,
    };

    const response = await this.postChatCompletions(body);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API ${response.status}: ${text || response.statusText}`);
    }

    const payload = await this.readJsonPayload(response, "chat/completions");
    const message = payload?.choices?.[0]?.message;
    const content = Array.isArray(message?.content)
      ? message.content.map((item) => item?.text || "").join("\n")
      : String(message?.content || "");

    return { payload, content };
  }

  async requestFileFlowResult(task, options = {}) {
    const { payload, content } = await this.requestTextResult(
      toFileFlowMessages(options.history || [], task),
      this.fileFlowMaxTokens,
      0.65
    );

    const operations = parseFilesIntoOperations(content);
    if (operations.length === 0) {
      throw createFileFlowError("FILE_FLOW_PARSE_FAILED", content, payload);
    }

    if (isTruncatedPayload(payload)) {
      throw createFileFlowError("FILE_FLOW_TRUNCATED", content, payload);
    }

    const writeCount = operations.filter((item) => item.type === "write").length;
    return {
      payload,
      parsed: {
        text: buildFileFlowSummary(writeCount),
        operations,
      },
    };
  }

  async requestFileFlowRepairResult(task, brokenContent, options = {}) {
    const { payload, content } = await this.requestTextResult(
      toFileFlowRepairMessages(options.history || [], task, brokenContent),
      Math.min(this.fileFlowMaxTokens, 6_000),
      0.25
    );

    const operations = parseFilesIntoOperations(content);
    if (operations.length === 0 || isTruncatedPayload(payload)) {
      throw createFileFlowError("FILE_FLOW_PARSE_FAILED", content, payload);
    }

    const writeCount = operations.filter((item) => item.type === "write").length;
    return {
      payload,
      parsed: {
        text: buildFileFlowSummary(writeCount),
        operations,
      },
    };
  }

  async sendTask(task, options = {}) {
    const model = options.model || this.defaultModel;
    if (!model) {
      throw new Error("No model configured");
    }

    this.currentModel = model;
    let payload;
    let parsed;

    try {
      if (this.fileFlowEnabled && isCreativeTask(task)) {
        ({ payload, parsed } = await this.requestFileFlowResult(task, options));
      } else {
        ({ payload, parsed } = await this.requestJsonResult(
          toChatMessages(options.history || [], task)
        ));
      }
    } catch (error) {
      if (error?.code === "FILE_FLOW_PARSE_FAILED" || error?.code === "FILE_FLOW_TRUNCATED") {
        try {
          ({ payload, parsed } = await this.requestFileFlowRepairResult(
            task,
            error.rawContent || "",
            options
          ));
        } catch (repairError) {
          try {
            ({ payload, parsed } = await this.requestFileFlowResult(
              `${task}\n\nIMPORTANT: Return a compact solution in one self-contained index.html file. Start immediately with === FILE: index.html ===`,
              options
            ));
          } catch {
            parsed = {
              text: "Модель не смогла вернуть файлы в надёжном формате. Попробуй уточнить задачу или ограничиться 1-2 файлами.",
              operations: [],
            };
            payload = {
              file_flow_parse_failed: true,
              repair_failed: repairError?.code || repairError?.message || "unknown",
            };
          }
        }
      } else if (error?.code !== "INVALID_JSON") {
        throw error;
      } else {
        try {
          ({ payload, parsed } = await this.requestJsonResult(
            toRepairMessages(options.history || [], task, error.rawContent || "")
          ));
        } catch (retryError) {
          if (retryError?.code === "INVALID_JSON") {
            parsed = buildFallbackFromBrokenJson(retryError);
            payload = { retry_failed_invalid_json: true };
          } else {
            throw retryError;
          }
        }
      }
    } finally {
      this.currentModel = null;
    }

    return normalizeAgentResult({
      text: parsed?.text,
      operations: parsed?.operations,
      raw: payload,
      usage: payload?.usage || null,
      model,
    });
  }
}
