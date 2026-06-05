const statusChipEl = document.getElementById("status-chip");
const assistantStateEl = document.getElementById("assistant-state");
const transcriptEl = document.getElementById("transcript");
const voiceMeterEl = document.getElementById("voice-meter");
const conversationStreamEl = document.getElementById("conversation-stream");
const voiceModeEl = document.getElementById("voice-mode");
const systemHealthEl = document.getElementById("system-health");
const logListEl = document.getElementById("log-list");
const diagnosticsPanelEl = document.getElementById("diagnostics-panel");

const listenBtn = document.getElementById("listen-btn");
const stopBtn = document.getElementById("stop-btn");
const refreshBtn = document.getElementById("refresh-btn");
const debugToggleBtn = document.getElementById("debug-toggle-btn");
const cameraPreviewEl = document.getElementById("camera-preview");
const cameraCanvasEl = document.getElementById("camera-canvas");
const cameraStatusEl = document.getElementById("camera-status");
const cameraAnalysisEl = document.getElementById("camera-analysis");
const cameraEmptyStateEl = document.getElementById("camera-empty-state");
const cameraStartBtn = document.getElementById("camera-start-btn");
const cameraStopBtn = document.getElementById("camera-stop-btn");
const cameraAnalyzeBtn = document.getElementById("camera-analyze-btn");
const cameraObserveBtn = document.getElementById("camera-observe-btn");
const cameraObserveIntervalEl = document.getElementById("camera-observe-interval");
const quickActionsBlockEl = document.getElementById("quick-actions-block");
const quickActionsToggleBtn = document.getElementById("quick-actions-toggle");
const quickActionsGridEl = document.getElementById("quick-actions-grid");
const windowsActionButtons = document.querySelectorAll("[data-windows-action]");

const appState = {
  eventSource: null,
  sessionStatus: "stopped",
  meterTimer: null,
  currentUserBubble: null,
  currentUserItemId: null,
  currentAssistantBubble: null,
  diagnosticsVisible: false,
  cameraStream: null,
  cameraReady: false,
  cameraAnalyzing: false,
  cameraObserving: false,
  cameraObserveTimer: null,
  cameraFrameCacheTimer: null,
  cameraFrameCache: [],
  lastCameraObservation: ""
};

const CAMERA_FRAME_CACHE_LIMIT = 10;
const CAMERA_FRAME_CAPTURE_INTERVAL_MS = 3000;

function stopBrowserSpeech() {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "Unknown error";
}

function addLog(message, level = "info") {
  if (!logListEl) {
    return;
  }

  const item = document.createElement("li");
  item.className = level;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logListEl.prepend(item);

  while (logListEl.children.length > 14) {
    logListEl.removeChild(logListEl.lastChild);
  }
}

function setDiagnosticsVisible(visible) {
  appState.diagnosticsVisible = visible;
  diagnosticsPanelEl.classList.toggle("is-hidden", !visible);
  debugToggleBtn.setAttribute("aria-expanded", visible ? "true" : "false");
  debugToggleBtn.textContent = visible ? "Hide Debug" : "Debug";
}

function setQuickActionsExpanded(expanded) {
  if (!quickActionsBlockEl || !quickActionsToggleBtn || !quickActionsGridEl) {
    return;
  }

  quickActionsBlockEl.classList.toggle("is-collapsed", !expanded);
  quickActionsToggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
  quickActionsGridEl.hidden = !expanded;
}

function setCameraStatus(text, { ready = appState.cameraReady } = {}) {
  cameraStatusEl.textContent = text;
  cameraPreviewEl.classList.toggle("is-active", ready);
  cameraEmptyStateEl.hidden = ready;
}

function getCameraObserveIntervalMs() {
  const seconds = Number(cameraObserveIntervalEl?.value || 5);
  return Math.max(2, Number.isFinite(seconds) ? seconds : 5) * 1000;
}

function setCameraObserveUi(observing) {
  appState.cameraObserving = observing;
  if (!cameraObserveBtn) {
    return;
  }

  cameraObserveBtn.textContent = observing ? "Stop Observe" : "Start Observe";
  cameraObserveBtn.classList.toggle("primary", observing);
}

