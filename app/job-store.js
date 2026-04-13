import { randomUUID } from "node:crypto";
import { createWriteQueue, loadJsonFile, writeTextAtomic } from "./store-utils.js";

function normalizeJob(job) {
  return {
    id: typeof job.id === "string" ? job.id : randomUUID(),
    userId: Number.isFinite(job.userId) ? job.userId : 0,
    status: typeof job.status === "string" ? job.status : "pending",
    summary: typeof job.summary === "string" ? job.summary : "",
    text: typeof job.text === "string" ? job.text : "",
    projectRoot: typeof job.projectRoot === "string" ? job.projectRoot : "",
    deviceName: typeof job.deviceName === "string" ? job.deviceName : "",
    operations: Array.isArray(job.operations) ? job.operations : [],
    deviceId: typeof job.deviceId === "string" ? job.deviceId : "",
    transactionId: typeof job.transactionId === "string" ? job.transactionId : "",
    error: typeof job.error === "string" ? job.error : "",
    createdAt: typeof job.createdAt === "string" ? job.createdAt : new Date().toISOString(),
    updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : new Date().toISOString(),
  };
}

export class JobStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.jobs = [];
    this.enqueueWrite = createWriteQueue();
  }

  async load() {
    const { data, exists, recovered } = await loadJsonFile(this.filePath, []);
    this.jobs = Array.isArray(data) ? data.map(normalizeJob) : [];

    if (!exists || recovered) {
      await this.save();
    }
  }

  async save() {
    const snapshot = `${JSON.stringify(this.jobs, null, 2)}\n`;
    await this.enqueueWrite(() => writeTextAtomic(this.filePath, snapshot));
  }

  list() {
    return this.jobs.slice();
  }

  get(jobId) {
    return this.jobs.find((job) => job.id === jobId) || null;
  }

  async create(input) {
    const job = normalizeJob(input);
    this.jobs.unshift(job);
    await this.save();
    return job;
  }

  async update(jobId, patch) {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const next = normalizeJob({
      ...this.jobs[index],
      ...patch,
      id: jobId,
      updatedAt: new Date().toISOString(),
    });

    this.jobs[index] = next;
    await this.save();
    return next;
  }

  async approve(jobId, deviceId) {
    return this.update(jobId, {
      status: "approved",
      deviceId,
    });
  }

  async markRunning(jobId) {
    return this.update(jobId, { status: "running" });
  }

  async markApplied(jobId, transactionId) {
    return this.update(jobId, { status: "applied", transactionId, error: "" });
  }

  async markFailed(jobId, error) {
    return this.update(jobId, { status: "failed", error });
  }

  async claimForDevice(jobId, deviceId) {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      return null;
    }

    const current = this.jobs[index];
    if (current.deviceId !== deviceId || current.status !== "approved") {
      return null;
    }

    const next = normalizeJob({
      ...current,
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    this.jobs[index] = next;
    await this.save();
    return next;
  }

  async reportForDevice(jobId, deviceId, input) {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      return null;
    }

    const current = this.jobs[index];
    if (current.deviceId !== deviceId || !["approved", "running"].includes(current.status)) {
      return null;
    }

    const next = normalizeJob({
      ...current,
      status: input.status === "applied" ? "applied" : "failed",
      transactionId: input.status === "applied" ? input.transactionId || "" : "",
      error: input.status === "applied" ? "" : input.error || "unknown error",
      updatedAt: new Date().toISOString(),
    });

    this.jobs[index] = next;
    await this.save();
    return next;
  }

  listForCompanion(deviceId) {
    return this.jobs.filter((job) => job.status === "approved" && job.deviceId === deviceId);
  }
}
