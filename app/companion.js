import { config, validateCompanionConfig } from "./config.js";
import { LocalFileExecutor } from "./file-executor.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function describeError(error) {
  if (error?.name === "AbortError") return "request timed out";
  if (error?.cause?.code) return `${error.message || error} (${error.cause.code})`;
  return error?.message || String(error);
}

async function readJsonResponse(response, fallback = {}) {
  const raw = await response.text();
  if (!raw.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Server returned invalid JSON (${response.status})`);
  }
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

function createBackoff() {
  let delay = BACKOFF_BASE_MS;
  let consecutiveErrors = 0;

  return {
    success() {
      if (consecutiveErrors > 0) {
        console.log(`[Companion] Connection restored after ${consecutiveErrors} error(s).`);
      }
      consecutiveErrors = 0;
      delay = BACKOFF_BASE_MS;
    },
    failure() {
      consecutiveErrors++;
      const wait = Math.min(delay, BACKOFF_MAX_MS);
      delay = Math.min(delay * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      return wait;
    },
    consecutiveErrors() {
      return consecutiveErrors;
    },
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function getCliPairCode() {
  const [, , maybeCommand, maybeCode] = process.argv;
  if (maybeCommand === "pair" && maybeCode) return maybeCode.trim();
  return "";
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function registerDevice(pairCode) {
  const response = await fetchWithTimeout(`${config.companionServerUrl}/api/pair/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: pairCode,
      deviceId: config.companionDeviceId,
      name: config.companionName,
      projectRoot: config.projectRoot,
    }),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload.error || `Pair failed: ${response.status}`);

  console.log("Pair success");
  console.log(`Device ID : ${payload.deviceId}`);
  console.log(`Token     : ${payload.token}`);
  console.log("Save this token to COMPANION_TOKEN in .env on this PC.");
}

async function sendHeartbeat() {
  const response = await fetchWithTimeout(
    `${config.companionServerUrl}/api/companion/device/heartbeat`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.companionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: config.companionName,
        projectRoot: config.projectRoot,
      }),
    }
  );

  if (!response.ok) throw new Error(`Heartbeat failed: ${response.status}`);
}

async function fetchJobs() {
  const response = await fetchWithTimeout(`${config.companionServerUrl}/api/companion/jobs`, {
    headers: { Authorization: `Bearer ${config.companionToken}` },
  });

  const payload = await readJsonResponse(response, { jobs: [] });
  if (!response.ok) throw new Error(payload.error || `Jobs request failed: ${response.status}`);
  return payload.jobs || [];
}

async function claimJob(jobId) {
  const response = await fetchWithTimeout(
    `${config.companionServerUrl}/api/companion/jobs/${jobId}/claim`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.companionToken}` },
    }
  );

  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload.error || `Claim failed: ${response.status}`);
  return payload.job;
}

async function reportResult(jobId, result) {
  const response = await fetchWithTimeout(
    `${config.companionServerUrl}/api/companion/jobs/${jobId}/result`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.companionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result),
    }
  );

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload.error || `Result report failed: ${response.status}`);
  }
}

// ─── Job processing ───────────────────────────────────────────────────────────

async function processJob(job) {
  const claimed = await claimJob(job.id);
  const executor = new LocalFileExecutor({
    rootDir: claimed.projectRoot || config.projectRoot,
  });

  const manifest = await executor.apply(claimed.operations || []);

  await reportResult(claimed.id, {
    status: "applied",
    transactionId: manifest.transactionId,
  });

  const opCount = (claimed.operations || []).length;
  console.log(
    `[Companion] Applied job ${claimed.id.slice(0, 8)} — ` +
    `${opCount} op(s), tx ${manifest.transactionId}`
  );
}

async function processJobs(jobs) {
  for (const job of jobs) {
    try {
      await processJob(job);
    } catch (error) {
      if (/job_not_found/i.test(String(error?.message || ""))) {
        console.warn(`[Companion] Skipping stale job ${job.id.slice(0, 8)}.`);
        continue;
      }

      await reportResult(job.id, {
        status: "failed",
        error: error.message || String(error),
      }).catch(() => {});
      console.error(`[Companion] Job ${job.id.slice(0, 8)} failed: ${describeError(error)}`);
    }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runRemoteCompanion() {
  if (!config.companionToken) {
    throw new Error("COMPANION_TOKEN is required. First run: node app/companion.js pair <CODE>");
  }

  console.log("[Companion] Started");
  console.log(`[Companion] Server      : ${config.companionServerUrl}`);
  console.log(`[Companion] Device      : ${config.companionDeviceId}`);
  console.log(`[Companion] Project root: ${config.projectRoot}`);
  console.log(`[Companion] Poll interval: ${config.companionPollMs}ms`);

  const backoff = createBackoff();
  let running = false;
  let waitOverride = 0; // ms to sleep before next tick after a failure

  const tick = async () => {
    if (running) return; // guard against overlapping ticks
    running = true;

    try {
      await sendHeartbeat();
      const jobs = await fetchJobs();
      backoff.success();

      if (jobs.length > 0) {
        console.log(`[Companion] ${jobs.length} job(s) queued — processing…`);
        await processJobs(jobs);
      }

      waitOverride = 0;
    } catch (error) {
      const wait = backoff.failure();
      waitOverride = wait;
      console.error(`[Companion] Network error (retry in ${wait}ms): ${describeError(error)}`);
    } finally {
      running = false;
    }
  };

  // Initial tick immediately
  await tick();

  // Adaptive polling: use backoff delay when there are errors, normal poll otherwise
  const schedule = () => {
    const delay = waitOverride > 0 ? waitOverride : config.companionPollMs;
    waitOverride = 0;
    setTimeout(async () => {
      await tick();
      schedule();
    }, delay);
  };

  schedule();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  validateCompanionConfig();

  const pairCode = getCliPairCode() || config.companionPairCode;
  if (pairCode) {
    await registerDevice(pairCode);
    return;
  }

  await runRemoteCompanion();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
