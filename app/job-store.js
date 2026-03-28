import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

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
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.jobs = Array.isArray(parsed) ? parsed.map(normalizeJob) : [];
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this.save();
        return;
      }
      throw error;
    }
  }

  async save() {
    await writeJsonAtomic(this.filePath, this.jobs);
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

  listForCompanion(deviceId) {
    return this.jobs.filter((job) => job.status === "approved" && job.deviceId === deviceId);
  }
}
