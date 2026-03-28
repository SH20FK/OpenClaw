import { AgentClient, normalizeAgentResult } from "./agent-client.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a coding agent that helps a Telegram user modify a local project.",
  "Return valid JSON only.",
  "Schema:",
  '{"text":"short final user-facing answer","operations":[{"type":"write|mkdir|rename|delete",...}]}',
  "Rules:",
  "- Use operations only for concrete file changes.",
  "- Paths must be relative paths inside the project root.",
  "- Keep text concise and in Russian when possible.",
  "- If no file changes are needed, return an empty operations array.",
  "- For write operations, return the full target file content.",
].join("\n");

const FILE_FLOW_SYSTEM_PROMPT = [
  "You are a coding agent that helps a Telegram user modify a local project.",
  "Return file contents only, no JSON wrapper.",
  "For each file, use exactly this format:",
  "=== FILE: path/to/file.ext ===",
  "<full file content>",
  "",
  "Rules:",
  "- Use relative paths only.",
  "- Return complete file contents.",
  "- Do not add explanations outside file blocks.",
  "- Prefer a minimal set of files needed for the task.",
].join("\n");

const CREATIVE_TASK_KEYWORDS = [
  "landing",
  "landing page",
  "лендинг",
  "сайт",
  "website",
  "web page",
  "homepage",
  "dashboard",
  "app",
  "application",
  "приложение",
  "ui",
  "ux",
  "hero section",
  "promo page",
  "promo",
];

function toChatMessages(history, prompt) {
  const messages = [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }];

  for (const item of history || []) {
    if (!item?.text) {
      continue;
    }
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
    if (!item?.text) {
      continue;
    }
    messages.push({ role: item.role === "assistant" ? "assistant" : "user", content: item.text });
  }

  messages.push({ role: "user", content: prompt });
  return messages;
}

function isCreativeTask(task) {
  const normalized = String(task || "").toLowerCase();
  return CREATIVE_TASK_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function uniquePush(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function normalizeRelativePath(filePath) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function buildFileFlowSummary(writeCount) {
  if (writeCount <= 0) {
    return "Подготовил ответ, но не смог выделить файлы для записи.";
  }
  return `Подготовил ${writeCount} файл(ов) для проекта.`;
}

function createInvalidJsonError(text) {
  const error = new Error(`Model returned invalid JSON: ${text.slice(0, 500)}`);
  error.code = "INVALID_JSON";
  error.rawContent = text;
  return error;
}

function parseJsonContent(content) {
  const text = Array.isArray(content)
    ? content.map((item) => item?.text || "").join("\n")
    : String(content || "");

  const trimmed = text.trim();

  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return parseJsonContent(unfenced);
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}$/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // continue to main error below
      }
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
      fallbackText = textMatch[1].replaceAll('\\n', '\n').replaceAll('\\"', '"').trim();
    }
  }

  const hadOperations = /"operations"\s*:\s*\[/i.test(trimmed);
  const message = fallbackText || "Модель прислала неполный ответ.";

  return {
    text: hadOperations
      ? `${message}\n\nНе удалось надежно разобрать изменения по файлам. Попробуй повторить запрос или используй модель посильнее.`
      : `${message}\n\nОтвет модели был неполным, поэтому изменения по файлам не применялись.`,
    operations: [],
  };
}

function parseFilesIntoOperations(rawContent) {
  const text = String(rawContent || "").replace(/\r\n/g, "\n");
  const fileRegex = /===\s*FILE:\s*(.+?)\s*===\n([\s\S]*?)(?=\n===\s*FILE:|$)/g;
  const operations = [];
  const createdDirs = [];
  let match;

  while ((match = fileRegex.exec(text)) !== null) {
    const filePath = normalizeRelativePath(match[1]);
    const content = match[2].replace(/^\n+/, "").replace(/\n+$/, "");

    if (!filePath || !content) {
      continue;
    }

    const parts = filePath.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      const dirPath = parts.slice(0, i).join("/");
      if (dirPath) {
        uniquePush(createdDirs, dirPath);
      }
    }

    operations.push({
      type: "write",
      path: filePath,
      content: `${content}\n`,
    });
  }

  return [
    ...createdDirs.map((dirPath) => ({ type: "mkdir", path: dirPath })),
    ...operations,
  ];
}

export class OpenAICompatibleClient extends AgentClient {
  constructor(options) {
    super();
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.siteUrl = options.siteUrl;
    this.appName = options.appName;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
    this.fileFlowEnabled = options.fileFlowEnabled !== false;
    this.fileFlowMaxTokens = Number.isFinite(options.fileFlowMaxTokens) ? options.fileFlowMaxTokens : 6000;
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
        throw new Error(`LLM request timed out after ${Math.round(this.timeoutMs / 1000)}s. Check model/provider availability or try a faster model.`);
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
      const mayRetryWithoutResponseFormat = response.status < 500 && /response_format|json_object|schema/i.test(text);

      if (!mayRetryWithoutResponseFormat) {
        throw new Error(`LLM API ${response.status}: ${text || response.statusText}`);
      }

      delete body.response_format;
      response = await this.postChatCompletions(body);

      if (!response.ok) {
        const retryText = await response.text();
        throw new Error(`LLM API ${response.status}: ${retryText || response.statusText}`);
      }
    }

    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    const parsed = parseJsonContent(message?.content);
    return { payload, parsed, rawContent: message?.content };
  }

  async requestTextResult(messages, maxTokens) {
    const body = {
      model: this.currentModel,
      temperature: 0.4,
      max_tokens: maxTokens,
      messages,
    };

    const response = await this.postChatCompletions(body);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API ${response.status}: ${text || response.statusText}`);
    }

    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    const content = Array.isArray(message?.content)
      ? message.content.map((item) => item?.text || "").join("\n")
      : String(message?.content || "");

    return { payload, content };
  }

  async requestFileFlowResult(task, options = {}) {
    const { payload, content } = await this.requestTextResult(toFileFlowMessages(options.history || [], task), this.fileFlowMaxTokens);
    const operations = parseFilesIntoOperations(content);

    if (operations.length === 0) {
      throw new Error("FILE_FLOW_PARSE_FAILED");
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
        ({ payload, parsed } = await this.requestJsonResult(toChatMessages(options.history || [], task)));
      }
    } catch (error) {
      if (error?.message === "FILE_FLOW_PARSE_FAILED") {
        parsed = {
          text: "Модель не смогла вернуть файлы в ожидаемом формате. Попробуй уточнить задачу, например попросить только `index.html` и `style.css`.",
          operations: [],
        };
        payload = { file_flow_parse_failed: true };
      } else if (error?.code !== "INVALID_JSON") {
        throw error;
      } else {
        try {
          ({ payload, parsed } = await this.requestJsonResult(toRepairMessages(options.history || [], task, error.rawContent || "")));
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
