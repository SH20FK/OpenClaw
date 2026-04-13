import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function cloneFallback(value) {
  if (typeof value === "function") {
    return value();
  }
  return JSON.parse(JSON.stringify(value));
}

export function createWriteQueue() {
  let tail = Promise.resolve();

  return (task) => {
    const run = tail.catch(() => {}).then(task);
    tail = run.catch(() => {});
    return run;
  };
}

export async function writeTextAtomic(filePath, text) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tempPath, text, "utf8");
  await rename(tempPath, filePath);
}

export async function loadJsonFile(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, "utf8");

    if (!raw.trim()) {
      return {
        data: cloneFallback(fallbackValue),
        recovered: true,
        exists: true,
      };
    }

    try {
      return {
        data: JSON.parse(raw),
        recovered: false,
        exists: true,
      };
    } catch (error) {
      const backupPath = `${filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await writeTextAtomic(backupPath, raw.endsWith("\n") ? raw : `${raw}\n`);
      console.error(`[Store] Corrupt JSON moved aside: ${backupPath}`);
      return {
        data: cloneFallback(fallbackValue),
        recovered: true,
        exists: true,
        error,
      };
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        data: cloneFallback(fallbackValue),
        recovered: false,
        exists: false,
      };
    }
    throw error;
  }
}
