const state = {
  pc: null,
  dc: null,
  audioEl: null,
  localStream: null,
  connected: false,
  micEnabled: false,
  realtimeVoice: 'alloy',
  transcriptBuffer: '',
  partialAssistantText: '',
  functionCalls: new Map(),
  weatherResult: null,
  newsResult: null,
  guideResult: null,
  pendingAssistantMessage: null
};

const toolDefinitions = [
  {
    type: 'function',
    name: 'weather_lookup',
    description: 'Look up current weather and today forecast for a city.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string', description: 'Target city, for example Beijing or Shanghai.' }
      },
      required: ['city']
    }
  },
  {
    type: 'function',
    name: 'news_lookup',
    description: 'Fetch current news headlines for a topic.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', description: 'News topic, for example AI, technology, finance, or games.' },
        limit: { type: 'number', description: 'Maximum number of news items.' }
      },
      required: ['topic']
    }
  },
  {
    type: 'function',
    name: 'game_guide_lookup',
    description: 'Search for game guide results and walkthrough snippets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        game: { type: 'string', description: 'Game name, for example Genshin Impact.' },
        topic: { type: 'string', description: 'What strategy or guide the user wants.' },
        limit: { type: 'number', description: 'Maximum number of search results.' }
      },
      required: ['topic']
    }
  }
];

const els = {
  appTitle: document.getElementById('app-title'),
  connectionStatus: document.getElementById('status-connection'),
  modelStatus: document.getElementById('status-model'),
  regionStatus: document.getElementById('status-region'),
  connectBtn: document.getElementById('connect-btn'),
  disconnectBtn: document.getElementById('disconnect-btn'),
  micBtn: document.getElementById('mic-btn'),
  sendBtn: document.getElementById('send-btn'),
  textInput: document.getElementById('text-input'),
  messages: document.getElementById('messages'),
  cards: document.getElementById('cards'),
  eventLog: document.getElementById('event-log'),
  wave: document.getElementById('wave'),
  messageTemplate: document.getElementById('message-template'),
  cardTemplate: document.getElementById('card-template')
};

boot().catch((error) => {
  addMessage('system', `Initialization failed: ${error.message}`);
});

els.connectBtn.addEventListener('click', () => runSafely(startSession));
els.disconnectBtn.addEventListener('click', () => runSafely(teardownSession));
els.micBtn.addEventListener('click', () => runSafely(toggleMicrophone));
els.sendBtn.addEventListener('click', () => runSafely(sendUserText));
els.textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendUserText();
  }
});
document.querySelectorAll('.prompt-pill').forEach((button) => {
  button.addEventListener('click', () => {
    els.textInput.value = button.dataset.prompt || '';
    sendUserText();
  });
});

async function boot() {
  const response = await fetch('/api/config');
  const config = await response.json();
  els.appTitle.textContent = config.appTitle;
  state.realtimeVoice = config.realtime?.voice || 'alloy';
  els.modelStatus.textContent = `Model: ${config.realtime.deployment || '--'}`;
  els.regionStatus.textContent = `Region: ${extractRegion(config.realtime.resource) || '--'}`;
  addMessage('system', 'Ready. Click “连接 Realtime” to start a live GPT Realtime 2.0 session.');
}

