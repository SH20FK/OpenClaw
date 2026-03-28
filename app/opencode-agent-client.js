import { AgentClient, normalizeAgentResult } from "./agent-client.js";
import { OpenCodeClient } from "./opencode-client.js";

export class OpenCodeAgentClient extends AgentClient {
  constructor(options) {
    super();
    this.client = new OpenCodeClient(options);
  }

  async health() {
    return this.client.getHealth();
  }

  async ensureReady() {
    await this.client.ensureServer();
  }

  async createSession(title) {
    return this.client.createSession(title);
  }

  async sendTask(task, options = {}) {
    const result = await this.client.sendMessage(options.sessionId, task, options.model || "");
    return normalizeAgentResult({
      text: result.text,
      operations: [],
      raw: result.raw,
      model: result.info?.modelID || options.model || null,
      usage: null,
    });
  }

  async getDiff(sessionId) {
    return this.client.getSessionDiff(sessionId);
  }

  async stop() {
    await this.client.stop();
  }
}
