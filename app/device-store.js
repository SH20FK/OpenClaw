import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function generatePairCode() {
  return randomBytes(3).toString("hex").toUpperCase();
}

function generateDeviceToken() {
  return randomBytes(24).toString("hex");
}

function normalizeDevice(device) {
  return {
    id: typeof device.id === "string" ? device.id : randomUUID(),
    userId: Number.isFinite(device.userId) ? device.userId : 0,
    name: typeof device.name === "string" ? device.name : "PC",
    token: typeof device.token === "string" ? device.token : generateDeviceToken(),
    projectRoot: typeof device.projectRoot === "string" ? device.projectRoot : "",
    createdAt: typeof device.createdAt === "string" ? device.createdAt : new Date().toISOString(),
    updatedAt: typeof device.updatedAt === "string" ? device.updatedAt : new Date().toISOString(),
    lastSeenAt: typeof device.lastSeenAt === "string" ? device.lastSeenAt : "",
    status: typeof device.status === "string" ? device.status : "paired",
  };
}

function normalizePairingCode(item) {
  return {
    code: typeof item.code === "string" ? item.code : generatePairCode(),
    userId: Number.isFinite(item.userId) ? item.userId : 0,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

export class DeviceStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { devices: [], pairingCodes: [] };
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        devices: Array.isArray(parsed?.devices) ? parsed.devices.map(normalizeDevice) : [],
        pairingCodes: Array.isArray(parsed?.pairingCodes) ? parsed.pairingCodes.map(normalizePairingCode) : [],
      };
      await this.purgeExpiredCodes();
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this.save();
        return;
      }
      throw error;
    }
  }

  async save() {
    await writeJsonAtomic(this.filePath, this.state);
  }

  async purgeExpiredCodes() {
    const now = Date.now();
    const before = this.state.pairingCodes.length;
    this.state.pairingCodes = this.state.pairingCodes.filter((item) => new Date(item.expiresAt).getTime() > now);
    if (before !== this.state.pairingCodes.length) {
      await this.save();
    }
  }

  listDevicesForUser(userId) {
    return this.state.devices.filter((device) => device.userId === userId);
  }

  getDevice(deviceId) {
    return this.state.devices.find((device) => device.id === deviceId) || null;
  }

  getDeviceByToken(token) {
    return this.state.devices.find((device) => device.token === token) || null;
  }

  async createPairingCode(userId) {
    await this.purgeExpiredCodes();
    this.state.pairingCodes = this.state.pairingCodes.filter((item) => item.userId !== userId);
    const item = normalizePairingCode({ userId });
    this.state.pairingCodes.push(item);
    await this.save();
    return item;
  }

  async consumePairingCode(code) {
    await this.purgeExpiredCodes();
    const index = this.state.pairingCodes.findIndex((item) => item.code === code.trim().toUpperCase());
    if (index === -1) {
      return null;
    }
    const item = this.state.pairingCodes[index];
    this.state.pairingCodes.splice(index, 1);
    await this.save();
    return item;
  }

  async registerDeviceFromCode(code, input) {
    const pairing = await this.consumePairingCode(code);
    if (!pairing) {
      throw new Error("Pair code invalid or expired");
    }

    const existing = this.state.devices.find((device) => device.id === input.deviceId && device.userId === pairing.userId);
    const now = new Date().toISOString();

    const device = normalizeDevice({
      ...(existing || {}),
      id: typeof input.deviceId === "string" && input.deviceId ? input.deviceId : existing?.id,
      userId: pairing.userId,
      name: input.name || existing?.name || "PC",
      projectRoot: input.projectRoot || existing?.projectRoot || "",
      token: existing?.token || generateDeviceToken(),
      status: "online",
      lastSeenAt: now,
      updatedAt: now,
    });

    if (existing) {
      const index = this.state.devices.findIndex((item) => item.id === existing.id);
      this.state.devices[index] = device;
    } else {
      this.state.devices.push(device);
    }

    await this.save();
    return device;
  }

  async updateDevice(deviceId, patch) {
    const index = this.state.devices.findIndex((device) => device.id === deviceId);
    if (index === -1) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    const next = normalizeDevice({
      ...this.state.devices[index],
      ...patch,
      id: deviceId,
      updatedAt: new Date().toISOString(),
    });

    this.state.devices[index] = next;
    await this.save();
    return next;
  }

  async touchDevice(deviceId, patch = {}) {
    return this.updateDevice(deviceId, {
      ...patch,
      status: patch.status || "online",
      lastSeenAt: new Date().toISOString(),
    });
  }
}