function clearCameraObserveTimer() {
  if (appState.cameraObserveTimer) {
    window.clearTimeout(appState.cameraObserveTimer);
    appState.cameraObserveTimer = null;
  }
}

function clearCameraFrameCacheTimer() {
  if (appState.cameraFrameCacheTimer) {
    window.clearInterval(appState.cameraFrameCacheTimer);
    appState.cameraFrameCacheTimer = null;
  }
}

function clearCameraFrameCache() {
  appState.cameraFrameCache = [];
}

function stopCameraObservation({ silent = false } = {}) {
  clearCameraObserveTimer();
  const wasObserving = appState.cameraObserving;
  setCameraObserveUi(false);
  if (!silent && wasObserving) {
    addLog("Camera observation stopped.", "info");
  }
}

function stopCameraStream() {
  stopCameraObservation({ silent: true });
  clearCameraFrameCacheTimer();
  clearCameraFrameCache();
  appState.lastCameraObservation = "";

  if (!appState.cameraStream) {
    appState.cameraReady = false;
    if (cameraPreviewEl) {
      cameraPreviewEl.srcObject = null;
    }
    setCameraStatus("Camera idle", { ready: false });
    return;
  }

  for (const track of appState.cameraStream.getTracks()) {
    track.stop();
  }

  appState.cameraStream = null;
  appState.cameraReady = false;
  cameraPreviewEl.srcObject = null;
  setCameraStatus("Camera idle", { ready: false });
}

async function startCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support camera access.");
  }

  if (appState.cameraStream) {
    setCameraStatus("Camera live", { ready: true });
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  appState.cameraStream = stream;
  cameraPreviewEl.srcObject = stream;
  await cameraPreviewEl.play();
  appState.cameraReady = true;
  setCameraStatus("Camera live", { ready: true });
  startCameraFrameCaching();
}

function captureCameraFrame() {
  if (!appState.cameraReady || !cameraPreviewEl.videoWidth || !cameraPreviewEl.videoHeight) {
    throw new Error("Camera feed is not ready yet.");
  }

  const context = cameraCanvasEl.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  const maxWidth = 1152;
  const scale = Math.min(1, maxWidth / cameraPreviewEl.videoWidth);
  const width = Math.max(1, Math.round(cameraPreviewEl.videoWidth * scale));
  const height = Math.max(1, Math.round(cameraPreviewEl.videoHeight * scale));

  cameraCanvasEl.width = width;
  cameraCanvasEl.height = height;
  context.drawImage(cameraPreviewEl, 0, 0, width, height);
  return cameraCanvasEl.toDataURL("image/jpeg", 0.86);
}

function cacheCurrentCameraFrame() {
  const imageDataUrl = captureCameraFrame();
  appState.cameraFrameCache.push({
    imageDataUrl,
    capturedAt: Date.now()
  });

  if (appState.cameraFrameCache.length > CAMERA_FRAME_CACHE_LIMIT) {
    appState.cameraFrameCache.splice(0, appState.cameraFrameCache.length - CAMERA_FRAME_CACHE_LIMIT);
  }

  return imageDataUrl;
}

function startCameraFrameCaching() {
  clearCameraFrameCacheTimer();
  clearCameraFrameCache();

  const warmupCapture = () => {
    if (!appState.cameraReady || appState.cameraAnalyzing) {
      return;
    }

    try {
      cacheCurrentCameraFrame();
    } catch {
      // Ignore warmup/cache failures until the stream becomes ready.
    }
  };

  window.setTimeout(warmupCapture, 500);
  appState.cameraFrameCacheTimer = window.setInterval(warmupCapture, CAMERA_FRAME_CAPTURE_INTERVAL_MS);
}

