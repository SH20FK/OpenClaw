import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      text: typeof item.text === "string" ? item.text : "",
    }))
    .filter((item) => item.text.trim())
    .slice(-20);
}

function normalizeSession(value) {
  if (typeof value === "string" && value) {
    return {
      sessionId: value,
      model: "",
      preset: "default",
      backend: "opencode",
      history: [],
      lastTransactionId: "",
      activeDeviceId: "",
    };
  }

  if (!value || typeof value !== "object") {
    return {
      sessionId: "",
      model: "",
      preset: "default",
      backend: "",
      history: [],
      lastTransactionId: "",
      activeDeviceId: "",
    };
  }

  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    model: typeof value.model === "string" ? value.model : "",
    preset: typeof value.preset === "string" ? value.preset : "default",
    backend: typeof value.backend === "string" ? value.backend : "",
    history: normalizeHistory(value.history),
    lastTransactionId: typeof value.lastTransactionId === "string" ? value.lastTransactionId : "",
    activeDeviceId: typeof value.activeDeviceId === "string" ? value.activeDeviceId : "",
  };
}

export class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = new Map();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      for (const [userId, value] of Object.entries(parsed)) {
        this.sessions.set(String(userId), normalizeSession(value));
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this.save();
        return;
      }
      throw error;
    }
  }

  async save() {
    await writeJsonAtomic(this.filePath, Object.fromEntries(this.sessions.entries()));
  }

  get(userId) {
    return this.sessions.get(String(userId)) || normalizeSession({});
  }

  async set(userId, patch) {
    const current = this.get(userId);
    this.sessions.set(String(userId), normalizeSession({ ...current, ...patch }));
    await this.save();
  }

  async delete(userId) {
    this.sessions.delete(String(userId));
    await this.save();
  }

  async appendHistory(userId, role, text) {
    const current = this.get(userId);
    const history = [...current.history, { role, text }].slice(-20);
    await this.set(userId, { history });
  }

  async clearHistory(userId) {
    await this.set(userId, { history: [], sessionId: "" });
  }
}
