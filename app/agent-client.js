export class AgentClient {
  async health() {
    throw new Error("Not implemented");
  }

  async sendTask(_task, _options = {}) {
    throw new Error("Not implemented");
  }
}

export function normalizeAgentResult(result) {
  return {
    text: typeof result?.text === "string" ? result.text : "",
    operations: Array.isArray(result?.operations) ? result.operations : [],
    raw: result?.raw ?? null,
    usage: result?.usage ?? null,
    model: result?.model ?? null,
  };
}
