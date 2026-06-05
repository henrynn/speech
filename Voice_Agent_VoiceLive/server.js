import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const root = process.cwd();
const assistantRoot = join(root, "pc_assistant");
const pythonVenvPath = join(assistantRoot, ".venv", "Scripts", "python.exe");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const voiceLiveState = {
  process: null,
  status: "stopped",
  clients: new Set(),
  history: [],
  stdoutBuffer: "",
  stderrBuffer: "",
  stderrLines: []
};

const pendingCameraAnalysisRequests = new Map();

function createRequestId(prefix = "req") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function hasActiveCameraAnalysisClient() {
  return voiceLiveState.clients.size > 0;
}

function createCameraAnalysisRequest(payload = {}) {
  if (!hasActiveCameraAnalysisClient()) {
    throw new Error("No active browser client is connected for camera analysis.");
  }

  const requestId = createRequestId("camera");
  const timeoutMs = 30000;

  const promise = new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pendingCameraAnalysisRequests.delete(requestId);
      reject(new Error("Camera analysis request timed out."));
    }, timeoutMs);

    pendingCameraAnalysisRequests.set(requestId, {
      resolve,
      reject,
      timeoutHandle
    });
  });

  broadcastEvent("camera_analysis_requested", {
    requestId,
    ...payload
  });

  return promise;
}

function resolveCameraAnalysisRequest(requestId, payload) {
  const pending = pendingCameraAnalysisRequests.get(requestId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeoutHandle);
  pendingCameraAnalysisRequests.delete(requestId);
  pending.resolve(payload);
  return true;
}

function resolvePath(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = normalize(cleanPath).replace(/^([.][.][/\\])+/, "");
  return join(root, safePath);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function resolvePython() {
  try {
    await access(pythonVenvPath, fsConstants.F_OK);
    return pythonVenvPath;
  } catch {
    return "python";
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function createEvent(type, payload = {}) {
  return {
    type,
    timestamp: new Date().toISOString(),
    ...payload
  };
}

function rememberEvent(event) {
  voiceLiveState.history.push(event);
  while (voiceLiveState.history.length > 100) {
    voiceLiveState.history.shift();
  }
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcastRawEvent(event) {
  rememberEvent(event);
  for (const client of voiceLiveState.clients) {
    writeSse(client, event);
  }
}

function broadcastEvent(type, payload = {}) {
  const event = createEvent(type, payload);
  broadcastRawEvent(event);
}

function setVoiceLiveStatus(status, detail = "") {
  voiceLiveState.status = status;
  broadcastEvent("status", { status, detail });
}

function rememberAssistantStderr(line) {
  voiceLiveState.stderrLines.push(line);
  while (voiceLiveState.stderrLines.length > 200) {
    voiceLiveState.stderrLines.shift();
  }
}

function summarizeAssistantFailure() {
  const lines = voiceLiveState.stderrLines;
  if (!lines.length) {
    return "";
  }

  if (lines.some((line) => line.includes("Missing env: AZURE_VOICELIVE_ENDPOINT"))) {
    return "Missing AZURE_VOICELIVE_ENDPOINT.";
  }

  if (lines.some((line) => line.includes("DefaultAzureCredential failed to retrieve a token"))) {
    return "Azure authentication failed. Run az login or configure AZURE_CLIENT_ID, AZURE_TENANT_ID, and AZURE_CLIENT_SECRET.";
  }

  if (lines.some((line) => line.includes("Audio mode requires pyaudio"))) {
    return "Audio dependencies are missing. Install requirements-audio.txt in pc_assistant.";
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      !line.startsWith("Traceback") &&
      !line.startsWith("File ") &&
      !line.startsWith("raise ") &&
      !line.startsWith("During handling") &&
      !line.startsWith("Exception ignored in:") &&
      !line.startsWith("Request URL:") &&
      !line.startsWith("Request method:") &&
      !line.startsWith("Request headers:") &&
      !line.startsWith("No body was attached")
    ) {
      return line;
    }
  }

  return "";
}

async function runVolumeTool(action, value = "") {
  const python = await resolvePython();
  const script = [
    "import json, sys",
    "from pc_assistant.device.volume_windows import get_master_volume_state, set_master_volume_level, set_master_mute",
    "action = sys.argv[1] if len(sys.argv) > 1 else 'get'",
    "arg = sys.argv[2] if len(sys.argv) > 2 else ''",
    "if action == 'get':",
    "    state = get_master_volume_state()",
    "elif action == 'set_volume':",
    "    state = set_master_volume_level(int(arg))",
    "elif action == 'set_mute':",
    "    state = set_master_mute(arg.lower() == 'true')",
    "else:",
    "    raise RuntimeError('unsupported action')",
    "print(json.dumps({'level': state.level, 'muted': bool(state.muted)}))"
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", script, action, String(value)], {
      cwd: assistantRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(assistantRoot, "src"),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1"
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "volume tool failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Invalid tool output"));
      }
    });
  });
}

