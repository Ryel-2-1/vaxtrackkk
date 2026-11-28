import { EXPLORER_ENDPOINT, SCENARIOS, SIM_PROJECT } from "../../src/components/dev/explorerFixtures.js";
import {
  attachListeners, broadcast, EMULATOR_HOST, emulatorReady, labError, makeSession, readState, runAction, trace,
} from "./engine.mjs";

const roles = {
  admin: new Set(["stock", "temperature"]),
  dispatcher: new Set(["place", "seed", "optimize", "depart"]),
  rider: new Set(["tick", "offline", "detour", "accuracy", "checkIn", "complete"]),
};
const runIdPattern = /^[a-f0-9-]{36}$/;
const safeHost = /^(?:localhost|127\.0\.0\.1):5193$/;

function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw labError("Use a JSON request.");
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 8192) throw labError("The request is too large.");
  }
  const result = JSON.parse(body);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw labError("Use a JSON object.");
  return result;
}

function closeSession(session) {
  for (const stop of session.listeners.values()) stop();
  session.listeners.clear();
  for (const client of session.clients) client.end();
  session.clients.clear();
}

export function systemExplorerPlugin() {
  const sessions = new Map();
  const starting = new Set();
  return {
    name: "vaxtrack-system-explorer",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.on("close", () => {
        for (const session of sessions.values()) closeSession(session);
      });
      server.middlewares.use(EXPLORER_ENDPOINT, async (req, res) => {
        const { host, origin } = req.headers;
        if (!safeHost.test(host ?? "") || (origin && origin !== `http://${host}`) ||
            !["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(req.socket.remoteAddress)) {
          return reply(res, 403, { message: "This workspace is local." });
        }
        const url = new URL(req.url, `http://${host}`);
        if (req.method === "GET" && url.pathname === "/health") {
          const connected = await emulatorReady();
          return reply(res, 200, { connected, project: SIM_PROJECT, emulator: EMULATOR_HOST });
        }
        if (req.method === "GET" && url.pathname === "/events") {
          const session = sessions.get(url.searchParams.get("runId"));
          if (!session) return reply(res, 404, { message: "Start a lab session first." });
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          session.clients.add(res);
          res.write(`event: history\ndata: ${JSON.stringify(session.events)}\n\n`);
          broadcast(session);
          const ping = setInterval(() => res.write(": ping\n\n"), 15000);
          res.on("close", () => {
            session.clients.delete(res);
            clearInterval(ping);
          });
          return;
        }
        if (req.method !== "POST") return reply(res, 404, { message: "Unknown simulator endpoint." });
        if (!origin) return reply(res, 403, { message: "Open the local explorer page to run commands." });

        let session;
        let locked = false;
        try {
          const { runId, action, role, ...body } = await readBody(req);
          if (typeof runId !== "string" || !runIdPattern.test(runId)) throw labError("Invalid lab session.");
          session = sessions.get(runId);
          if (action === "init") {
            if (session) return reply(res, 200, readState(session));
            if (starting.has(runId)) throw labError("The lab is starting. Try again in a moment.");
            if (!Object.hasOwn(SCENARIOS, body.scenario)) throw labError("Choose a scenario.");
            starting.add(runId);
            try {
              if (!(await emulatorReady())) throw labError("Start the local Firestore emulator to run this lab.", "emulator-unavailable");
              if (sessions.size >= 12) {
                const old = [...sessions.values()].find((item) => !item.busy && item.clients.size === 0);
                if (!old) throw labError("Close an unused explorer tab and try again.");
                closeSession(old);
                sessions.delete(old.runId);
              }
              session = await makeSession(runId, body.scenario);
              sessions.set(runId, session);
              attachListeners(session);
            } finally {
              starting.delete(runId);
            }
          } else {
            if (!session) throw labError("Start a lab session first.");
            if (!Object.hasOwn(roles, role) || !roles[role].has(action)) throw labError("This role cannot run that action.");
            if (session.busy) throw labError("Let the current operation finish.");
            session.busy = locked = true;
            await runAction(session, action, body);
            broadcast(session);
          }
          return reply(res, 200, readState(session));
        } catch (error) {
          const allowed = typeof error?.code === "string" && !/^(?:[A-Z_]+|\d+)$/.test(error.code);
          const code = allowed ? error.code : "simulator-error";
          const message = allowed ? error.message : "The simulator command failed. Check that the Firestore emulator is running.";
          if (!allowed) server.config.logger.error(`[system-explorer] ${error?.message ?? error}`);
          if (session) trace(session, "http", "Command refused", { code, message });
          return reply(res, code === "emulator-unavailable" ? 503 : 400, { code, message });
        } finally {
          if (locked) session.busy = false;
        }
      });
    },
  };
}
