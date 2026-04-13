import { Bot, InlineKeyboard, Keyboard } from "grammy";

import { createApiServer } from "./api-server.js";
import { config, isAuthorized, validateBotConfig } from "./config.js";
import { DeviceStore } from "./device-store.js";
import { LocalFileExecutor } from "./file-executor.js";
import { JobStore } from "./job-store.js";
import { OpenAICompatibleClient } from "./openai-client.js";
import { OpenCodeAgentClient } from "./opencode-agent-client.js";
import { SessionStore } from "./session-store.js";

const PRESETS = {
  default: { title: "Universal", emoji: "🎯", instruction: "", description: "Balanced mode for normal coding tasks." },
  bugfix: { title: "Bugfix", emoji: "🩹", instruction: "Act as a sharp debugging engineer. Find the root cause first, then return the smallest safe fix.", description: "Focus on root cause and minimal change." },
  feature: { title: "Feature", emoji: "✨", instruction: "Implement the task as a new feature. Follow the current style and return precise file operations when edits are needed.", description: "Best for adding new behavior." },
  refactor: { title: "Refactor", emoji: "🧼", instruction: "Improve structure and readability without changing external behavior.", description: "Cleanup without changing behavior." },
  explain: { title: "Explain", emoji: "🧠", instruction: "Explain the code simply and clearly. Avoid file operations unless explicitly requested.", description: "Read and explain existing code." },
  review: { title: "Review", emoji: "🔎", instruction: "Do a short engineering review. Call out risks, weaknesses, and the best next improvements.", description: "Project review and risk scan." },
};

const JOB_STATUS_LABELS = {
  pending: "🕒 pending",
  approved: "📤 queued",
  running: "⚙️ running",
  applied: "✅ applied",
  failed: "❌ failed",
  rejected: "🚫 rejected",
  undone: "↩️ undone",
};