async function runWindowsActionTool(action) {
  const python = await resolvePython();
  const script = [
    "import json, sys",
    "from pc_assistant.device.windows_actions import perform_windows_action",
    "action = sys.argv[1] if len(sys.argv) > 1 else ''",
    "print(json.dumps(perform_windows_action(action), ensure_ascii=False))"
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", script, action], {
      cwd: assistantRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(assistantRoot, "src"),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1"
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "windows action failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Invalid tool output"));
      }
    });
  });
}

async function runCameraVisionTool(payload) {
  const python = await resolvePython();
  const script = [
    "import json, sys",
    "from pc_assistant.vision_inference import VisionInferenceError, analyze_camera_frame",
    "request = json.loads(sys.stdin.read())",
    "try:",
    "    images = request.get('imageDataUrls') or request.get('imageDataUrl', '')",
    "    result = analyze_camera_frame(images, request.get('prompt'))",
    "    print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))",
    "except VisionInferenceError as exc:",
    "    print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))",
    "    sys.exit(1)"
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", script], {
      cwd: assistantRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(assistantRoot, "src"),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1"
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stdout);
          reject(new Error(parsed.error || stderr.trim() || "camera analysis failed"));
          return;
        } catch {
          reject(new Error(stderr.trim() || "camera analysis failed"));
          return;
        }
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result);
      } catch {
        reject(new Error("Invalid camera analysis output"));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function parseAssistantStdout(chunk) {
  voiceLiveState.stdoutBuffer += chunk.toString();
  const lines = voiceLiveState.stdoutBuffer.split(/\r?\n/);
  voiceLiveState.stdoutBuffer = lines.pop() || "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      broadcastRawEvent({
        timestamp: new Date().toISOString(),
        ...event
      });
      if (event.type === "session_ready") {
        setVoiceLiveStatus("running", "Azure Voice Live assistant is ready.");
      }
    } catch {
      broadcastEvent("assistant_log", { level: "info", message: line });
    }
  }
}

function parseAssistantStderr(chunk) {
  voiceLiveState.stderrBuffer += chunk.toString();
  const lines = voiceLiveState.stderrBuffer.split(/\r?\n/);
  voiceLiveState.stderrBuffer = lines.pop() || "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    rememberAssistantStderr(line);
    broadcastEvent("assistant_log", { level: "error", message: line });
  }
}

async function startVoiceLiveAssistant() {
  if (voiceLiveState.process) {
    return { status: voiceLiveState.status };
  }

  const python = await resolvePython();
  voiceLiveState.stdoutBuffer = "";
  voiceLiveState.stderrBuffer = "";
  voiceLiveState.stderrLines = [];
  setVoiceLiveStatus("starting", "Starting Azure Voice Live assistant...");

  const child = spawn(python, ["-m", "pc_assistant.voice_live_assistant"], {
    cwd: assistantRoot,
    env: {
      ...process.env,
      PYTHONPATH: join(assistantRoot, "src"),
      PC_ASSISTANT_EVENT_STREAM: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
    }
  });

  voiceLiveState.process = child;

  child.stdout.on("data", parseAssistantStdout);
  child.stderr.on("data", parseAssistantStderr);

  child.on("error", (error) => {
    broadcastEvent("assistant_log", { level: "error", message: error.message });
    setVoiceLiveStatus("stopped", `Voice Live process failed: ${error.message}`);
    voiceLiveState.process = null;
  });

  child.on("close", (code, signal) => {
    if (voiceLiveState.stdoutBuffer.trim()) {
      parseAssistantStdout("\n");
    }
    if (voiceLiveState.stderrBuffer.trim()) {
      parseAssistantStderr("\n");
    }

    voiceLiveState.process = null;
    voiceLiveState.stdoutBuffer = "";
    voiceLiveState.stderrBuffer = "";
    const failureSummary = summarizeAssistantFailure();
    setVoiceLiveStatus(
      "stopped",
      `Voice Live assistant stopped${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.${failureSummary ? ` ${failureSummary}` : ""}`
    );
  });

  return { status: voiceLiveState.status };
}

