import http from "node:http";

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function unauthorized(response) {
  return json(response, 401, { error: "unauthorized" });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}

function pathParts(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  return { url, parts: url.pathname.split("/").filter(Boolean) };
}

function getBearerToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

export function createApiServer(deps) {
  const { config, deviceStore, jobStore } = deps;

  const server = http.createServer(async (request, response) => {
    try {
      const { url, parts } = pathParts(request.url || "/");

      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/pair/register") {
        const body = await readJson(request);
        const device = await deviceStore.registerDeviceFromCode(body.code || "", {
          deviceId: body.deviceId,
          name: body.name,
          projectRoot: body.projectRoot,
        });

        return json(response, 200, {
          ok: true,
          deviceId: device.id,
          token: device.token,
          userId: device.userId,
        });
      }

      if (parts[0] === "api" && parts[1] === "companion") {
        const token = getBearerToken(request);
        const device = deviceStore.getDeviceByToken(token);
        if (!device) {
          return unauthorized(response);
        }

        await deviceStore.touchDevice(device.id);

        if (request.method === "GET" && parts[2] === "jobs") {
          const jobs = jobStore.listForCompanion(device.id);
          return json(response, 200, {
            ok: true,
            device: {
              id: device.id,
              name: device.name,
              projectRoot: device.projectRoot,
            },
            jobs,
          });
        }

        if (request.method === "POST" && parts[2] === "jobs" && parts[3] && parts[4] === "claim") {
          const updated = await jobStore.claimForDevice(parts[3], device.id);
          if (!updated) {
            return json(response, 404, { error: "job_not_found" });
          }
          return json(response, 200, { ok: true, job: updated });
        }

        if (request.method === "POST" && parts[2] === "jobs" && parts[3] && parts[4] === "result") {
          const body = await readJson(request);
          const next = await jobStore.reportForDevice(parts[3], device.id, body);
          if (!next) {
            return json(response, 404, { error: "job_not_found" });
          }

          return json(response, 200, { ok: true, job: next });
        }

        if (request.method === "POST" && parts[2] === "device" && parts[3] === "heartbeat") {
          const body = await readJson(request);
          const updated = await deviceStore.touchDevice(device.id, {
            projectRoot: typeof body.projectRoot === "string" && body.projectRoot ? body.projectRoot : device.projectRoot,
            name: typeof body.name === "string" && body.name ? body.name : device.name,
          });
          return json(response, 200, { ok: true, device: updated });
        }
      }

      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error?.statusCode) {
        return json(response, error.statusCode, { error: error.message || String(error) });
      }
      return json(response, 500, { error: error.message || String(error) });
    }
  });

  return {
    async start() {
      await new Promise((resolve) => {
        server.listen(config.apiPort, config.apiHost, resolve);
      });
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