function escapeHtml(text) {
  return String(text || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(text, max = 500) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatDateTime(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function splitForTelegram(text, maxLength = 3500) {
  const chunks = [];
  let rest = String(text || "");
  while (rest.length > maxLength) {
    let splitAt = rest.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.5) splitAt = maxLength;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length > 0 ? chunks : [""];
}

function parseCommandArgs(text) {
  const firstSpace = text.indexOf(" ");
  return firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
}

function wrapPromptWithPreset(userText, presetId, activeDevice) {
  const preset = PRESETS[presetId] || PRESETS.default;
  return [
    "Execution mode:",
    `- Preset: ${preset.title}`,
    `- Active PC: ${activeDevice?.name || "not selected"}`,
    "",
    preset.instruction ? `Mode-specific instruction: ${preset.instruction}` : null,
    "Response priorities:",
    "- Solve the user's actual request, not a generic adjacent task.",
    "- Keep unrelated churn low and prefer the smallest safe change.",
    "- If some detail is missing, make the smallest safe assumption and mention it briefly in the final text.",
    "",
    "User task:",
    userText,
  ].filter(Boolean).join("\n");
}

function isUsableModel(model) {
  return typeof model === "string" && model.trim().length > 0;
}

function compactJobStatus(status) {
  return JOB_STATUS_LABELS[status] || status;
}

function mainKeyboard() {
  return new Keyboard().text("⚡ Меню").text("📊 Статус").row().text("❓ Помощь").text("💫 Новый чат").resized();
}

function dashboardKeyboard(hasActiveDevice) {
  const keyboard = new InlineKeyboard()
    .text("🔵 Сводка", "action:status")
    .text("🔵 Устройства", "action:devices")
    .row()
    .text("🟢 Задачи", "action:jobs")
    .text("⚡ Подключить ПК", "action:pair")
    .row()
    .text("💫 Новая сессия", "action:new");

  if (hasActiveDevice) {
    keyboard.row().text("📁 Активный проект", "action:project");
  }

  return keyboard;
}

function presetKeyboard(currentPreset) {
  const keyboard = new InlineKeyboard();
  for (const [presetId, preset] of Object.entries(PRESETS)) {
    const active = presetId === currentPreset ? "• " : "";
    keyboard.text(`${active}${preset.emoji} ${preset.title}`, `preset:${presetId}`).row();
  }
  return keyboard.text("↩️ Dashboard", "action:start");
}

function deviceKeyboard(devices, activeDeviceId) {
  const keyboard = new InlineKeyboard();
  for (const device of devices) {
    const active = device.id === activeDeviceId ? "• " : "";
    keyboard.text(`${active}${truncate(device.name, 22)}`, `device:use:${device.id}`).row();
  }
  keyboard.text("🔄 Refresh", "action:devices").text("➕ Pair", "action:pair");
  return keyboard;
}

function pendingJobKeyboard(jobId) {
  return new InlineKeyboard().text("🟢 Применить", `job:apply:${jobId}`).text("🔴 Отклонить", `job:reject:${jobId}`);
}

function appliedJobKeyboard(jobId, transactionId) {
  const keyboard = new InlineKeyboard();
  if (transactionId) keyboard.text("↩️ Отменить", `job:undo:${jobId}`);
  return keyboard.text("🧾 К задачам", "action:jobs");
}

function formatPreview(lines, targetLabel) {
  return ["<b>Change Preview</b>", targetLabel ? `Target: <code>${escapeHtml(targetLabel)}</code>` : null, ...lines.map((line) => `- <code>${escapeHtml(line)}</code>`)].filter(Boolean).join("\n");
}

function formatHealth(agentHealth) {
  if (!agentHealth || typeof agentHealth !== "object") return "ok";
  const parts = [];
  if (typeof agentHealth.ok === "boolean") parts.push(agentHealth.ok ? "ok" : "error");
  if (agentHealth.backend) parts.push(agentHealth.backend);
  if (agentHealth.version) parts.push(`v${agentHealth.version}`);
  if (agentHealth.error) parts.push(`err: ${agentHealth.error}`);
  return parts.length > 0 ? parts.join(" • ") : truncate(JSON.stringify(agentHealth), 120);
}

function formatJobs(jobs) {
  if (jobs.length === 0) {
    return ["<b>Jobs</b>", "Nothing yet.", "Send a coding task and I will generate a preview before apply."].join("\n");
  }

  const counts = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});

  const head = [
    "<b>Recent Jobs</b>",
    `Pending: <code>${(counts.pending || 0) + (counts.approved || 0) + (counts.running || 0)}</code>`,
    `Applied: <code>${counts.applied || 0}</code>`,
    `Failed: <code>${counts.failed || 0}</code>`,
    "",
  ];

  const body = jobs.slice(0, 8).map((job) => {
    const target = job.deviceName || job.deviceId || "local";
    const opCount = Array.isArray(job.operations) ? job.operations.length : 0;
    return `${compactJobStatus(job.status)} • <code>${escapeHtml(job.id.slice(0, 8))}</code> • <code>${escapeHtml(target)}</code> • ${escapeHtml(truncate(job.summary || job.text, 80))} • ${opCount} ops`;
  });

  return [...head, ...body].join("\n");
}

function formatDevices(devices, activeDeviceId) {
  if (devices.length === 0) {
    return ["<b>Пока нет подключенных ПК</b>", "1. Нажми <code>/pair</code>", "2. Запусти на ПК <code>start-companion.bat CODE</code>", "3. Сохрани токен и потом запусти companion как обычно"].join("\n");
  }

  return [
    "<b>Твои ПК</b>",
    ...devices.map((device) => {
      const active = device.id === activeDeviceId ? " • active" : "";
      return [`${device.status === "online" ? "🟢" : "⚪️"} <b>${escapeHtml(device.name)}</b>${active}`, `id: <code>${escapeHtml(device.id)}</code>`, `project: <code>${escapeHtml(device.projectRoot || "not set")}</code>`, `seen: <code>${escapeHtml(formatDateTime(device.lastSeenAt))}</code>`].join("\n");
    }),
  ].flat().join("\n\n");
}

function formatHelp() {
  return [
    "<b>Как работать с ботом</b>",
    "1. Пишешь задачу обычным текстом.",
    "2. Я покажу превью изменений и жду подтверждения.",
    "3. После подтверждения, я применю изменения на твой ПК.",
    "",
    "<b>Основные команды</b>",
    `<code>/pair</code> - подключить новый ПК`,
    `<code>/devices</code> - список и переключение ПК`,
    `<code>/project</code> - показать или сменить путь проекта`,
    `<code>/presets</code> - сменить рабочий режим`,
    `<code>/jobs</code> - показать задачи в работе`,
    `<code>/model deepseek-ai/deepseek-r1</code> - переопределить модель`,
  ].join("\n");
}

function formatStatus(session, agentHealth, activeDevice, devicesCount, jobs) {
  const preset = PRESETS[session.preset] || PRESETS.default;
  const pendingJobs = jobs.filter((job) => ["pending", "approved", "running"].includes(job.status)).length;
  return [
    `<b>${escapeHtml(config.botName)}</b>`,
    "Кодинг-ассистент для работы с кодом и файлами на твоём ПК.",
    "",
    `${preset.emoji} Режим: <code>${escapeHtml(preset.title)}</code>`,
    `🧠 Модель: <code>${escapeHtml(session.model || config.defaultModel || "not set")}</code>`,
    `🔌 Backend: <code>${escapeHtml(config.backend)}</code>`,
    `💻 ПК: <code>${escapeHtml(activeDevice ? activeDevice.name : "не выбран")}</code>`,
    `📱 Устройств: <code>${devicesCount}</code>`,
    `🧾 Задач в работе: <code>${pendingJobs}</code>`,
    `🕘 История: <code>${session.history.length}</code> сообщений`,
    `🛡 Health: <code>${escapeHtml(formatHealth(agentHealth))}</code>`,
  ].join("\n");
}

function formatProject(activeDevice) {
  if (!activeDevice) {
    return ["<b>Активный ПК не выбран</b>", "Открой <code>/devices</code> и выбери нужный ПК."].join("\n");
  }

  return ["<b>Текущий проект</b>", `PC: <code>${escapeHtml(activeDevice.name)}</code>`, `Device ID: <code>${escapeHtml(activeDevice.id)}</code>`, `Path: <code>${escapeHtml(activeDevice.projectRoot || "not set")}</code>`, `Сменить путь: <code>/project new/path</code>`].join("\n");
}

async function sendText(ctx, text, extra = {}) {
  for (const chunk of splitForTelegram(text)) {
    await ctx.reply(chunk.trim() ? chunk : "(empty answer)", extra);
  }
}

async function safeAnswerCallback(ctx, options = {}) {
  try {
    await ctx.answerCallbackQuery(options);
  } catch (error) {
    const message = String(error?.description || error?.message || "");
    if (/query is too old|query ID is invalid/i.test(message)) return;
    throw error;
  }
}

function formatThinkingStatus(model, preset, activeDevice, stage) {
  return [
    `<b>${escapeHtml(stage.title)}</b>`,
    `${escapeHtml(stage.emoji)} ${escapeHtml(stage.description)}`,
    `🧠 Модель: <code>${escapeHtml(model)}</code>`,
    `${preset.emoji} Режим: <code>${escapeHtml(preset.title)}</code>`,
    `💻 ПК: <code>${escapeHtml(activeDevice?.name || "не выбран")}</code>`,
  ].join("\n");
}

function createProgressTicker(ctx, messageId, model, preset, activeDevice) {
  const stages = [
    { title: "Анализ задачи", emoji: "⏳", description: "Принял задачу и запускаю обработку." },
    { title: "Думаю над решением", emoji: "🤔", description: "Анализирую код и контекст." },
    { title: "Готовлю изменения", emoji: "✍️", description: "Формирую правки и создаю файлы." },
    { title: "Почти готово", emoji: "🚀", description: "Завершаю работу над ответом." },
  ];

  let index = 0;
  const timer = setInterval(() => {
    index = (index + 1) % stages.length;
    ctx.api.editMessageText(ctx.chat.id, messageId, formatThinkingStatus(model, preset, activeDevice, stages[index]), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(activeDevice)),
    }).catch(() => {});
  }, 3500);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function formatUserFacingError(error) {
  const message = String(error?.message || error || "Неизвестная ошибка");
  if (/Model returned invalid JSON/i.test(message)) {
    return ["<b>Ошибка формата ответа</b>", "Модель вернула невалидный JSON.", "Попробуй еще раз или переключи модель на более стабильную, например <code>deepseek-ai/deepseek-r1</code>."] .join("\n");
  }
  if (/timed out/i.test(message)) {
    return ["<b>Превышено время ожидания</b>", "Модель слишком долго думает над ответом.", "Попробуй упростить задачу или переключиться на другую модель."] .join("\n");
  }
  if (/LLM API\s+4\d\d/i.test(message)) {
    return ["<b>Ошибка в запросе</b>", `<code>${escapeHtml(truncate(message, 220))}</code>`].join("\n");
  }
  if (/LLM API\s+5\d\d/i.test(message)) {
    return ["<b>Ошибка на стороне AI-провайдера</b>", "Сервис временно недоступен. Попробуй позже."].join("\n");
  }
  return `<b>Ошибка</b>\n<code>${escapeHtml(truncate(message, 300))}</code>`;
}

