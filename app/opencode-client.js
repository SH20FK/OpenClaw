import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const isWindows = process.platform === "win32";

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+/i,
  /del\s+\/s\s+\/q/i,
  /format\s+/i,
  /rd\s+\/s\s+\/q/i,
  /rmdir\s+\/s\s+\/q/i,
  /shutdown/i,
  /reg\s+delete/i,
  /reg\s+add/i,
  /icacls/i,
  /takeown/i,
  /attrib\s+-r\s+-a/i,
  /chmod\s+000/i,
  /chown\s+/i,
];

function truncateDebug(text, max = 300) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function authHeaders(username, password) {
  if (!password) {
    return {};
  }

  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function extractText(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseSseEventChunk(chunk) {
  const lines = chunk.split("\n");
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}

function toModelPayload(model) {
  if (!model) {
    return undefined;
  }

  if (typeof model === "object" && model.providerID && model.modelID) {
    return model;
  }

  if (typeof model !== "string") {
    return undefined;
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    return undefined;
  }

  const providerID = model.slice(0, slashIndex).trim();
  const modelID = model.slice(slashIndex + 1).trim();

  if (!providerID || !modelID) {
    return undefined;
  }

  return { providerID, modelID };
}

function extractStreamTextFromEvent(event) {
  const part = event?.properties?.part;
  if (event?.type !== "message.part.updated" || part?.type !== "text") {
    return "";
  }

  return typeof part.text === "string" ? part.text : "";
}

export class OpenCodeClient {
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.username = options.username;
    this.password = options.password;
    this.workingDir = options.workingDir;
    this.model = options.model;
    this.agent = options.agent;
    this.port = options.port;
    this.serverProcess = null;
    this.startPromise = null;
    
    console.log(`[Security] OpenCodeClient инициализирован с директорией: ${this.workingDir}`);
  }

  isPathSafe(targetPath) {
    if (!targetPath) return true;
    
    const normalized = targetPath.replace(/\\/g, "/");
    
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      const absolutePath = path.resolve(normalized);
      const workDir = path.resolve(this.workingDir);
      
      if (!absolutePath.startsWith(workDir)) {
        console.error(`[Security] ЗАПРЕЩЁН абсолютный путь за пределами рабочей директории: ${targetPath}`);
        return false;
      }
    }
    
    const resolved = path.resolve(this.workingDir, normalized);
    const workDir = path.resolve(this.workingDir);
    
    if (!resolved.startsWith(workDir)) {
      console.error(`[Security] ЗАПРЕЩЁН выход за пределы рабочей директории: ${targetPath}`);
      return false;
    }
    
    return true;
  }

  checkDangerousCommand(text) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(text)) {
        console.error(`[Security] ⚠️ ПОДОЗРИТЕЛЬНАЯ КОМАНДА: ${text.match(pattern)[0]}`);
        console.error(`[Security] Сообщение содержит потенциально опасную команду!`);
        return true;
      }
    }
    return false;
  }

  async request(pathname, init = {}) {
    const method = init.method || "GET";
    console.log(`[OpenCode] >>> ЗАПРОС: ${method} ${pathname}`);
    const startTime = Date.now();
    
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...authHeaders(this.username, this.password),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const duration = Date.now() - startTime;
    console.log(`[OpenCode] <<< ОТВЕТ: ${method} ${pathname} - ${response.status} (${duration}мс)`);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[OpenCode] ОШИБКА API: ${response.status} - ${text || response.statusText}`);
      throw new Error(`OpenCode API ${response.status}: ${text || response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const text = await response.text();
      if (!text.trim()) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(
          `OpenCode API returned invalid JSON for ${pathname}: ${truncateDebug(text, 500)}`
        );
      }
    }

    return response.text();
  }

  async checkServer() {
    console.log("[OpenCode] Проверка сервера...");
    try {
      const health = await this.request("/global/health");
      console.log("[OpenCode] Сервер РАБОТАЕТ:", health);
      return true;
    } catch (error) {
      console.log("[OpenCode] Сервер НЕ ОТВЕЧАЕТ:", error.message);
      return false;
    }
  }

  async ensureServer() {
    console.log("[OpenCode] Проверка доступности сервера...");
    const isUp = await this.checkServer();
    if (isUp) {
      console.log("[OpenCode] Сервер уже запущен");
      return;
    }
    
    console.log("[OpenCode] Сервер не запущен, запускаю...");

    if (this.serverProcess) {
      try {
        this.serverProcess.kill(isWindows ? "NODE" : "SIGTERM");
      } catch {
        // ignore if already dead
      }
      this.serverProcess = null;
    }

    if (!this.startPromise) {
      this.startPromise = this.startLocalServer();
    }
    await this.startPromise;
  }

  async startLocalServer() {
    if (this.serverProcess) {
      try {
        this.serverProcess.kill(isWindows ? "NODE" : "SIGTERM");
      } catch {
        // ignore
      }
      this.serverProcess = null;
    }

    const opencodeArgs = ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)];

    console.log(`[Security] ⚠️ ВНИМАНИЕ: Сервер запущен в директории ${this.workingDir}`);
    console.log(`[Security] ⚠️ Агент имеет доступ ко всем файлам в этой директории!`);
    console.log(`[Security] ⚠️ Не запускайте бота от имени администратора!`);
    console.log(`[Security] ⚠️ Рекомендуется использовать отдельного пользователя с ограниченными правами.`);

    this.serverProcess = spawn(
      isWindows ? "cmd.exe" : "opencode",
      isWindows ? ["/c", "opencode", ...opencodeArgs] : opencodeArgs,
      {
        cwd: this.workingDir,
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      }
    );

    let stderr = "";
    this.serverProcess.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    this.serverProcess.on("exit", (code) => {
      if (code !== 0) {
        console.error(`[OpenCode] Процесс сервера завершился с кодом ${code}`);
      }
      this.serverProcess = null;
      this.startPromise = null;
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await this.request("/global/health");
        console.log(`[OpenCode] Сервер запущен (попытка ${attempt + 1})`);
        return;
      } catch {
        if (this.serverProcess.exitCode !== null) {
          console.error(`[OpenCode] Не удалось запустить сервер: ${stderr.trim()}`);
          throw new Error(`Не удалось запустить сервер. ${stderr.trim()}`.trim());
        }
        await delay(500);
      }
    }

    throw new Error("Timed out waiting for opencode server to start");
  }

  async createSession(title) {
    console.log(`[OpenCode] Создаю сессию: "${title}"`);
    await this.ensureServer();
    console.log("[OpenCode] Отправка запроса на создание сессии...");
    const result = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    console.log(`[OpenCode] Сессия создана: ${result?.id || result}`);
    return result;
  }

  async sendMessage(sessionId, message, modelOverride = "") {
    await this.ensureServer();

    const payload = {
      agent: this.agent,
      parts: [{ type: "text", text: message }],
    };

    const resolvedModel = modelOverride || this.model;
    const modelPayload = toModelPayload(resolvedModel);
    if (modelPayload) {
      payload.model = modelPayload;
    }

    const response = await this.request(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (response === null) {
      throw new Error(`OpenCode returned empty response for session ${sessionId}`);
    }

    if (!response || typeof response !== "object") {
      return {
        raw: response,
        text: "",
        info: {},
      };
    }

    return {
      raw: response,
      text: extractText(response.parts),
      info: response.info || {},
    };
  }

  async sendMessageWithProgress(sessionId, message, modelOverride = "", onEvent) {
    console.log("[OpenCode] НАЧАЛО: Отправка сообщения в сессию");
    console.log(`[OpenCode] Сессия: ${sessionId}, Модель: ${modelOverride || this.model || "по умолчанию"}, Агент: ${this.agent}`);
    console.log(`[OpenCode] Длина сообщения: ${message.length} символов`);
    
    await this.ensureServer();
    console.log("[OpenCode] Сервер готов, отправляю запрос...");

    const payload = {
      agent: this.agent,
      parts: [{ type: "text", text: message }],
    };

    const resolvedModel = modelOverride || this.model;
    const modelPayload = toModelPayload(resolvedModel);
    if (modelPayload) {
      payload.model = modelPayload;
    }

    let idleSeen = false;
    let finalText = "";
    let finalInfo = {};

    const eventAbortController = new AbortController();

    const collectEvents = async () => {
      if (typeof onEvent !== "function") {
        console.log("[OpenCode] Нет обработчика событий, пропускаю");
        return;
      }

      console.log("[OpenCode] Подключаюсь к потоку событий (SSE)...");
      const response = await fetch(`${this.baseUrl}/event`, {
        headers: {
          ...authHeaders(this.username, this.password),
        },
        signal: eventAbortController.signal,
      });

      console.log(`[OpenCode] Статус подключения: ${response.status}`);

      if (!response.ok || !response.body) {
        console.error(`[OpenCode] ОШИБКА подключения: ${response.status} ${response.statusText}`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventCount = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log("[OpenCode] Поток событий завершён");
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let sepIdx = buffer.indexOf("\n\n");

          while (sepIdx !== -1) {
            const chunk = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            const event = parseSseEventChunk(chunk);
            if (!event) {
              sepIdx = buffer.indexOf("\n\n");
              continue;
            }

            eventCount++;
            if (eventCount <= 5 || eventCount % 10 === 0) {
              console.log(`[OpenCode] Событие #${eventCount}: ${event.type}`);
            }

            onEvent(event);

            if (event.type === "session.status" && event.properties?.status?.type === "idle") {
              console.log("[OpenCode] >>> Сессия ЗАВЕРШЕНА (idle)");
              idleSeen = true;
            }

            // Логируем ВСЕ события с текстом для отладки
            if (event.type === "message.updated") {
              const role = event.properties?.info?.role;
              const msgParts = event.properties?.parts;
              console.log(`[OpenCode] message.updated: role=${role}, parts=${JSON.stringify(msgParts)?.slice(0, 100)}`);
              
              if (role === "assistant" && Array.isArray(msgParts)) {
                finalText = extractText(msgParts);
                finalInfo = event.properties?.info || {};
                console.log(`[OpenCode] Получен ответ от модели: ${finalText?.slice(0, 100)}...`);
              }
            }
            
            // Также логируем message.part.updated
            if (event.type === "message.part.updated") {
              const part = event.properties?.part;
              if (part?.text) {
                console.log(`[OpenCode] message.part.updated: text length = ${part.text.length}`);
              }
            }

            // Выход если есть ответ и это не heartbeat
            if (finalText && event.type !== "server.heartbeat") {
              console.log("[OpenCode] Есть ответ, выходим из ожидания");
              break;
            }

            if (idleSeen) {
              break;
            }

            sepIdx = buffer.indexOf("\n\n");
          }

          if (idleSeen || finalText) {
            console.log(`[OpenCode] Выход из цикла: idleSeen=${idleSeen}, finalText=${finalText ? "ЕСТЬ" : "НЕТ"}`);
            break;
          }
        }
      } catch (error) {
        if (eventAbortController.signal.aborted) {
          console.log("[OpenCode] Подключение прервано");
          return;
        }
        console.error("[OpenCode] ОШИБКА в потоке:", error);
        throw error;
      }
      
      console.log(`[OpenCode] Цикл событий завершён. Всего: ${eventCount}, finalText: ${finalText ? "ЕСТЬ" : "НЕТ"}`);
    };

    const eventsPromise = collectEvents();

    console.log("[OpenCode] Отправка запроса prompt_async...");
    const sendPromise = this.request(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).then((result) => {
      console.log("[OpenCode] Запрос принят сервером");
    }).catch((error) => {
      console.error("[OpenCode] ОШИБКА отправки:", error.message);
    });

    console.log("[OpenCode] Ожидание событий (макс 30 сек для ответа)...");
    
    // Ждём максимум 30 секунд ответ или выходим
    let waitedSeconds = 0;
    const waitInterval = setInterval(() => {
      waitedSeconds += 5;
      if (waitedSeconds % 10 === 0) {
        console.log(`[OpenCode] Ожидаю... ${waitedSeconds}сек, есть текст: ${finalText ? "ДА" : "NET"}`);
      }
    }, 5000);
    
    await Promise.race([
      eventsPromise,
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]).catch(() => {});
    
    clearInterval(waitInterval);
    
    if (!finalText) {
      console.log("[OpenCode] ВНИМАНИЕ: Текст не получен за 30 сек, пробую получить последнее сообщение...");
    }
    console.log("[OpenCode] Запрос обработан, получаю финальный ответ...");

    if (!idleSeen) {
      console.log("[OpenCode] Сессия не завершилась штатно, беру последний ответ");
    }

    console.log("[OpenCode] Загрузка последних сообщений...");
    const lastMessages = await this.request(`/session/${sessionId}/message`, {
      method: "GET",
    });
    console.log(`[OpenCode] Получено ${lastMessages?.length || 0} сообщений`);
    
    if (lastMessages && lastMessages.length > 0) {
      console.log(`[OpenCode] Последнее сообщение: role=${lastMessages[lastMessages.length-1]?.info?.role}, parts=${JSON.stringify(lastMessages[lastMessages.length-1]?.parts)?.slice(0, 100)}`);
    }

    if (Array.isArray(lastMessages) && lastMessages.length > 0) {
      const last = lastMessages[lastMessages.length - 1];
      if (last.info?.role === "assistant") {
        finalInfo = last.info || {};
        finalText = extractText(last.parts);
        console.log(`[OpenCode] Извлечён финальный текст: ${finalText?.slice(0, 100)}...`);
      }
    }

    console.log(`[OpenCode] ГОТОВ. Отправляю ответ (длина: ${finalText?.length || 0})`);
    
    return {
      raw: { lastMessages },
      text: finalText,
      info: finalInfo,
    };
  }

  async getHealth() {
    return this.request("/global/health");
  }

  async getProviders() {
    return this.request("/provider");
  }

  async getProviderConfig() {
    return this.request("/config/providers");
  }

  async getSessionDiff(sessionId) {
    return this.request(`/session/${sessionId}/diff`);
  }

  getTextDelta(event) {
    return extractStreamTextFromEvent(event);
  }

  async stop() {
    if (!this.serverProcess) {
      return;
    }
    try {
      this.serverProcess.kill(isWindows ? "NODE" : "SIGTERM");
    } catch {
      // ignore
    }
    await delay(500);
    this.serverProcess = null;
  }
}
