import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function ensureString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Operation field '${field}' must be a non-empty string`);
  }
  return value;
}

function toPosixRelative(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function copyPath(sourcePath, targetPath) {
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory()) {
    await mkdir(targetPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      await copyPath(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
    }
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, await readFile(sourcePath));
}

export class LocalFileExecutor {
  constructor(options) {
    this.rootDir = path.resolve(options.rootDir);
    this.backupDir = path.resolve(options.backupDir || path.join(this.rootDir, ".bot-backups"));
  }

  resolveInsideRoot(targetPath) {
    const normalized = ensureString(targetPath, "path").replaceAll("\\", "/");

    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error(`Absolute paths are not allowed: ${targetPath}`);
    }

    const resolved = path.resolve(this.rootDir, normalized);
    const relative = path.relative(this.rootDir, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes project root: ${targetPath}`);
    }

    return resolved;
  }

  normalizeOperation(operation) {
    if (!operation || typeof operation !== "object") {
      throw new Error("Operation must be an object");
    }

    const type = ensureString(operation.type, "type").trim().toLowerCase();

    if (type === "mkdir") {
      return {
        type,
        path: toPosixRelative(ensureString(operation.path, "path")),
      };
    }

    if (type === "write") {
      return {
        type,
        path: toPosixRelative(ensureString(operation.path, "path")),
        content: typeof operation.content === "string" ? operation.content : "",
      };
    }

    if (type === "rename") {
      return {
        type,
        from: toPosixRelative(ensureString(operation.from, "from")),
        to: toPosixRelative(ensureString(operation.to, "to")),
      };
    }

    if (type === "delete") {
      return {
        type,
        path: toPosixRelative(ensureString(operation.path, "path")),
      };
    }

    throw new Error(`Unsupported operation type: ${type}`);
  }

  async preview(operations) {
    const normalized = operations.map((operation) => this.normalizeOperation(operation));
    const lines = [];

    for (const operation of normalized) {
      if (operation.type === "mkdir") {
        lines.push(`mkdir ${operation.path}`);
        continue;
      }

      if (operation.type === "write") {
        const absolutePath = this.resolveInsideRoot(operation.path);
        const exists = await pathExists(absolutePath);
        const mode = exists ? "update" : "create";
        lines.push(`${mode} ${operation.path} (${operation.content.length} chars)`);
        continue;
      }

      if (operation.type === "rename") {
        lines.push(`rename ${operation.from} -> ${operation.to}`);
        continue;
      }

      if (operation.type === "delete") {
        lines.push(`delete ${operation.path}`);
      }
    }

    return lines;
  }

  async backupFile(absolutePath, relativePath, transactionDir, backups) {
    if (!(await pathExists(absolutePath))) {
      return;
    }

    const backupPath = path.join(transactionDir, relativePath);
    await copyPath(absolutePath, backupPath);
    backups.push(relativePath);
  }

  async apply(operations) {
    const normalized = operations.map((operation) => this.normalizeOperation(operation));
    const transactionId = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8);
    const transactionDir = path.join(this.backupDir, transactionId);
    const backups = [];
    const created = [];

    await mkdir(transactionDir, { recursive: true });

    try {
      for (const operation of normalized) {
        if (operation.type === "mkdir") {
          const targetPath = this.resolveInsideRoot(operation.path);
          await mkdir(targetPath, { recursive: true });
          continue;
        }

        if (operation.type === "write") {
          const targetPath = this.resolveInsideRoot(operation.path);
          const relativePath = path.relative(this.rootDir, targetPath);
          const alreadyExists = await pathExists(targetPath);

          await mkdir(path.dirname(targetPath), { recursive: true });
          await this.backupFile(targetPath, relativePath, transactionDir, backups);

          const tempPath = `${targetPath}.tmp-${randomUUID().slice(0, 8)}`;
          await writeFile(tempPath, operation.content, "utf8");
          await rename(tempPath, targetPath);

          if (!alreadyExists) {
            created.push(relativePath);
          }
          continue;
        }

        if (operation.type === "rename") {
          const fromPath = this.resolveInsideRoot(operation.from);
          const toPath = this.resolveInsideRoot(operation.to);
          const fromRelative = path.relative(this.rootDir, fromPath);
          const toRelative = path.relative(this.rootDir, toPath);
          const toAlreadyExists = await pathExists(toPath);

          if (!(await pathExists(fromPath))) {
            throw new Error(`Cannot rename missing path: ${operation.from}`);
          }

          await this.backupFile(fromPath, fromRelative, transactionDir, backups);
          await this.backupFile(toPath, toRelative, transactionDir, backups);
          await mkdir(path.dirname(toPath), { recursive: true });
          await rename(fromPath, toPath);
          if (!toAlreadyExists) {
            created.push(toRelative);
          }
          continue;
        }

        if (operation.type === "delete") {
          const targetPath = this.resolveInsideRoot(operation.path);
          const relativePath = path.relative(this.rootDir, targetPath);
          if (!(await pathExists(targetPath))) {
            continue;
          }

          await this.backupFile(targetPath, relativePath, transactionDir, backups);
          await rm(targetPath, { recursive: true, force: true });
        }
      }

      const manifest = {
        transactionId,
        rootDir: this.rootDir,
        created,
        backups,
        operations: normalized,
        createdAt: new Date().toISOString(),
      };

      await writeFile(path.join(transactionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return manifest;
    } catch (error) {
      await this.undo(transactionId).catch(() => {});
      throw error;
    }
  }

  async undo(transactionId) {
    const transactionDir = path.join(this.backupDir, transactionId);
    const manifestPath = path.join(transactionDir, "manifest.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw);

    for (const relativePath of manifest.created || []) {
      const targetPath = this.resolveInsideRoot(relativePath);
      if (await pathExists(targetPath)) {
        await rm(targetPath, { recursive: true, force: true });
      }
    }

    for (const relativePath of manifest.backups || []) {
      const sourcePath = path.join(transactionDir, relativePath);
      const targetPath = this.resolveInsideRoot(relativePath);
      await copyPath(sourcePath, targetPath);
    }

    await unlink(manifestPath).catch(() => {});
    return manifest;
  }
}
