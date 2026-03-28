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
  default: {
    title: "Universal",
    emoji: "🎯",
    instruction: "",
    description: "Balanced mode for normal coding tasks.",
  },
  bugfix: {
    title: "Bugfix",
    emoji: "🩹",
    instruction: "Act as a sharp debugging engineer. Find the root cause first, then return the smallest safe fix.",
    description: "Focus on root cause and minimal change.",
  },
  feature: {
    title: "Feature",
    emoji: "✨",
    instruction: "Implement the task as a new feature. Follow the current style and return precise file operations when edits are needed.",
    description: "Best for adding new behavior.",
  },
  refactor: {
    title: "Refactor",
    emoji: "🧼",
    instruction: "Improve structure and readability without changing external behavior.",
    description: "Cleanup without changing behavior.",
  },
  explain: {
    title: "Explain",
    emoji: "🧠",
    instruction: "Explain the code simply and clearly. Avoid file operations unless explicitly requested.",
    description: "Read and explain existing code.",
  },
  review: {
    title: "Review",
    emoji: "🔎",
    instruction: "Do a short engineering review. Call out risks, weaknesses, and the best next improvements.",
    description: "Project review and risk scan.",
  },
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
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(text, max = 500) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatDateTime(value) {
  if (!value) {
    return "never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function splitForTelegram(text, maxLength = 3500) {
  const chunks = [];
  let rest = String(text || "");

  while (rest.length > maxLength) {
    let splitAt = rest.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt).trimStart();
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks.length > 0 ? chunks : [""];
}

function parseCommandArgs(text) {
  const firstSpace = text.indexOf(" ");
  return firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
}

function wrapPromptWithPreset(userText, presetId) {
  const preset = PRESETS[presetId] || PRESETS.default;
  return preset.instruction ? [preset.instruction, "", `User task: ${userText}`].join("\n") : userText;
}

function isUsableModel(model) {
  return typeof model === "string" && model.trim().length > 0;
}

function compactJobStatus(status) {
  return JOB_STATUS_LABELS[status] || status;
}

function formatThinkingStatus(model, preset, activeDevice, stage) {
  return [
    `<b>${escapeHtml(stage.title)}</b>`,
    `${escapeHtml(stage.emoji)} ${escapeHtml(stage.description)}`,
    `🧠 Модель: <code>${escapeHtml(model)}</code>`,
    `${preset.emoji} Режим: <code>${escapeHtml(preset.title)}</code>`,
    `🧭 ПК: <code>${escapeHtml(activeDevice?.name || "не выбран")}</code>`,
  ].join("\n");
}

function createProgressTicker(ctx, messageId, model, preset, activeDevice) {
  const stages = [
    { title: "Готовлю ответ", emoji: "⏳", description: "Принял задачу и собираю контекст." },
    { title: "Думаю над решением", emoji: "🧠", description: "Продумываю структуру и шаги." },
    { title: "Собираю результат", emoji: "🛠", description: "Формирую ответ и изменения по файлам." },
    { title: "Почти готово", emoji: "🚀", description: "Проверяю итог перед отправкой." },
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
    stages,
  };
}

function mainKeyboard() {
  return new Keyboard()
    .text("/start")
    .text("/help")
    .text("/status")
    .row()
    .text("/presets")
    .text("/devices")
    .text("/jobs")
    .row()
    .text("/pair")
    .text("/connect")
    .text("/myid")
    .row()
    .text("/project")
    .text("/undo")
    .resized();
}

function dashboardKeyboard(hasActiveDevice) {
  const keyboard = new InlineKeyboard()
    .text("📊 Status", "action:status")
    .text("🎛 Presets", "action:presets")
    .row()
    .text("💻 Devices", "action:devices")
    .text("🧾 Jobs", "action:jobs")
    .row()
    .text("🔗 Pair PC", "action:pair")
    .text("🚀 Connect", "action:connect")
    .row()
    .text("🆕 New Chat", "action:new");

  if (hasActiveDevice) {
    keyboard.row().text("📁 Project", "action:project");
  }

  return keyboard;
}

function presetKeyboard(currentPreset) {
  const keyboard = new InlineKeyboard();
  for (const [presetId, preset] of Object.entries(PRESETS)) {
    const active = presetId === currentPreset ? "• " : "";
    keyboard.text(`${active}${preset.emoji} ${preset.title}`, `preset:${presetId}`).row();
  }
  return keyboard.text("⬅️ Dashboard", "action:start");
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
  return new InlineKeyboard()
    .text("✅ Apply", `job:apply:${jobId}`)
    .text("🚫 Reject", `job:reject:${jobId}`);
}

function appliedJobKeyboard(jobId, transactionId) {
  const keyboard = new InlineKeyboard();
  if (transactionId) {
    keyboard.text("↩️ Undo", `job:undo:${jobId}`);
  }
  return keyboard.text("🧾 Jobs", "action:jobs");
}

function formatPreview(lines, targetLabel) {
  return [
    "<b>Change Preview</b>",
    targetLabel ? `Target: <code>${escapeHtml(targetLabel)}</code>` : null,
    ...lines.map((line) => `- <code>${escapeHtml(line)}</code>`),
  ].filter(Boolean).join("\n");
}

function formatHealth(agentHealth) {
  if (!agentHealth || typeof agentHealth !== "object") {
    return "ok";
  }

  const parts = [];
  if (typeof agentHealth.ok === "boolean") {
    parts.push(agentHealth.ok ? "ok" : "error");
  }
  if (agentHealth.backend) {
    parts.push(agentHealth.backend);
  }
  if (agentHealth.version) {
    parts.push(`v${agentHealth.version}`);
  }
  if (agentHealth.error) {
    parts.push(`err: ${agentHealth.error}`);
  }
  return parts.length > 0 ? parts.join(" • ") : truncate(JSON.stringify(agentHealth), 120);
}

function formatStatus(session, agentHealth, activeDevice, devicesCount, jobs) {
  const preset = PRESETS[session.preset] || PRESETS.default;
  const pendingJobs = jobs.filter((job) => ["pending", "approved", "running"].includes(job.status)).length;
  return [
    `<b>${escapeHtml(config.botName)}</b>`,
    "Активная сводка по боту и текущей сессии.",
    "",
    `${preset.emoji} Режим: <code>${escapeHtml(preset.title)}</code>`,
    `🧠 Модель: <code>${escapeHtml(session.model || config.defaultModel || "not set")}</code>`,
    `🔌 Backend: <code>${escapeHtml(config.backend)}</code>`,
    `🧭 ПК: <code>${escapeHtml(activeDevice ? activeDevice.name : "не выбран")}</code>`,
    `💻 Устройств: <code>${devicesCount}</code>`,
    `🧾 Задач в работе: <code>${pendingJobs}</code>`,
    `🕘 История: <code>${session.history.length}</code> сообщений`,
    `🛡 Health: <code>${escapeHtml(formatHealth(agentHealth))}</code>`,
  ].join("\n");
}

function formatJobs(jobs) {
  if (jobs.length === 0) {
    return [
      "<b>Jobs</b>",
      "Nothing yet.",
      "Send a coding task and I will generate a preview before apply.",
    ].join("\n");
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
    return [
      "<b>Пока нет подключенных ПК</b>",
      "1. Нажми <code>/pair</code>",
      "2. Запусти на ПК <code>start-companion.bat CODE</code>",
      "3. Сохрани токен и потом запусти companion как обычно",
    ].join("\n");
  }

  return [
    "<b>Твои ПК</b>",
    ...devices.map((device) => {
      const active = device.id === activeDeviceId ? " • active" : "";
      return [
        `${device.status === "online" ? "🟢" : "⚪️"} <b>${escapeHtml(device.name)}</b>${active}`,
        `id: <code>${escapeHtml(device.id)}</code>`,
        `project: <code>${escapeHtml(device.projectRoot || "not set")}</code>`,
        `seen: <code>${escapeHtml(formatDateTime(device.lastSeenAt))}</code>`,
      ].join("\n");
    }),
  ].flat().join("\n\n");
}

function formatHelp() {
  return [
    "<b>Как работать с ботом</b>",
    "1. Пишешь задачу обычным текстом.",
    "2. Я собираю ответ и превью изменений.",
    "3. Ты подтверждаешь, и задача уходит на выбранный ПК.",
    "",
    "<b>Основные команды</b>",
    `<code>/pair</code> - подключить новый ПК`,
    `<code>/devices</code> - список и переключение ПК`,
    `<code>/project</code> - показать или сменить путь проекта`,
    `<code>/presets</code> - сменить рабочий режим`,
    `<code>/jobs</code> - недавние задачи и статусы`,
    `<code>/connect</code> - что скинуть новому пользователю`,
    `<code>/myid</code> - показать Telegram ID для whitelist`,
    `<code>/model deepseek-ai/deepseek-r1</code> - переопределить модель`,
  ].join("\n");
}

function formatConnectGuide() {
  return [
    "<b>Как подключить нового пользователя</b>",
    "1. Пользователь пишет боту <code>/myid</code> и присылает тебе свой Telegram ID.",
    "2. Ты добавляешь этот ID в <code>TGBOT_ALLOWED_USERS</code> на сервере бота.",
    `3. Скидываешь ему адрес сервера: <code>${escapeHtml(config.publicBaseUrl)}</code>`,
    "4. Скидываешь шаблон <code>companion.env.example</code> или только 3 значения: <code>PROJECT_ROOT</code>, <code>COMPANION_SERVER_URL</code>, <code>PUBLIC_BASE_URL</code>.",
    "5. В Telegram он жмет <code>/pair</code>, на своем ПК запускает <code>start-companion.bat CODE</code>, сохраняет выданный токен и потом стартует companion.",
    "",
    "<b>Важно не отправлять</b>",
    "- <code>TGBOT_API_KEY</code>",
    "- <code>OPENAI_API_KEY</code>",
    "- чужие <code>COMPANION_TOKEN</code>",
  ].join("\n");
}

function formatMyId(userId) {
  return [
    "<b>Твой Telegram ID</b>",
    `Скопируй и отправь админу: <code>${escapeHtml(userId)}</code>`,
    "После этого админ добавит тебя в whitelist через <code>TGBOT_ALLOWED_USERS</code>.",
  ].join("\n");
}

function formatProject(activeDevice) {
  if (!activeDevice) {
    return [
      "<b>Активный ПК не выбран</b>",
      "Сначала открой <code>/devices</code> и выбери нужный ПК.",
    ].join("\n");
  }

  return [
    "<b>Активный проект</b>",
    `PC: <code>${escapeHtml(activeDevice.name)}</code>`,
    `Device ID: <code>${escapeHtml(activeDevice.id)}</code>`,
    `Path: <code>${escapeHtml(activeDevice.projectRoot || "not set")}</code>`,
    `Сменить путь: <code>/project new/path</code>`,
  ].join("\n");
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
    if (/query is too old|query ID is invalid/i.test(message)) {
      return;
    }
    throw error;
  }
}