async function startSession() {
  if (state.connected) {
    return;
  }

  updateConnectionStatus('Connecting...');
  addMessage('system', 'Requesting ephemeral Azure Realtime token...');

  const tokenResponse = await fetch('/api/realtime/token');
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(tokenData.error || 'Failed to get token');
  }

  state.pc = new RTCPeerConnection();
  state.audioEl = document.createElement('audio');
  state.audioEl.autoplay = true;
  state.audioEl.style.display = 'none';
  document.body.appendChild(state.audioEl);

  state.pc.ontrack = (event) => {
    state.audioEl.srcObject = event.streams[0];
  };

  state.dc = state.pc.createDataChannel('oai-events');
  state.dc.addEventListener('open', handleDataChannelOpen);
  state.dc.addEventListener('message', handleRealtimeMessage);
  state.dc.addEventListener('close', () => {
    updateConnectionStatus('Disconnected');
    state.connected = false;
  });

  const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.localStream = localStream;
  localStream.getTracks().forEach((track) => {
    track.enabled = false;
    state.pc.addTrack(track, localStream);
  });

  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);

  const answerResponse = await fetch(tokenData.websocketUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.token}`,
      'Content-Type': 'application/sdp'
    },
    body: offer.sdp
  });

  const answerSdp = await answerResponse.text();
  if (!answerResponse.ok) {
    throw new Error(`Failed to establish WebRTC session: ${answerSdp}`);
  }

  await state.pc.setRemoteDescription({
    type: 'answer',
    sdp: answerSdp
  });

  state.connected = true;
  updateConnectionStatus('Connected');
  addMessage('system', 'Realtime session connected. You can type or start voice mode.');
}

function handleDataChannelOpen() {
  logEvent('Data channel opened');
  state.wave.classList.add('active');
  sendRealtimeEvent({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: [
        'You are a professional multilingual assistant.',
        'Use the provided tools for weather, news, and game-guide requests.',
        'When tool results include sources, cite them naturally.',
        'Keep answers concise and useful.'
      ].join(' '),
      output_modalities: ['audio', 'text'],
      audio: {
        output: {
          voice: state.realtimeVoice
        },
        input: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true
          }
        }
      },
      tools: toolDefinitions,
      tool_choice: 'auto'
    }
  });
}

async function toggleMicrophone() {
  if (!state.localStream) {
    await startSession();
  }

  state.micEnabled = !state.micEnabled;
  state.localStream?.getAudioTracks().forEach((track) => {
    track.enabled = state.micEnabled;
  });

  els.micBtn.textContent = state.micEnabled ? '停止语音' : '开始语音';
  addMessage('system', state.micEnabled ? 'Voice mode enabled.' : 'Voice mode paused.');
}

function sendUserText() {
  const text = els.textInput.value.trim();
  if (!text) {
    return;
  }

  if (!state.dc || state.dc.readyState !== 'open') {
    addMessage('system', 'Please connect Realtime first.');
    return;
  }

  addMessage('user', text);
  sendRealtimeEvent({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }]
    }
  });
  sendRealtimeEvent({ type: 'response.create' });
  els.textInput.value = '';
}

async function handleRealtimeMessage(event) {
  const payload = JSON.parse(event.data);
  logEvent(payload);

  switch (payload.type) {
    case 'session.created':
    case 'session.updated':
      break;
    case 'input_audio_buffer.speech_started':
      addMessage('system', 'Listening...');
      break;
    case 'input_audio_buffer.speech_stopped':
      addMessage('system', 'Processing voice input...');
      break;
    case 'response.output_text.delta':
      appendAssistantDelta(payload.delta || '');
      break;
    case 'response.output_text.done':
      finalizeAssistantMessage();
      break;
    case 'response.function_call_arguments.delta':
      accumulateFunctionArguments(payload);
      break;
    case 'response.function_call_arguments.done':
      accumulateFunctionArguments(payload);
      await fulfillFunctionCall(payload);
      break;
    case 'error':
      addMessage('system', `Realtime error: ${payload.error?.message || 'Unknown error'}`);
      break;
    default:
      break;
  }
}

function accumulateFunctionArguments(payload) {
  const key = payload.call_id || payload.item_id || payload.name;
  const current = state.functionCalls.get(key) || {
    callId: payload.call_id,
    name: payload.name,
    arguments: ''
  };
  current.callId = payload.call_id || current.callId;
  current.name = payload.name || current.name;
  current.arguments += payload.delta || payload.arguments || '';
  state.functionCalls.set(key, current);
}

async function fulfillFunctionCall(payload) {
  const key = payload.call_id || payload.item_id || payload.name;
  const call = state.functionCalls.get(key);
  if (!call) {
    return;
  }

  const args = safeParse(call.arguments);
  let result;
  if (call.name === 'weather_lookup') {
    result = await invokeTool('/api/tools/weather', args);
    state.weatherResult = result;
  } else if (call.name === 'news_lookup') {
    result = await invokeTool('/api/tools/news', args);
    state.newsResult = result;
  } else if (call.name === 'game_guide_lookup') {
    result = await invokeTool('/api/tools/game-guide', args);
    state.guideResult = result;
  } else {
    result = { error: `Unknown tool ${call.name}` };
  }

  renderCards();
  sendRealtimeEvent({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: call.callId,
      output: JSON.stringify(result)
    }
  });
  sendRealtimeEvent({ type: 'response.create' });
  state.functionCalls.delete(key);
}

async function invokeTool(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json();
  if (!response.ok) {
    return { error: data.error || 'Tool request failed', details: data.details || null };
  }
  return data;
}

function appendAssistantDelta(delta) {
  if (!delta) {
    return;
  }
  if (!state.pendingAssistantMessage) {
    state.pendingAssistantMessage = addMessage('assistant', delta);
    state.partialAssistantText = delta;
    return;
  }

  state.partialAssistantText += delta;
  state.pendingAssistantMessage.querySelector('.msg-body').textContent = state.partialAssistantText;
}

function finalizeAssistantMessage() {
  state.pendingAssistantMessage = null;
  state.partialAssistantText = '';
}

function addMessage(role, content) {
  const node = els.messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector('.msg-role').textContent = role;
  node.querySelector('.msg-body').textContent = content;
  els.messages.appendChild(node);
  els.messages.scrollTop = els.messages.scrollHeight;
  return node;
}

function renderCards() {
  els.cards.innerHTML = '';
  if (state.weatherResult) {
    renderCard({
      title: `${state.weatherResult.city} 天气`,
      meta: `${state.weatherResult.summary} · ${state.weatherResult.current?.temperatureC ?? '--'}°C`,
      body: [
        `今日：${state.weatherResult.today?.summary || state.weatherResult.summary}`,
        `体感：${state.weatherResult.current?.apparentTemperatureC ?? '--'}°C`,
        `降雨概率：${state.weatherResult.today?.precipitationProbabilityMax ?? '--'}%`,
        `来源：${state.weatherResult.source}`
      ].join('\n')
    });
  }

  if (state.newsResult) {
    renderCard({
      title: `${state.newsResult.topic} 新闻`,
      meta: `${state.newsResult.items?.length || 0} 条结果 · ${state.newsResult.source}`,
      body: formatList(state.newsResult.items, (item) => `${item.title}\n${item.source}\n${item.url}`)
    });
  }

  if (state.guideResult) {
    renderCard({
      title: '游戏攻略搜索',
      meta: `${state.guideResult.source} · ${state.guideResult.query}`,
      body: formatList(state.guideResult.items, (item) => `${item.title}\n${item.source}\n${item.url}`)
    });
  }
}

function renderCard({ title, meta, body }) {
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector('.card-title').textContent = title;
  node.querySelector('.meta').textContent = meta;
  node.querySelector('.card-body').textContent = body;
  els.cards.appendChild(node);
}

function formatList(items, formatter) {
  if (!items?.length) {
    return 'No results';
  }
  return items.map((item, index) => `${index + 1}. ${formatter(item)}`).join('\n\n');
}

function logEvent(payload) {
  const line = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  els.eventLog.textContent = `${line}\n\n${els.eventLog.textContent}`.slice(0, 12000);
}

function updateConnectionStatus(text) {
  els.connectionStatus.textContent = text;
}

function sendRealtimeEvent(event) {
  state.dc?.send(JSON.stringify(event));
}

function extractRegion(resourceHost) {
  if (!resourceHost) {
    return '';
  }
  return resourceHost.split('.').slice(0, 1)[0];
}

function safeParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function teardownSession() {
  state.dc?.close();
  state.pc?.close();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.audioEl?.remove();
  state.pc = null;
  state.dc = null;
  state.localStream = null;
  state.audioEl = null;
  state.connected = false;
  state.micEnabled = false;
  els.micBtn.textContent = '开始语音';
  state.wave.classList.remove('active');
  updateConnectionStatus('Disconnected');
  addMessage('system', 'Realtime session closed.');
}

async function runSafely(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    addMessage('system', error.message || 'Unexpected error');
    updateConnectionStatus('Error');
  }
}
