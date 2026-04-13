import { createWriteQueue, loadJsonFile, writeTextAtomic } from "./store-utils.js";

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
    this.enqueueWrite = createWriteQueue();
  }

  async load() {
    const { data, exists, recovered } = await loadJsonFile(this.filePath, {});

    for (const [userId, value] of Object.entries(data || {})) {
      this.sessions.set(String(userId), normalizeSession(value));
    }

    if (!exists || recovered) {
      await this.save();
    }
  }

  async save() {
    const snapshot = `${JSON.stringify(Object.fromEntries(this.sessions.entries()), null, 2)}\n`;
    await this.enqueueWrite(() => writeTextAtomic(this.filePath, snapshot));
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