function buildCameraPrompt({ mode = "manual" } = {}) {
  const basePrompt = "你会收到按时间顺序排列的最近三帧摄像头画面，其中最后一张是刚刚实时截取的当前画面，前两张只用于辅助判断动作变化。回答时必须优先描述最后一张当前画面里此刻正在看到的内容，不要把前两张里的旧内容当成当前状态。优先说清楚摄像头前的人、当前动作、当前状态、主要物体、场景位置，以及看得见的文字内容。";

  if (mode !== "observe") {
    return `${basePrompt} 如果画面模糊或无法判断，请直接说明不确定。`;
  }

  if (!appState.lastCameraObservation) {
    return `${basePrompt} 这是观察模式下的第一帧，请给出尽量具体的实时描述。`;
  }

  return [
    `${basePrompt} 这是自动观察模式下的新一帧。`,
    `上一帧结论：${appState.lastCameraObservation}`,
    "请重点指出这一刻和上一帧相比是否有变化，特别是人物动作、物体位置、屏幕内容或新出现的信息。",
    "如果基本没有变化，请先明确说“画面基本无变化”，再补一句当前场景。"
  ].join(" ");
}

async function analyzeCurrentCameraFrame({ mode = "manual", promptOverride = null } = {}) {
  const freshImageDataUrl = cacheCurrentCameraFrame();
  const recentCachedFrames = appState.cameraFrameCache.slice(-3);
  const earlierFrames = recentCachedFrames
    .filter((frame) => frame.imageDataUrl !== freshImageDataUrl)
    .slice(-2);
  const imageDataUrls = [...earlierFrames.map((frame) => frame.imageDataUrl), freshImageDataUrl];

  const result = await requestJson("/api/camera/analyze", "POST", {
    imageDataUrls,
    prompt: promptOverride || buildCameraPrompt({ mode })
  });
  return result;
}

async function handleCameraAnalysisRequestEvent(event) {
  const requestId = event.requestId || "";
  if (!requestId) {
    throw new Error("Missing camera analysis requestId.");
  }

  try {
    if (!appState.cameraReady) {
      await startCameraStream();
    }

    const result = await analyzeCurrentCameraFrame({
      mode: event.mode || "manual",
      promptOverride: typeof event.prompt === "string" ? event.prompt : null
    });

    appState.lastCameraObservation = result.description;
    cameraAnalysisEl.textContent = result.description;

    await requestJson("/api/camera/analysis-result", "POST", {
      requestId,
      ok: true,
      result
    });

    addLog(`Voice Live camera analysis returned for ${requestId}.`, "success");
  } catch (error) {
    await requestJson("/api/camera/analysis-result", "POST", {
      requestId,
      ok: false,
      error: formatError(error)
    });
    throw error;
  }
}

async function runCameraObservationCycle() {
  if (!appState.cameraObserving) {
    return;
  }

  if (appState.cameraAnalyzing) {
    appState.cameraObserveTimer = window.setTimeout(runCameraObservationCycle, 1000);
    return;
  }

  appState.cameraAnalyzing = true;
  setCameraStatus("Observing...", { ready: appState.cameraReady });
  try {
    const result = await analyzeCurrentCameraFrame({ mode: "observe" });
    const stamp = new Date().toLocaleTimeString();
    appState.lastCameraObservation = result.description;
    cameraAnalysisEl.textContent = `[${stamp}] ${result.description}`;
    addLog(`Observation updated via ${result.model}.`, "success");
  } catch (error) {
    stopCameraObservation({ silent: true });
    throw error;
  } finally {
    appState.cameraAnalyzing = false;
    setCameraStatus(appState.cameraReady ? "Camera live" : "Camera idle", { ready: appState.cameraReady });
  }

  if (appState.cameraObserving) {
    appState.cameraObserveTimer = window.setTimeout(runCameraObservationCycle, getCameraObserveIntervalMs());
  }
}

async function startCameraObservation() {
  await startCameraStream();
  if (appState.cameraObserving) {
    return;
  }

  setCameraObserveUi(true);
  addLog(`Camera observation started every ${getCameraObserveIntervalMs() / 1000} seconds.`, "info");
  cameraAnalysisEl.textContent = "Observation mode running. Waiting for the next frame analysis...";
  await runCameraObservationCycle();
}

