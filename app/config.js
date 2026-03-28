import "dotenv/config";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseAllowedUsers(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));
}

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function resolveDir(rawDir, fallback) {
  return ensureDir(path.resolve(rawDir || fallback));
}

const rootDir = process.cwd();
const dataDir = resolveDir(process.env.BOT_DATA_DIR, path.join(rootDir, "data"));
const projectRoot = resolveDir(process.env.PROJECT_ROOT, rootDir);

export const config = {
  botToken: process.env.TGBOT_API_KEY || "",
  allowedUsers: parseAllowedUsers(process.env.TGBOT_ALLOWED_USERS),
  botName: process.env.BOT_NAME || "Code Courier",
  rootDir,
  dataDir,
  projectRoot,
  sessionFile: path.resolve(dataDir, process.env.SESSION_FILE || "sessions.json"),
  jobsFile: path.resolve(dataDir, process.env.JOBS_FILE || "jobs.json"),
  devicesFile: path.resolve(dataDir, process.env.DEVICES_FILE || "devices.json"),
  applyMode: (process.env.APPLY_MODE || "inline").trim().toLowerCase(),
  backend: (process.env.AGENT_BACKEND || "openai").trim().toLowerCase(),
  defaultModel: process.env.AGENT_MODEL || process.env.OPENCODE_MODEL || "deepseek-ai/deepseek-r1",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  openaiApiKey: process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  openaiSiteUrl: process.env.OPENAI_SITE_URL || "",
  openaiAppName: process.env.OPENAI_APP_NAME || "",
  openaiTimeoutMs: Number.parseInt(process.env.OPENAI_TIMEOUT_MS || "120000", 10),
  fileFlowEnabled: (process.env.FILE_FLOW_ENABLED || "true").trim().toLowerCase() !== "false",
  fileFlowMaxTokens: Number.parseInt(process.env.FILE_FLOW_MAX_TOKENS || "6000", 10),
  opencodeServerUrl: (process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096").replace(/\/$/, ""),
  opencodeServerUsername: process.env.OPENCODE_SERVER_USERNAME || "opencode",
  opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD || "",
  opencodeAgent: process.env.OPENCODE_AGENT || "build",
  opencodePort: Number.parseInt(process.env.OPENCODE_PORT || "4096", 10),
  companionDeviceId: process.env.COMPANION_DEVICE_ID || os.hostname(),
  companionName: process.env.COMPANION_NAME || os.hostname(),
  companionPollMs: Number.parseInt(process.env.COMPANION_POLL_MS || "2000", 10),
  companionServerUrl: (process.env.COMPANION_SERVER_URL || "http://127.0.0.1:8787").replace(/\/$/, ""),
  companionToken: process.env.COMPANION_TOKEN || "",
  companionPairCode: process.env.COMPANION_PAIR_CODE || "",
  apiHost: process.env.API_HOST || "0.0.0.0",
  apiPort: Number.parseInt(process.env.API_PORT || "8787", 10),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, ""),
};

mkdirSync(path.dirname(config.sessionFile), { recursive: true });
mkdirSync(path.dirname(config.jobsFile), { recursive: true });
mkdirSync(path.dirname(config.devicesFile), { recursive: true });

function validateSharedConfig() {
  if (!config.companionServerUrl) {
    throw new Error("Missing COMPANION_SERVER_URL in .env");
  }

  if (!config.projectRoot) {
    throw new Error("Missing PROJECT_ROOT in .env");
  }

  if (!config.companionDeviceId) {
    throw new Error("Missing COMPANION_DEVICE_ID in .env");
  }

  if (!config.companionName) {
    throw new Error("Missing COMPANION_NAME in .env");
  }

  if (!config.publicBaseUrl) {
    throw new Error("Missing PUBLIC_BASE_URL in .env");
  }

  if (!config.apiHost) {
    throw new Error("Missing API_HOST in .env");
  }

  if (!Number.isFinite(config.apiPort)) {
    throw new Error("API_PORT must be a valid number");
  }

  if (!["inline", "companion"].includes(config.applyMode)) {
    throw new Error("APPLY_MODE must be 'inline' or 'companion'");
  }

}

export function validateConfig() {
  validateBotConfig();
  validateCompanionConfig();
}

export function validateBotConfig() {
  validateSharedConfig();

  if (!config.botToken) {
    throw new Error("Missing TGBOT_API_KEY in .env");
  }

  if (config.allowedUsers.length === 0) {
    throw new Error("TGBOT_ALLOWED_USERS is required for safety");
  }

  if (!["openai", "opencode"].includes(config.backend)) {
    throw new Error("AGENT_BACKEND must be 'openai' or 'opencode'");
  }

  if (config.backend === "openai" && !config.openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY (or OPENROUTER_API_KEY) for openai backend");
  }
}

export function validateCompanionConfig() {
  validateSharedConfig();
}

export function isAuthorized(userId) {
  return config.allowedUsers.includes(userId);
}