function stopVoiceLiveAssistant() {
  if (!voiceLiveState.process) {
    return { status: voiceLiveState.status };
  }

  setVoiceLiveStatus("stopping", "Stopping Azure Voice Live assistant...");
  voiceLiveState.process.kill();
  return { status: voiceLiveState.status };
}

function handleVoiceLiveEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  res.write(": connected\n\n");
  voiceLiveState.clients.add(res);

  writeSse(res, createEvent("status", { status: voiceLiveState.status, detail: "Current assistant state." }));
  for (const event of voiceLiveState.history) {
    writeSse(res, event);
  }

  req.on("close", () => {
    voiceLiveState.clients.delete(res);
  });
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);

    if (requestUrl.pathname === "/api/volume" && req.method === "GET") {
      const state = await runVolumeTool("get");
      sendJson(res, 200, state);
      return;
    }

    if (requestUrl.pathname === "/api/volume" && req.method === "POST") {
      const body = await readJsonBody(req);
      const level = Number(body.level ?? 0);
      const safeLevel = Math.max(0, Math.min(100, Number.isFinite(level) ? level : 0));
      const state = await runVolumeTool("set_volume", safeLevel);
      sendJson(res, 200, state);
      return;
    }

    if (requestUrl.pathname === "/api/mute" && req.method === "POST") {
      const body = await readJsonBody(req);
      const muted = Boolean(body.muted);
      const state = await runVolumeTool("set_mute", muted);
      sendJson(res, 200, state);
      return;
    }

    if (requestUrl.pathname === "/api/windows/action" && req.method === "POST") {
      const body = await readJsonBody(req);
      const action = String(body.action || "").trim();
      if (!action) {
        sendJson(res, 400, { error: "Missing action" });
        return;
      }
      const result = await runWindowsActionTool(action);
      sendJson(res, 200, result);
      return;
    }

    if (requestUrl.pathname === "/api/camera/analyze" && req.method === "POST") {
      const body = await readJsonBody(req);
      const imageDataUrl = String(body.imageDataUrl || "");
      const imageDataUrls = Array.isArray(body.imageDataUrls)
        ? body.imageDataUrls.map((value) => String(value || "")).filter(Boolean)
        : [];
      const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
      if (!imageDataUrl && imageDataUrls.length === 0) {
        sendJson(res, 400, { error: "Missing imageDataUrl or imageDataUrls" });
        return;
      }
      const result = await runCameraVisionTool({ imageDataUrl, imageDataUrls, prompt });
      sendJson(res, 200, result);
      return;
    }

    if (requestUrl.pathname === "/api/camera/request-analysis" && req.method === "POST") {
      const body = await readJsonBody(req);
      const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
      const mode = typeof body.mode === "string" ? body.mode : "manual";
      const result = await createCameraAnalysisRequest({ prompt, mode });
      sendJson(res, 200, result);
      return;
    }

    if (requestUrl.pathname === "/api/camera/analysis-result" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "Missing requestId" });
        return;
      }

      const handled = resolveCameraAnalysisRequest(requestId, body);
      if (!handled) {
        sendJson(res, 404, { error: "Unknown or expired requestId" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === "/api/voicelive/status" && req.method === "GET") {
      sendJson(res, 200, { status: voiceLiveState.status, running: Boolean(voiceLiveState.process) });
      return;
    }

    if (requestUrl.pathname === "/api/voicelive/start" && req.method === "POST") {
      const payload = await startVoiceLiveAssistant();
      sendJson(res, 200, payload);
      return;
    }

    if (requestUrl.pathname === "/api/voicelive/stop" && req.method === "POST") {
      const payload = stopVoiceLiveAssistant();
      sendJson(res, 200, payload);
      return;
    }

    if (requestUrl.pathname === "/api/voicelive/events" && req.method === "GET") {
      handleVoiceLiveEvents(req, res);
      return;
    }

    const filePath = resolvePath(requestUrl.pathname);
    const data = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath)] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Not found";
    const status = requestUrlFromReq(req).pathname.startsWith("/api/") ? 500 : 404;
    if (status === 500) {
      sendJson(res, 500, { error: message });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

function requestUrlFromReq(req) {
  return new URL(req.url || "/", `http://${req.headers.host}`);
}

server.listen(PORT, () => {
  console.log(`Nebula assistant running at http://localhost:${PORT}`);
});