function setCameraObserveIntervalSeconds(seconds) {
  if (!cameraObserveIntervalEl) {
    return;
  }

  const safeSeconds = String(Math.max(3, Math.min(12, Number(seconds) || 5)));
  const matchingOption = Array.from(cameraObserveIntervalEl.options).find((option) => option.value === safeSeconds);
  cameraObserveIntervalEl.value = matchingOption ? safeSeconds : "5";
}

async function handleCameraControlEvent(event) {
  const action = event.action || "";

  if (action === "open") {
    await startCameraStream();
    cameraAnalysisEl.textContent = "Camera opened from a voice command. Click Analyze Frame or ask to start observation.";
    addLog(event.detail || "Camera opened from Voice Live.", "success");
    return;
  }

  if (action === "observe_start") {
    setCameraObserveIntervalSeconds(event.interval_seconds);
    await startCameraObservation();
    addLog(event.detail || "Camera observation started from Voice Live.", "success");
    return;
  }

  if (action === "stop") {
    stopCameraStream();
    cameraAnalysisEl.textContent = "Camera stopped by voice command.";
    addLog(event.detail || "Camera stopped from Voice Live.", "info");
  }
}

function setAssistantState(text, mode = "idle") {
  assistantStateEl.textContent = text;
  statusChipEl.classList.toggle("listening", mode === "listening");
  statusChipEl.classList.toggle("idle", mode !== "listening");
  statusChipEl.textContent = mode === "listening" ? "Listening" : "Idle";
}

function setUiStatus({ assistantText, transcriptText = null, systemHealth = null, mode = "idle" }) {
  setAssistantState(assistantText, mode);
  if (transcriptText !== null) {
    transcriptEl.textContent = transcriptText;
  }
  if (systemHealth !== null) {
    systemHealthEl.textContent = systemHealth;
  }
}