function shouldMarkJobFailedOnApply(error) {
  const message = String(error?.message || error || "");
  return !/Job not found|belongs to another user|No active PC|cannot be applied anymore/i.test(message);
}

function createAgentClient() {
  if (config.backend === "opencode") {
    return new OpenCodeAgentClient({
      baseUrl: config.opencodeServerUrl,
      username: config.opencodeServerUsername,
      password: config.opencodeServerPassword,
      workingDir: config.projectRoot,
      model: config.defaultModel,
      agent: config.opencodeAgent,
      port: config.opencodePort,
    });
  }

  return new OpenAICompatibleClient({
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: config.defaultModel,
    siteUrl: config.openaiSiteUrl,
    appName: config.openaiAppName,
    timeoutMs: config.openaiTimeoutMs,
    fileFlowEnabled: config.fileFlowEnabled,
    fileFlowMaxTokens: config.fileFlowMaxTokens,
  });
}

async function main() {
  validateBotConfig();

  const sessionStore = new SessionStore(config.sessionFile);
  const jobStore = new JobStore(config.jobsFile);
  const deviceStore = new DeviceStore(config.devicesFile);
  const executor = new LocalFileExecutor({ rootDir: config.projectRoot });
  const agentClient = createAgentClient();
  const apiServer = createApiServer({ config, deviceStore, jobStore });

  await Promise.all([sessionStore.load(), jobStore.load(), deviceStore.load()]);
  if (typeof agentClient.ensureReady === "function") await agentClient.ensureReady();
  await apiServer.start();

  const bot = new Bot(config.botToken);
  bot.catch((error) => console.error("Bot error:", error.error || error));

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !isAuthorized(userId)) {
      if (ctx.chat) await ctx.reply("Access denied.");
      return;
    }
    await next();
  });

  const userTaskQueue = new Map();

  function enqueueUserTask(userId, task) {
    const key = String(userId);
    const previous = userTaskQueue.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const tracked = current.finally(() => {
      if (userTaskQueue.get(key) === tracked) userTaskQueue.delete(key);
    });
    userTaskQueue.set(key, tracked);
    return tracked;
  }

  function getDevicesForUser(userId) {
    return deviceStore.listDevicesForUser(userId);
  }

  function getUserJobs(userId) {
    return jobStore.list().filter((job) => job.userId === userId);
  }

  function getActiveDevice(session, userId) {
    const devices = getDevicesForUser(userId);
    if (session.activeDeviceId) return devices.find((item) => item.id === session.activeDeviceId) || null;
    return devices.length === 1 ? devices[0] : null;
  }

  async function showDashboard(ctx, text) {
    const session = sessionStore.get(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);
    await ctx.reply(text || [`<b>${escapeHtml(config.botName)}</b>`, "Ассистент для работы с кодом и файлами на твоём ПК.", "Пиши задачи, получай изменения, управляй ими прямо здесь."].join("\n"), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(activeDevice)),
    });
  }

  async function showStatus(ctx) {
    const session = sessionStore.get(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);
    const health = await agentClient.health().catch((error) => ({ ok: false, error: error.message }));
    await ctx.reply(formatStatus(session, health, activeDevice, getDevicesForUser(ctx.from.id).length, getUserJobs(ctx.from.id)), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(activeDevice)),
    });
  }

  async function showDevices(ctx) {
    const session = sessionStore.get(ctx.from.id);
    const devices = getDevicesForUser(ctx.from.id);
    await ctx.reply(formatDevices(devices, session.activeDeviceId), {
      parse_mode: "HTML",
      reply_markup: devices.length > 0 ? deviceKeyboard(devices, session.activeDeviceId) : dashboardKeyboard(false),
    });
  }

  async function ensureOpenCodeSession(ctx) {
    if (!(agentClient instanceof OpenCodeAgentClient)) return "";
    const current = sessionStore.get(ctx.from.id);
    if (current.sessionId) return current.sessionId;
    const session = await agentClient.createSession(`Telegram ${ctx.from.id}`);
    await sessionStore.set(ctx.from.id, { sessionId: session.id, backend: "opencode" });
    return session.id;
  }

  async function createPendingJob(ctx, result) {
    if (!Array.isArray(result.operations) || result.operations.length === 0) return null;
    const previewLines = await executor.preview(result.operations);
    const session = sessionStore.get(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);
    const targetLabel = activeDevice?.projectRoot || config.projectRoot;
    const job = await jobStore.create({
      userId: ctx.from.id,
      status: "pending",
      summary: previewLines.join("; "),
      text: result.text,
      projectRoot: activeDevice?.projectRoot || config.projectRoot,
      deviceId: activeDevice?.id || "",
      deviceName: activeDevice?.name || "",
      operations: result.operations,
    });

    await ctx.reply(formatPreview(previewLines, targetLabel), { parse_mode: "HTML", reply_markup: pendingJobKeyboard(job.id) });
    return job;
  }

  async function applyInline(ctx, job) {
    const manifest = await executor.apply(job.operations);
    await jobStore.markApplied(job.id, manifest.transactionId);
    await sessionStore.set(ctx.from.id, { lastTransactionId: manifest.transactionId });
    await ctx.reply(["<b>Applied</b>", `Transaction: <code>${escapeHtml(manifest.transactionId)}</code>`, `Created: <code>${manifest.created.length}</code>`, `Backups: <code>${manifest.backups.length}</code>`].join("\n"), {
      parse_mode: "HTML",
      reply_markup: appliedJobKeyboard(job.id, manifest.transactionId),
    });
  }

  async function queueForDevice(ctx, job) {
    const session = sessionStore.get(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);
    if (!activeDevice) throw new Error("No active PC. Use /pair first, then /devices and choose one.");

    const approved = await jobStore.update(job.id, { status: "approved", deviceId: activeDevice.id, deviceName: activeDevice.name, projectRoot: activeDevice.projectRoot });
    await ctx.reply(["<b>Queued for PC</b>", `PC: <code>${escapeHtml(activeDevice.name)}</code>`, `Device ID: <code>${escapeHtml(activeDevice.id)}</code>`, `Project: <code>${escapeHtml(activeDevice.projectRoot || "not set")}</code>`, `Job: <code>${escapeHtml(approved.id)}</code>`].join("\n"), { parse_mode: "HTML" });
  }

  async function applyJob(ctx, job) {
    if (!job) throw new Error("Job not found.");
    if (job.userId !== ctx.from.id) throw new Error("This job belongs to another user.");
    if (!["pending", "approved"].includes(job.status)) throw new Error(`This job cannot be applied anymore. Status: ${job.status}`);
    if (config.applyMode === "companion") return queueForDevice(ctx, job);
    return applyInline(ctx, job);
  }

  async function undoJob(ctx, job) {
    if (!job?.transactionId) throw new Error("This job has no rollback transaction.");
    if (job.status === "undone") throw new Error("This job is already undone.");
    await executor.undo(job.transactionId);
    await jobStore.update(job.id, { status: "undone" });
    await sessionStore.set(ctx.from.id, { lastTransactionId: "" });
    await ctx.reply(`Rollback done: <code>${escapeHtml(job.transactionId)}</code>`, { parse_mode: "HTML" });
  }

  bot.command("start", async (ctx) => { await showDashboard(ctx); });
  bot.command("help", async (ctx) => { await ctx.reply(formatHelp(), { parse_mode: "HTML", reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))) }); });
  bot.command("new", async (ctx) => { await sessionStore.clearHistory(ctx.from.id); await ctx.reply("Новая сессия начата. История очищена.", { reply_markup: mainKeyboard() }); });
  bot.command("status", showStatus);
  bot.command("presets", async (ctx) => {
    const currentPreset = sessionStore.get(ctx.from.id).preset;
    const text = ["<b>Work Modes</b>", ...Object.entries(PRESETS).map(([id, preset]) => `${id === currentPreset ? "• " : ""}${preset.emoji} <b>${preset.title}</b> - ${escapeHtml(preset.description)}`)].join("\n");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: presetKeyboard(currentPreset) });
  });
  bot.command("preset", async (ctx) => {
    const presetId = parseCommandArgs(ctx.message.text || "");
    if (!PRESETS[presetId]) return ctx.reply("Unknown mode. Use /presets.");
    await sessionStore.set(ctx.from.id, { preset: presetId });
    await ctx.reply(`Режим переключен: ${PRESETS[presetId].emoji} ${PRESETS[presetId].title}`);
  });
  bot.command("model", async (ctx) => {
    const model = parseCommandArgs(ctx.message.text || "");
    await sessionStore.set(ctx.from.id, { model });
    await ctx.reply(model ? `Модель установлена: <code>${escapeHtml(model)}</code>` : `Сброшено к дефолту: <code>${escapeHtml(config.defaultModel)}</code>`, { parse_mode: "HTML" });
  });
  bot.command("pair", async (ctx) => {
    const code = await deviceStore.createPairingCode(ctx.from.id);
    await ctx.reply(["<b>Подключение ПК (старый способ)</b>", `1. Код: <code>${escapeHtml(code.code)}</code>`, `2. На ПК: <code>start-companion.bat ${escapeHtml(code.code)}</code>`, "3. Сохрани токен", "4. Добавь в <code>COMPANION_TOKEN</code>", `Срок: <code>${escapeHtml(formatDateTime(code.expiresAt))}</code>`].join("\n"), { parse_mode: "HTML", reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))) });
  });
  bot.command("devices", showDevices);
  bot.command("use", async (ctx) => {
    const deviceId = parseCommandArgs(ctx.message.text || "");
    const device = getDevicesForUser(ctx.from.id).find((item) => item.id === deviceId);
    if (!device) return ctx.reply("ПК не найден. Открой /devices.");
    await sessionStore.set(ctx.from.id, { activeDeviceId: device.id });
    await ctx.reply(`Выбран ПК: <code>${escapeHtml(device.name)}</code>`, { parse_mode: "HTML" });
  });
  bot.command("project", async (ctx) => {
    const args = parseCommandArgs(ctx.message.text || "");
    const session = sessionStore.get(ctx.from.id);
    const devices = getDevicesForUser(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);

    if (!args) {
      await ctx.reply(formatProject(activeDevice), { parse_mode: "HTML", reply_markup: dashboardKeyboard(Boolean(activeDevice)) });
      return;
    }

    let device = activeDevice;
    let projectRoot = args;
    const parts = args.split(/\s+/);
    const byId = devices.find((item) => item.id === parts[0]);
    if (byId && parts.length > 1) {
      device = byId;
      projectRoot = args.slice(parts[0].length).trim();
    }
    if (!device) return ctx.reply("Не выбран активный ПК. Сначала открой /devices и выбери один.");

    const updated = await deviceStore.updateDevice(device.id, { projectRoot });
    await sessionStore.set(ctx.from.id, { activeDeviceId: updated.id });
    await ctx.reply(`Путь проекта обновлен для <code>${escapeHtml(updated.name)}</code>: <code>${escapeHtml(updated.projectRoot)}</code>`, { parse_mode: "HTML" });
  });
  bot.command("jobs", async (ctx) => { await ctx.reply(formatJobs(getUserJobs(ctx.from.id)), { parse_mode: "HTML", reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))) }); });
  bot.command("undo", async (ctx) => {
    const session = sessionStore.get(ctx.from.id);
    if (!session.lastTransactionId) return ctx.reply("Нет задачи для отмены.");
    const job = getUserJobs(ctx.from.id).find((entry) => entry.transactionId === session.lastTransactionId);
    if (!job) return ctx.reply("Не удалось найти последнюю транзакцию.");
    await undoJob(ctx, job).catch((error) => ctx.reply(`Undo error: ${escapeHtml(error.message)}`, { parse_mode: "HTML" }));
  });

  bot.callbackQuery(/^action:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    await safeAnswerCallback(ctx);
    if (action === "start") return showDashboard(ctx);
    if (action === "status") return showStatus(ctx);
    if (action === "devices") return showDevices(ctx);
    if (action === "pair") {
      const code = await deviceStore.createPairingCode(ctx.from.id);
      await ctx.reply(["<b>Подключение ПК</b>", `Код: <code>${escapeHtml(code.code)}</code>`, `Запуск: <code>start-companion.bat ${escapeHtml(code.code)}</code>`].join("\n"), { parse_mode: "HTML" });
      return;
    }
    if (action === "jobs") return ctx.reply(formatJobs(getUserJobs(ctx.from.id)), { parse_mode: "HTML" });
    if (action === "new") {
      await sessionStore.clearHistory(ctx.from.id);
      await ctx.reply("Новая сессия начата.");
      return;
    }
    if (action === "project") return ctx.reply(formatProject(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id)), { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^preset:(.+)$/, async (ctx) => {
    const presetId = ctx.match[1];
    if (!PRESETS[presetId]) return safeAnswerCallback(ctx, { text: "Unknown mode" });
    await sessionStore.set(ctx.from.id, { preset: presetId });
    await safeAnswerCallback(ctx, { text: `${PRESETS[presetId].emoji} ${PRESETS[presetId].title}` });
    await ctx.reply(`Режим переключен: ${PRESETS[presetId].emoji} ${PRESETS[presetId].title}`);
  });

  bot.callbackQuery(/^device:use:(.+)$/, async (ctx) => {
    const deviceId = ctx.match[1];
    const device = getDevicesForUser(ctx.from.id).find((item) => item.id === deviceId);
    if (!device) return safeAnswerCallback(ctx, { text: "PC not found" });
    await sessionStore.set(ctx.from.id, { activeDeviceId: device.id });
    await safeAnswerCallback(ctx, { text: `Active: ${device.name}` });
    await ctx.reply(`Выбран ПК: <code>${escapeHtml(device.name)}</code>`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^job:apply:(.+)$/, async (ctx) => {
    await safeAnswerCallback(ctx, { text: config.applyMode === "companion" ? "Queueing to PC" : "Applying" });
    const job = jobStore.get(ctx.match[1]);
    await applyJob(ctx, job).catch(async (error) => {
      if (job && shouldMarkJobFailedOnApply(error)) await jobStore.markFailed(job.id, error.message);
      await ctx.reply(`Apply error: ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    });
  });

  bot.callbackQuery(/^job:reject:(.+)$/, async (ctx) => {
    const job = jobStore.get(ctx.match[1]);
    if (!job || job.userId !== ctx.from.id) return safeAnswerCallback(ctx, { text: "Job not found" });
    await jobStore.update(job.id, { status: "rejected" });
    await safeAnswerCallback(ctx, { text: "Rejected" });
    await ctx.reply("Preview rejected.");
  });

  bot.callbackQuery(/^job:undo:(.+)$/, async (ctx) => {
    const job = jobStore.get(ctx.match[1]);
    await safeAnswerCallback(ctx, { text: "Undoing" });
    await undoJob(ctx, job).catch((error) => ctx.reply(`Undo error: ${escapeHtml(error.message)}`, { parse_mode: "HTML" }));
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    if (userTaskQueue.has(String(ctx.from.id))) {
      await ctx.reply("Предыдущий запрос ещё в работе. Это сообщение поставил в очередь.");
    }

    await enqueueUserTask(ctx.from.id, async () => {
      const session = sessionStore.get(ctx.from.id);
      const model = isUsableModel(session.model) ? session.model : config.defaultModel;
      const activeDevice = getActiveDevice(session, ctx.from.id);
      const prompt = wrapPromptWithPreset(text, session.preset || "default", activeDevice);
      const preset = PRESETS[session.preset] || PRESETS.default;
      const statusMessage = await ctx.reply([`<b>Анализ задачи</b>`, `⏳ Принял задачу и запускаю обработку.`, `🧠 Модель: <code>${escapeHtml(model)}</code>`, `${preset.emoji} Режим: <code>${escapeHtml(preset.title)}</code>`, `💻 ПК: <code>${escapeHtml(activeDevice?.name || "не выбран")}</code>`].join("\n"), {
        parse_mode: "HTML",
        reply_markup: dashboardKeyboard(Boolean(activeDevice)),
      });
      const progressTicker = createProgressTicker(ctx, statusMessage.message_id, model, preset, activeDevice);

      try {
        const result = agentClient instanceof OpenCodeAgentClient
          ? await agentClient.sendTask(prompt, { sessionId: await ensureOpenCodeSession(ctx), model })
          : await agentClient.sendTask(prompt, { model, history: session.history });

        progressTicker.stop();
        await sessionStore.appendHistory(ctx.from.id, "user", text);
        await sessionStore.appendHistory(ctx.from.id, "assistant", result.text || "Prepared changes.");
        await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});

        if (result.text) await sendText(ctx, result.text, { reply_markup: mainKeyboard() });

        const job = await createPendingJob(ctx, result);
        if (!job && !result.text) await ctx.reply("Готово, но модель не вернула текстового ответа.");
      } catch (error) {
        progressTicker.stop();
        await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
        await ctx.reply(formatUserFacingError(error), { parse_mode: "HTML" });
      }
    });
  });

  process.once("SIGINT", async () => {
    await agentClient.stop?.();
    await apiServer.stop().catch(() => {});
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await agentClient.stop?.();
    await apiServer.stop().catch(() => {});
    process.exit(0);
  });

  console.log(`${config.botName} started`);
  console.log(`Backend: ${config.backend}`);
  console.log(`Apply mode: ${config.applyMode}`);
  console.log(`Project root: ${config.projectRoot}`);
  console.log(`API server: ${config.apiHost}:${config.apiPort}`);
  console.log(`Public URL: ${config.publicBaseUrl}`);

  await bot.api.setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "help", description: "Помощь и команды" },
    { command: "status", description: "Статус, модель, ПК" },
    { command: "presets", description: "Сменить режим работы" },
    { command: "pair", description: "Подключить ПК (старый способ)" },
    { command: "devices", description: "Список подключенных ПК" },
    { command: "project", description: "Текущий проект" },
    { command: "jobs", description: "Задачи и статусы" },
    { command: "undo", description: "Отменить последнее применение" },
  ]);

  await bot.start({ drop_pending_updates: false });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