function formatUserFacingError(error) {
  const message = String(error?.message || error || "Неизвестная ошибка");

  if (/Model returned invalid JSON/i.test(message)) {
    return [
      "<b>Модель вернула битый ответ</b>",
      "Похоже, провайдер прислал незавершенный или неправильный JSON.",
      "Попробуй еще раз или переключи модель на более стабильную, например <code>deepseek-ai/deepseek-r1</code>.",
    ].join("\n");
  }

  if (/timed out/i.test(message)) {
    return [
      "<b>Модель отвечает слишком долго</b>",
      "Провайдер не успел вернуть результат вовремя.",
      "Попробуй повторить запрос позже или выбрать более быструю модель.",
    ].join("\n");
  }

  if (/LLM API\s+4\d\d/i.test(message)) {
    return [
      "<b>Провайдер отклонил запрос</b>",
      `<code>${escapeHtml(truncate(message, 220))}</code>`,
    ].join("\n");
  }

  if (/LLM API\s+5\d\d/i.test(message)) {
    return [
      "<b>Проблема на стороне AI-провайдера</b>",
      "Сервис модели сейчас отвечает с ошибкой. Попробуй позже.",
    ].join("\n");
  }

  return `<b>Ошибка</b>\n<code>${escapeHtml(truncate(message, 300))}</code>`;
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
  if (typeof agentClient.ensureReady === "function") {
    await agentClient.ensureReady();
  }
  await apiServer.start();

  const bot = new Bot(config.botToken);

  bot.catch((error) => {
    console.error("Bot error:", error.error || error);
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !isAuthorized(userId)) {
      if (ctx.chat) {
        await ctx.reply("Access denied.");
      }
      return;
    }
    await next();
  });

  function getDevicesForUser(userId) {
    return deviceStore.listDevicesForUser(userId);
  }

  function getUserJobs(userId) {
    return jobStore.list().filter((job) => job.userId === userId);
  }

  function getActiveDevice(session, userId) {
    const devices = getDevicesForUser(userId);
    if (session.activeDeviceId) {
      return devices.find((item) => item.id === session.activeDeviceId) || null;
    }
    return devices.length === 1 ? devices[0] : null;
  }

  async function showDashboard(ctx, text) {
    const session = sessionStore.get(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);
    await ctx.reply(
      text || [
        `<b>${escapeHtml(config.botName)}</b>`,
        "Телеграм-бот для кодовых задач с превью и безопасным применением на ПК.",
        "Пиши задачу, смотри изменения, потом отправляй их на свой компьютер.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: dashboardKeyboard(Boolean(activeDevice)),
      }
    );
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
    if (!(agentClient instanceof OpenCodeAgentClient)) {
      return "";
    }
    const current = sessionStore.get(ctx.from.id);
    if (current.sessionId) {
      return current.sessionId;
    }
    const session = await agentClient.createSession(`Telegram ${ctx.from.id}`);
    await sessionStore.set(ctx.from.id, { sessionId: session.id, backend: "opencode" });
    return session.id;
  }

  async function createPendingJob(ctx, result) {
    if (!Array.isArray(result.operations) || result.operations.length === 0) {
      return null;
    }

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

    await ctx.reply(formatPreview(previewLines, targetLabel), {
      parse_mode: "HTML",
      reply_markup: pendingJobKeyboard(job.id),
    });
    return job;
  }

  async function applyInline(ctx, job) {
    const manifest = await executor.apply(job.operations);
    await jobStore.markApplied(job.id, manifest.transactionId);
    await sessionStore.set(ctx.from.id, { lastTransactionId: manifest.transactionId });
    await ctx.reply([
      "<b>Applied</b>",
      `Transaction: <code>${escapeHtml(manifest.transactionId)}</code>`,
      `Created: <code>${manifest.created.length}</code>`,
      `Backups: <code>${manifest.backups.length}</code>`,
    ].join("\n"), {
      parse_mode: "HTML",
      reply_markup: appliedJobKeyboard(job.id, manifest.transactionId),
    });
  }

  async function queueForDevice(ctx, job) {
    const session = sessionStore.get(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);
    if (!activeDevice) {
      throw new Error("No active PC. Use /pair first, then /devices and choose one.");
    }

    const approved = await jobStore.update(job.id, {
      status: "approved",
      deviceId: activeDevice.id,
      deviceName: activeDevice.name,
      projectRoot: activeDevice.projectRoot,
    });

    await ctx.reply([
      "<b>Queued for PC</b>",
      `PC: <code>${escapeHtml(activeDevice.name)}</code>`,
      `Device ID: <code>${escapeHtml(activeDevice.id)}</code>`,
      `Project: <code>${escapeHtml(activeDevice.projectRoot || "not set")}</code>`,
      `Job: <code>${escapeHtml(approved.id)}</code>`,
    ].join("\n"), { parse_mode: "HTML" });
  }

  async function applyJob(ctx, job) {
    if (!job) {
      throw new Error("Job not found.");
    }
    if (job.userId !== ctx.from.id) {
      throw new Error("This job belongs to another user.");
    }
    if (!["pending", "approved"].includes(job.status)) {
      throw new Error(`This job cannot be applied anymore. Status: ${job.status}`);
    }
    if (config.applyMode === "companion") {
      return queueForDevice(ctx, job);
    }
    return applyInline(ctx, job);
  }

  async function undoJob(ctx, job) {
    if (!job?.transactionId) {
      throw new Error("This job has no rollback transaction.");
    }
    if (job.status === "undone") {
      throw new Error("This job is already undone.");
    }
    await executor.undo(job.transactionId);
    await jobStore.update(job.id, { status: "undone" });
    await sessionStore.set(ctx.from.id, { lastTransactionId: "" });
    await ctx.reply(`Rollback done: <code>${escapeHtml(job.transactionId)}</code>`, { parse_mode: "HTML" });
  }

  bot.command("start", async (ctx) => {
    await showDashboard(ctx);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(formatHelp(), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))),
    });
  });

  bot.command("new", async (ctx) => {
    await sessionStore.clearHistory(ctx.from.id);
    await ctx.reply("Новый диалог готов. Пришли следующую задачу.", { reply_markup: mainKeyboard() });
  });

  bot.command("status", showStatus);

  bot.command("presets", async (ctx) => {
    const currentPreset = sessionStore.get(ctx.from.id).preset;
    const text = [
      "<b>Work Modes</b>",
      ...Object.entries(PRESETS).map(([id, preset]) => `${id === currentPreset ? "• " : ""}${preset.emoji} <b>${preset.title}</b> - ${escapeHtml(preset.description)}`),
    ].join("\n");
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: presetKeyboard(currentPreset),
    });
  });

  bot.command("preset", async (ctx) => {
    const presetId = parseCommandArgs(ctx.message.text || "");
    if (!PRESETS[presetId]) {
      await ctx.reply("Unknown mode. Use /presets.");
      return;
    }
    await sessionStore.set(ctx.from.id, { preset: presetId });
    await ctx.reply(`Режим переключен: ${PRESETS[presetId].emoji} ${PRESETS[presetId].title}`);
  });

  bot.command("model", async (ctx) => {
    const model = parseCommandArgs(ctx.message.text || "");
    await sessionStore.set(ctx.from.id, { model });
    await ctx.reply(model ? `Модель переключена: <code>${escapeHtml(model)}</code>` : `Снова используется модель по умолчанию: <code>${escapeHtml(config.defaultModel)}</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("connect", async (ctx) => {
    await ctx.reply(formatConnectGuide(), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))),
    });
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(formatMyId(ctx.from.id), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))),
    });
  });

  bot.command("pair", async (ctx) => {
    const code = await deviceStore.createPairingCode(ctx.from.id);
    await ctx.reply([
      "<b>Подключение нового ПК</b>",
      `1. Код: <code>${escapeHtml(code.code)}</code>`,
      `2. На нужном ПК запусти: <code>start-companion.bat ${escapeHtml(code.code)}</code>`,
      "3. Сохрани токен, который покажет companion",
      "4. Впиши токен в <code>COMPANION_TOKEN</code> и запускай companion уже без кода",
      `Срок кода: <code>${escapeHtml(formatDateTime(code.expiresAt))}</code>`,
      `Сервер: <code>${escapeHtml(config.publicBaseUrl)}</code>`,
    ].join("\n"), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))),
    });
  });

  bot.command("devices", showDevices);

  bot.command("use", async (ctx) => {
    const deviceId = parseCommandArgs(ctx.message.text || "");
    const device = getDevicesForUser(ctx.from.id).find((item) => item.id === deviceId);
    if (!device) {
      await ctx.reply("ПК не найден. Открой /devices.");
      return;
    }
    await sessionStore.set(ctx.from.id, { activeDeviceId: device.id });
    await ctx.reply(`Активный ПК: <code>${escapeHtml(device.name)}</code>`, { parse_mode: "HTML" });
  });

  bot.command("project", async (ctx) => {
    const args = parseCommandArgs(ctx.message.text || "");
    const session = sessionStore.get(ctx.from.id);
    const devices = getDevicesForUser(ctx.from.id);
    const activeDevice = getActiveDevice(session, ctx.from.id);

    if (!args) {
      await ctx.reply(formatProject(activeDevice), {
        parse_mode: "HTML",
        reply_markup: dashboardKeyboard(Boolean(activeDevice)),
      });
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

    if (!device) {
      await ctx.reply("Не могу определить целевой ПК. Сначала выбери его через /devices.");
      return;
    }

    const updated = await deviceStore.updateDevice(device.id, { projectRoot });
    await sessionStore.set(ctx.from.id, { activeDeviceId: updated.id });
    await ctx.reply(`Путь проекта обновлен для <code>${escapeHtml(updated.name)}</code>: <code>${escapeHtml(updated.projectRoot)}</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("jobs", async (ctx) => {
    await ctx.reply(formatJobs(getUserJobs(ctx.from.id)), {
      parse_mode: "HTML",
      reply_markup: dashboardKeyboard(Boolean(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id))),
    });
  });

  bot.command("undo", async (ctx) => {
    const session = sessionStore.get(ctx.from.id);
    if (!session.lastTransactionId) {
      await ctx.reply("Пока нечего откатывать.");
      return;
    }
    const job = getUserJobs(ctx.from.id).find((entry) => entry.transactionId === session.lastTransactionId);
    if (!job) {
      await ctx.reply("Не удалось найти последнюю транзакцию.");
      return;
    }
    await undoJob(ctx, job).catch((error) => ctx.reply(`Undo error: ${escapeHtml(error.message)}`, { parse_mode: "HTML" }));
  });

  bot.callbackQuery(/^action:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    await safeAnswerCallback(ctx);

    if (action === "start") {
      await showDashboard(ctx);
      return;
    }
    if (action === "status") {
      await showStatus(ctx);
      return;
    }
    if (action === "presets") {
      const currentPreset = sessionStore.get(ctx.from.id).preset;
      const text = [
        "<b>Work Modes</b>",
        ...Object.entries(PRESETS).map(([id, preset]) => `${id === currentPreset ? "• " : ""}${preset.emoji} <b>${preset.title}</b> - ${escapeHtml(preset.description)}`),
      ].join("\n");
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: presetKeyboard(currentPreset),
      });
      return;
    }
    if (action === "devices") {
      await showDevices(ctx);
      return;
    }
    if (action === "pair") {
      const code = await deviceStore.createPairingCode(ctx.from.id);
      await ctx.reply([
        "<b>Подключение нового ПК</b>",
        `Код: <code>${escapeHtml(code.code)}</code>`,
        `Запуск на ПК: <code>start-companion.bat ${escapeHtml(code.code)}</code>`,
        `Сервер: <code>${escapeHtml(config.publicBaseUrl)}</code>`,
      ].join("\n"), { parse_mode: "HTML" });
      return;
    }
    if (action === "connect") {
      await ctx.reply(formatConnectGuide(), { parse_mode: "HTML" });
      return;
    }
    if (action === "jobs") {
      await ctx.reply(formatJobs(getUserJobs(ctx.from.id)), { parse_mode: "HTML" });
      return;
    }
    if (action === "new") {
      await sessionStore.clearHistory(ctx.from.id);
      await ctx.reply("Новый диалог готов.");
      return;
    }
    if (action === "project") {
      await ctx.reply(formatProject(getActiveDevice(sessionStore.get(ctx.from.id), ctx.from.id)), { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery(/^preset:(.+)$/, async (ctx) => {
    const presetId = ctx.match[1];
    if (!PRESETS[presetId]) {
      await safeAnswerCallback(ctx, { text: "Unknown mode" });
      return;
    }
    await sessionStore.set(ctx.from.id, { preset: presetId });
    await safeAnswerCallback(ctx, { text: `${PRESETS[presetId].emoji} ${PRESETS[presetId].title}` });
    await ctx.reply(`Режим переключен: ${PRESETS[presetId].emoji} ${PRESETS[presetId].title}`);
  });

  bot.callbackQuery(/^device:use:(.+)$/, async (ctx) => {
    const deviceId = ctx.match[1];
    const device = getDevicesForUser(ctx.from.id).find((item) => item.id === deviceId);
    if (!device) {
      await safeAnswerCallback(ctx, { text: "PC not found" });
      return;
    }
    await sessionStore.set(ctx.from.id, { activeDeviceId: device.id });
    await safeAnswerCallback(ctx, { text: `Active: ${device.name}` });
    await ctx.reply(`Активный ПК: <code>${escapeHtml(device.name)}</code>`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^job:apply:(.+)$/, async (ctx) => {
    await safeAnswerCallback(ctx, { text: config.applyMode === "companion" ? "Queueing to PC" : "Applying" });
    const job = jobStore.get(ctx.match[1]);
    await applyJob(ctx, job).catch(async (error) => {
      if (job) {
        await jobStore.markFailed(job.id, error.message);
      }
      await ctx.reply(`Apply error: ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    });
  });

  bot.callbackQuery(/^job:reject:(.+)$/, async (ctx) => {
    const job = jobStore.get(ctx.match[1]);
    if (!job || job.userId !== ctx.from.id) {
      await safeAnswerCallback(ctx, { text: "Job not found" });
      return;
    }
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
    if (!text || text.startsWith("/")) {
      return;
    }

    const session = sessionStore.get(ctx.from.id);
    const model = isUsableModel(session.model) ? session.model : config.defaultModel;
    const prompt = wrapPromptWithPreset(text, session.preset || "default");
    const activeDevice = getActiveDevice(session, ctx.from.id);
    const preset = PRESETS[session.preset] || PRESETS.default;
    const statusMessage = await ctx.reply(formatThinkingStatus(model, preset, activeDevice, {
      title: "Готовлю ответ",
      emoji: "⏳",
      description: "Принял задачу и запускаю обработку.",
    }), {
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

      if (result.text) {
        await sendText(ctx, result.text, { reply_markup: mainKeyboard() });
      }

      const job = await createPendingJob(ctx, result);

      if (!job && agentClient instanceof OpenCodeAgentClient) {
        const diff = await agentClient.getDiff(sessionStore.get(ctx.from.id).sessionId).catch(() => []);
        const changedFiles = [...new Set((diff || []).map((item) => item?.path || item?.file?.path).filter(Boolean))];
        if (changedFiles.length > 0) {
          await ctx.reply([
            "<b>Changed Files</b>",
            ...changedFiles.map((file) => `- <code>${escapeHtml(file)}</code>`),
          ].join("\n"), { parse_mode: "HTML" });
        }
      }

      if (!result.text && !job) {
        await ctx.reply("Готово, но модель не вернула текстовый ответ.");
      }
    } catch (error) {
      progressTicker.stop();
      await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
      await ctx.reply(formatUserFacingError(error), { parse_mode: "HTML" });
    }
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
    { command: "start", description: "dashboard and quick actions" },
    { command: "help", description: "how to use the bot" },
    { command: "status", description: "current model, PC, and health" },
    { command: "presets", description: "switch work mode" },
    { command: "pair", description: "connect a new PC" },
    { command: "connect", description: "onboarding for new users" },
    { command: "myid", description: "show telegram id" },
    { command: "devices", description: "show paired PCs" },
    { command: "project", description: "show or set active project" },
    { command: "jobs", description: "recent jobs and statuses" },
    { command: "undo", description: "undo latest inline apply" },
  ]);

  await bot.start({ drop_pending_updates: false });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