function appendChat(role, text, { interim = false } = {}) {
  const line = document.createElement("div");
  line.className = `chat-line ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (interim) {
    bubble.classList.add("interim");
  }

  const speaker = document.createElement("span");
  speaker.className = "speaker";
  speaker.textContent = role === "user" ? "User" : "Azure Voice Live";

  const content = document.createElement("p");
  content.className = "bubble-copy";
  content.textContent = text;

  bubble.appendChild(speaker);
  bubble.appendChild(content);
  line.appendChild(bubble);
  conversationStreamEl.appendChild(line);
  conversationStreamEl.scrollTop = conversationStreamEl.scrollHeight;

  return content;
}

function ensureUserBubble(itemId) {
  if (!appState.currentUserBubble || appState.currentUserItemId !== itemId) {
    appState.currentUserBubble = appendChat("user", "", { interim: true });
    appState.currentUserItemId = itemId;
  }

  return appState.currentUserBubble;
}

function finalizeUserBubble(text, itemId) {
  const bubble = ensureUserBubble(itemId);
  bubble.textContent = text;
  bubble.parentElement.classList.remove("interim");
  appState.currentUserBubble = null;
  appState.currentUserItemId = null;
}

function ensureAssistantBubble() {
  if (!appState.currentAssistantBubble) {
    appState.currentAssistantBubble = appendChat("assistant", "", { interim: true });
  }
  return appState.currentAssistantBubble;
}

function finalizeAssistantBubble() {
  if (!appState.currentAssistantBubble) {
    return;
  }
  appState.currentAssistantBubble.parentElement.classList.remove("interim");
  appState.currentAssistantBubble = null;
}

function appendAssistantTranscriptDelta(text) {
  if (!text) {
    return;
  }

  const bubble = ensureAssistantBubble();
  bubble.textContent += text;
  conversationStreamEl.scrollTop = conversationStreamEl.scrollHeight;
}

function finalizeAssistantTranscript(text = "") {
  if (!appState.currentAssistantBubble && text) {
    appendChat("assistant", text);
    return;
  }

  if (text && appState.currentAssistantBubble) {
    appState.currentAssistantBubble.textContent = text;
  }

  finalizeAssistantBubble();
}

function startMeterAnimation() {
  window.clearInterval(appState.meterTimer);
  appState.meterTimer = window.setInterval(() => {
    const dynamic = 20 + Math.round(Math.random() * 74);
    voiceMeterEl.style.width = `${dynamic}%`;
  }, 180);
}

function stopMeterAnimation() {
  window.clearInterval(appState.meterTimer);
  voiceMeterEl.style.width = "10%";
}

function reportUiError(context, error) {
  const detail = formatError(error);
  addLog(`${context}: ${detail}`, "error");
  setUiStatus({
    assistantText: "An error occurred in the web console.",
    transcriptText: `${context}: ${detail}`,
    systemHealth: "Connected"
  });
}

function withLoggedAsync(context, handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      reportUiError(context, error);
    }
  };
}

async function requestJson(path, method = "GET", body = null) {
  addLog(`API ${method} ${path}`, "info");
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : null
  });

  if (!response.ok) {
    const text = await response.text();
    addLog(`API error ${method} ${path}: ${text || response.status}`, "error");
    throw new Error(text || `Request failed: ${response.status}`);
  }

  addLog(`API success ${method} ${path}`, "success");
  return response.json();
}

function updateVolumeUI(data) {
  void data;
}

async function refreshVolume({ announce = false } = {}) {
  const data = await requestJson("/api/volume");
  updateVolumeUI(data);
  addLog(`Volume synced: ${data.level}% · ${data.muted ? "muted" : "unmuted"}`, "success");
  if (announce) {
    appendChat("assistant", `Current volume is ${data.level} percent and the system is ${data.muted ? "muted" : "unmuted"}.`);
  }
}

async function setVolume(level) {
  const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
  const data = await requestJson("/api/volume", "POST", { level: safeLevel });
  updateVolumeUI(data);
  addLog(`Volume updated to ${data.level}%`, "success");
  appendChat("assistant", `Volume set to ${data.level} percent.`);
}

async function setMute(muted) {
  const data = await requestJson("/api/mute", "POST", { muted });
  updateVolumeUI(data);
  addLog(`Mute state updated: ${data.muted ? "muted" : "unmuted"}`, "success");
  appendChat("assistant", muted ? `System muted. Current volume is ${data.level} percent.` : `System unmuted. Current volume is ${data.level} percent.`);
}

function describeWindowsAction(action) {
  const descriptions = {
    open_calculator: "Open Calculator.",
    open_notepad: "Open Notepad.",
    open_explorer: "Open File Explorer.",
    open_settings: "Open Windows Settings.",
    show_desktop: "Show the desktop."
  };

  return descriptions[action] || "Run a Windows action.";
}

async function runWindowsAction(action) {
  const result = await requestJson("/api/windows/action", "POST", { action });
  addLog(`Windows action completed: ${result.detail}`, "success");
  appendChat("assistant", result.detail);
}

function updateSessionStatus(status, detail = "") {
  appState.sessionStatus = status;
  stopBrowserSpeech();

  if (status === "starting") {
    voiceModeEl.textContent = "Azure Voice Live";
    setUiStatus({
      assistantText: detail || "Starting Azure Voice Live assistant.",
      transcriptText: "Starting Azure Voice Live session...",
      systemHealth: "Connected"
    });
    return;
  }

  if (status === "running") {
    voiceModeEl.textContent = "Azure Voice Live";
    setUiStatus({
      assistantText: "Azure Voice Live is ready on the local Python assistant.",
      transcriptText: "Speak to the microphone connected to this PC.",
      systemHealth: "Connected"
    });
    return;
  }

  if (status === "stopping") {
    setUiStatus({
      assistantText: detail || "Stopping Azure Voice Live assistant.",
      transcriptText: "Stopping session...",
      systemHealth: "Connected"
    });
    return;
  }

  voiceModeEl.textContent = "Manual controls";
  stopMeterAnimation();
  setUiStatus({
    assistantText: detail || "Azure Voice Live session is stopped.",
    transcriptText: "Click Start Listening to launch the local Python Voice Live assistant.",
    systemHealth: "Connected"
  });
}

function handleAssistantEvent(event) {
  switch (event.type) {
    case "status":
      addLog(`Voice Live status: ${event.status}${event.detail ? ` · ${event.detail}` : ""}`, "info");
      updateSessionStatus(event.status, event.detail || "");
      break;
    case "session_ready":
      addLog(event.message || "Voice Live session ready.", "success");
      updateSessionStatus("running", event.message || "Voice Live session ready.");
      break;
    case "session_stopped":
      addLog(event.message || "Voice Live session stopped.", "warn");
      updateSessionStatus("stopped", event.message || "Voice Live session stopped.");
      break;
    case "speech_started":
      addLog("Azure Voice Live detected speech.", "info");
      setAssistantState("Listening through Azure Voice Live.", "listening");
      startMeterAnimation();
      break;
    case "speech_stopped":
      addLog("Azure Voice Live speech segment completed.", "info");
      stopMeterAnimation();
      setAssistantState("Processing speech with Azure Voice Live.");
      break;
    case "user_transcript_delta": {
      const bubble = ensureUserBubble(event.item_id || "user");
      bubble.textContent += event.text || "";
      transcriptEl.textContent = bubble.textContent || "Listening...";
      break;
    }
    case "user_transcript_done":
      finalizeUserBubble(event.text || "", event.item_id || "user");
      transcriptEl.textContent = event.text || "User speech captured.";
      addLog(`User said: ${event.text || ""}`, "success");
      break;
    case "user_transcript_failed":
      transcriptEl.textContent = event.error || "Input transcription failed.";
      addLog(`Input transcription failed: ${event.error || "Unknown error"}`, "error");
      break;
    case "response_created":
      stopBrowserSpeech();
      setAssistantState("Azure Voice Live is responding.");
      break;
    case "assistant_text_delta": {
      appendAssistantTranscriptDelta(event.text || "");
      break;
    }
    case "assistant_text_done":
      finalizeAssistantTranscript(event.text || "");
      setAssistantState("Azure Voice Live is ready on the local Python assistant.");
      break;
    case "assistant_audio_transcript_delta":
      appendAssistantTranscriptDelta(event.text || "");
      break;
    case "assistant_audio_transcript_done":
      if (event.text) {
        finalizeAssistantTranscript(event.text);
        addLog(`Assistant transcript: ${event.text}`, "info");
      } else {
        finalizeAssistantTranscript();
      }
      break;
    case "tool_call":
      addLog(`Tool call: ${event.name}`, "warn");
      break;
    case "tool_result":
      addLog(`Tool result ${event.name}: ${JSON.stringify(event.output)}`, event.output?.ok ? "success" : "error");
      break;
    case "camera_control":
      void handleCameraControlEvent(event).catch((error) => {
        reportUiError("Failed to handle camera control event", error);
      });
      break;
    case "camera_analysis_requested":
      void handleCameraAnalysisRequestEvent(event).catch((error) => {
        reportUiError("Failed to handle camera analysis request", error);
      });
      break;
    case "assistant_log":
      addLog(event.message || "Assistant log", event.level || "info");
      break;
    case "error":
      addLog(`Voice Live error: ${event.message || "Unknown error"}`, "error");
      setUiStatus({
        assistantText: "Azure Voice Live returned an error.",
        transcriptText: event.message || "Unknown error",
        systemHealth: "Connected"
      });
      break;
    case "response_done":
      setAssistantState("Azure Voice Live is ready on the local Python assistant.");
      break;
    default:
      addLog(`Unhandled event: ${event.type}`, "info");
  }
}

function connectVoiceLiveEvents() {
  if (appState.eventSource) {
    return;
  }

  const source = new EventSource("/api/voicelive/events");
  appState.eventSource = source;

  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      handleAssistantEvent(event);
    } catch (error) {
      reportUiError("Failed to parse Voice Live event", error);
    }
  };

  source.onerror = () => {
    addLog("Voice Live event stream disconnected. Retrying automatically.", "warn");
  };
}

listenBtn.addEventListener("click", withLoggedAsync("Failed to start Voice Live", async () => {
  addLog("Start Voice Live requested.", "info");
  await requestJson("/api/voicelive/start", "POST");
}));

stopBtn.addEventListener("click", withLoggedAsync("Failed to stop Voice Live", async () => {
  addLog("Stop Voice Live requested.", "info");
  await requestJson("/api/voicelive/stop", "POST");
}));

refreshBtn.addEventListener("click", withLoggedAsync("Manual refresh failed", async () => {
  addLog("Manual refresh requested.", "info");
  appendChat("user", "Refresh the current device state.");
  await refreshVolume({ announce: true });
}));

for (const button of windowsActionButtons) {
  button.addEventListener("click", withLoggedAsync("Windows action failed", async () => {
    const action = button.getAttribute("data-windows-action") || "";
    addLog(`Windows action requested: ${action}`, "info");
    appendChat("user", describeWindowsAction(action));
    await runWindowsAction(action);
  }));
}

cameraStartBtn?.addEventListener("click", withLoggedAsync("Failed to start camera", async () => {
  addLog("Camera start requested.", "info");
  await startCameraStream();
  cameraAnalysisEl.textContent = "Camera live. The browser is caching one frame every 3 seconds locally, up to 10 frames.";
}));

cameraStopBtn?.addEventListener("click", () => {
  stopCameraStream();
  cameraAnalysisEl.textContent = "Open the camera to start local frame caching, then analyze the latest three frames together.";
  addLog("Camera stopped.", "info");
});

cameraAnalyzeBtn?.addEventListener("click", withLoggedAsync("Failed to analyze camera frame", async () => {
  if (appState.cameraAnalyzing) {
    return;
  }

  appState.cameraAnalyzing = true;
  setCameraStatus("Analyzing frame...", { ready: appState.cameraReady });
  appendChat("user", "Analyze the current camera frame.");
  try {
    const result = await analyzeCurrentCameraFrame({ mode: "manual" });
    appState.lastCameraObservation = result.description;
    cameraAnalysisEl.textContent = result.description;
    appendChat("assistant", result.description);
    addLog(`Camera analysis complete via ${result.model}.`, "success");
  } finally {
    appState.cameraAnalyzing = false;
    setCameraStatus(appState.cameraReady ? "Camera live" : "Camera idle", { ready: appState.cameraReady });
  }
}));

cameraObserveBtn?.addEventListener("click", withLoggedAsync("Failed to toggle camera observation", async () => {
  if (appState.cameraObserving) {
    stopCameraObservation();
    cameraAnalysisEl.textContent = "Observation mode stopped. Capture a frame manually or start observing again.";
    return;
  }

  await startCameraObservation();
}));

debugToggleBtn.addEventListener("click", () => {
  setDiagnosticsVisible(!appState.diagnosticsVisible);
});

quickActionsToggleBtn?.addEventListener("click", () => {
  const expanded = quickActionsToggleBtn.getAttribute("aria-expanded") === "true";
  setQuickActionsExpanded(!expanded);
});

window.addEventListener("error", (event) => {
  reportUiError("Unhandled script error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  reportUiError("Unhandled promise rejection", event.reason);
});

window.addEventListener("beforeunload", () => {
  stopCameraStream();
});

connectVoiceLiveEvents();
setDiagnosticsVisible(false);
setQuickActionsExpanded(false);
setCameraObserveUi(false);
setCameraStatus("Camera idle", { ready: false });
void withLoggedAsync("Initial volume sync failed", async () => {
  await refreshVolume();
})();
void withLoggedAsync("Failed to load Voice Live status", async () => {
  const status = await requestJson("/api/voicelive/status");
  updateSessionStatus(status.status, status.running ? "Azure Voice Live is already running." : "Azure Voice Live is not running.");
})();
appendChat("assistant", "This web console now uses the local Python Azure Voice Live assistant. Click Start Listening to launch it on this PC.");
systemHealthEl.textContent = "Connected";
addLog("Frontend console ready.", "success");
