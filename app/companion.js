import { config, validateCompanionConfig } from "./config.js";
import { LocalFileExecutor } from "./file-executor.js";

const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function describeError(error) {
  if (error?.name === "AbortError") {
    return "request timed out";
  }

  if (error?.cause?.code) {
    return `${error.message || error} (${error.cause.code})`;
  }

  return error.message || String(error);
}

function getCliPairCode() {
  const [, , maybeCommand, maybeCode] = process.argv;
  if (maybeCommand === "pair" && maybeCode) {
    return maybeCode.trim();
  }
  return "";
}

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

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Pair failed: ${response.status}`);
  }

  console.log("Pair success");
  console.log(`Device ID: ${payload.deviceId}`);
  console.log(`Token: ${payload.token}`);
  console.log("Save this token to COMPANION_TOKEN in .env on this PC.");
}

async function heartbeat() {
  const response = await fetchWithTimeout(`${config.companionServerUrl}/api/companion/device/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.companionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: config.companionName,
      projectRoot: config.projectRoot,
    }),
  });

  if (!response.ok) {
    throw new Error(`Heartbeat failed: ${response.status}`);
  }
}

async function fetchJobs() {
  const response = await fetchWithTimeout(`${config.companionServerUrl}/api/companion/jobs`, {
    headers: {
      Authorization: `Bearer ${config.companionToken}`,
    },
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Jobs request failed: ${response.status}`);
  }

  return payload.jobs || [];
}

async function claimJob(jobId) {
  const response = await fetchWithTimeout(`${config.companionServerUrl}/api/companion/jobs/${jobId}/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.companionToken}`,
    },
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Claim failed: ${response.status}`);
  }

  return payload.job;
}

async function reportResult(jobId, result) {
  await fetchWithTimeout(`${config.companionServerUrl}/api/companion/jobs/${jobId}/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.companionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(result),
  });
}

async function runRemoteCompanion() {
  if (!config.companionToken) {
    throw new Error("COMPANION_TOKEN is required. First run: node app/companion.js pair <CODE>");
  }

  console.log("Companion started");
  console.log(`Server: ${config.companionServerUrl}`);
  console.log(`Device: ${config.companionDeviceId}`);
  console.log(`Project root: ${config.projectRoot}`);

  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await heartbeat();
      const jobs = await fetchJobs();

      for (const job of jobs) {
        try {
          const claimed = await claimJob(job.id);
          const executor = new LocalFileExecutor({ rootDir: claimed.projectRoot || config.projectRoot });
          const manifest = await executor.apply(claimed.operations || []);
          await reportResult(claimed.id, {
            status: "applied",
            transactionId: manifest.transactionId,
          });
          console.log(`Applied job ${claimed.id} -> ${manifest.transactionId}`);
        } catch (error) {
          await reportResult(job.id, {
            status: "failed",
            error: error.message || String(error),
          }).catch(() => {});
          console.error(`Failed job ${job.id}: ${error.message || error}`);
        }
      }
    } catch (error) {
      console.error(`Companion network error: ${describeError(error)}`);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, config.companionPollMs);
}

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
