from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import queue
import math
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Union
from urllib import error, request
from urllib.parse import quote_plus

from azure.identity.aio import AzureCliCredential, ChainedTokenCredential, EnvironmentCredential

from pc_assistant.config import Settings, load_settings
from pc_assistant.device.windows_actions import (
    WindowsActionNotSupported,
    perform_windows_action,
)
from pc_assistant.device.volume_windows import (
    VolumeControlNotSupported,
    get_master_volume_state,
    set_master_mute,
    set_master_volume_level,
)

logger = logging.getLogger("pc_assistant.voicelive")


def build_token_credential() -> ChainedTokenCredential:
    cli_timeout = int(os.environ.get("PC_ASSISTANT_AZURE_CLI_TIMEOUT_SECONDS", "30"))
    return ChainedTokenCredential(
        EnvironmentCredential(),
        AzureCliCredential(process_timeout=cli_timeout),
    )


def _safe_json_loads(maybe_json: Union[str, Mapping[str, Any], None]) -> Dict[str, Any]:
    if maybe_json is None:
        return {}
    if isinstance(maybe_json, dict):
        return dict(maybe_json)
    if isinstance(maybe_json, str):
        try:
            parsed = json.loads(maybe_json)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _json_request(api_url: str, *, timeout: int = 20) -> Dict[str, Any]:
    http_request = request.Request(
        api_url,
        headers={
            "Accept": "application/json",
            "User-Agent": "NebulaPCAssistant/1.0",
        },
        method="GET",
    )

    try:
        with request.urlopen(http_request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"request failed: {exc.code} {detail}") from exc
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"request failed: {exc}") from exc


def _normalize_location(raw_location: str | None) -> str:
    location = (raw_location or "").strip()
    return location or "北京"


def _fetch_weather(location: str) -> Dict[str, Any]:
    normalized_location = _normalize_location(location)
    geocode_url = (
        "https://geocoding-api.open-meteo.com/v1/search"
        f"?name={quote_plus(normalized_location)}&count=1&language=zh&format=json"
    )
    geocode_payload = _json_request(geocode_url)
    results = geocode_payload.get("results") or []
    if not results:
        raise RuntimeError(f"未找到地点：{normalized_location}")

    matched = results[0]
    latitude = matched["latitude"]
    longitude = matched["longitude"]
    resolved_name = ", ".join(
        part for part in [matched.get("name"), matched.get("admin1"), matched.get("country")] if part
    )

    weather_url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={latitude}&longitude={longitude}"
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code"
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        "&timezone=auto&forecast_days=1"
    )
    weather_payload = _json_request(weather_url)
    current = weather_payload.get("current") or {}
    daily = weather_payload.get("daily") or {}

    return {
        "location": resolved_name,
        "temperature_c": current.get("temperature_2m"),
        "feels_like_c": current.get("apparent_temperature"),
        "humidity_percent": current.get("relative_humidity_2m"),
        "wind_speed_kmh": current.get("wind_speed_10m"),
        "weather_code": current.get("weather_code"),
        "weather_summary": _describe_weather_code(current.get("weather_code")),
        "today_high_c": (daily.get("temperature_2m_max") or [None])[0],
        "today_low_c": (daily.get("temperature_2m_min") or [None])[0],
        "precipitation_probability_percent": (daily.get("precipitation_probability_max") or [None])[0],
    }


def _describe_weather_code(code: Any) -> str:
    descriptions = {
        0: "晴朗",
        1: "基本晴朗",
        2: "部分多云",
        3: "阴天",
        45: "有雾",
        48: "有雾并伴有霜",
        51: "小毛毛雨",
        53: "毛毛雨",
        55: "强毛毛雨",
        61: "小雨",
        63: "中雨",
        65: "大雨",
        71: "小雪",
        73: "中雪",
        75: "大雪",
        80: "阵雨",
        81: "较强阵雨",
        82: "强阵雨",
        95: "雷暴",
        96: "雷暴伴小冰雹",
        99: "雷暴伴大冰雹",
    }
    return descriptions.get(code, "天气情况未知")


def _fetch_news(topic: str | None, limit: int) -> Dict[str, Any]:
    normalized_topic = (topic or "").strip()
    topic_for_query = normalized_topic or "technology OR world OR business"

    gdelt_url = (
        "https://api.gdeltproject.org/api/v2/doc/doc"
        f"?query={quote_plus(topic_for_query)}&mode=artlist&maxrecords={limit}&format=json&sort=datedesc"
    )
    try:
        payload = _json_request(gdelt_url, timeout=25)
        articles = payload.get("articles") or []
        if articles:
            return {
                "topic": normalized_topic or "头条",
                "feed_title": f"{normalized_topic or '今日'}新闻",
                "articles": [
                    {
                        "title": str(article.get("title") or "").strip(),
                        "source": str(article.get("domain") or article.get("sourcecountry") or "").strip(),
                        "published_at": str(article.get("seendate") or "").strip(),
                        "link": str(article.get("url") or "").strip(),
                    }
                    for article in articles[:limit]
                    if str(article.get("title") or "").strip()
                ],
            }
    except Exception:
        pass

    hn_url = (
        "https://hn.algolia.com/api/v1/search_by_date"
        f"?query={quote_plus(normalized_topic or 'technology')}&tags=story&hitsPerPage={limit}"
    )
    hn_payload = _json_request(hn_url, timeout=20)
    hits = hn_payload.get("hits") or []
    articles = [
        {
            "title": str(hit.get("title") or hit.get("story_title") or "").strip(),
            "source": "Hacker News",
            "published_at": str(hit.get("created_at") or "").strip(),
            "link": str(hit.get("url") or hit.get("story_url") or "").strip(),
        }
        for hit in hits[:limit]
        if str(hit.get("title") or hit.get("story_title") or "").strip()
    ]
    if not articles:
        raise RuntimeError("未获取到新闻结果")

    return {
        "topic": normalized_topic or "头条",
        "feed_title": f"{normalized_topic or '最新'}新闻",
        "articles": articles,
    }


class AudioProcessor:
    def __init__(self, connection, on_local_barge_in: Optional[Callable[[], None]] = None):
        try:
            import pyaudio  # type: ignore
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                "Audio mode requires pyaudio. Install: pip install -r requirements-audio.txt"
            ) from e

        self._pyaudio = pyaudio
        self.connection = connection
        self.on_local_barge_in = on_local_barge_in
        self.audio = pyaudio.PyAudio()
        self.format = pyaudio.paInt16
        self.channels = 1
        self.rate = 24000
        self.chunk_size = 1200  # 50ms @ 24kHz
        self.input_stream = None
        self.output_stream = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.playback_queue: queue.Queue[Optional[bytes]] = queue.Queue()
        self._playback_remainder = bytes()
        self._audio_lock = threading.Lock()
        self._pending_playback_bytes = 0
        self._last_playback_rms = 0.0
        self._suppress_input_until = 0.0
        self._tail_suppress_seconds = float(os.environ.get("PC_ASSISTANT_TAIL_SUPPRESS_SECONDS", "1.2"))
        self._response_suppress_seconds = float(
            os.environ.get("PC_ASSISTANT_RESPONSE_SUPPRESS_SECONDS", "1.8")
        )
        self._barge_in_min_rms = float(os.environ.get("PC_ASSISTANT_BARGE_IN_MIN_RMS", "1400"))
        self._barge_in_playback_ratio = float(os.environ.get("PC_ASSISTANT_BARGE_IN_PLAYBACK_RATIO", "1.6"))
        self._barge_in_consecutive_frames = int(os.environ.get("PC_ASSISTANT_BARGE_IN_CONSECUTIVE_FRAMES", "4"))
        self._barge_in_release_frames = int(os.environ.get("PC_ASSISTANT_BARGE_IN_RELEASE_FRAMES", "6"))
        self._barge_in_active = False
        self._barge_in_candidate_frames = 0
        self._barge_in_release_counter = 0
        self._barge_in_notified = False
        self._bytes_per_second = self.rate * self.channels * 2

    def _is_capture_blocked(self) -> bool:
        with self._audio_lock:
            return time.monotonic() < self._suppress_input_until

    def _has_active_playback(self) -> bool:
        with self._audio_lock:
            return self._pending_playback_bytes > 0 or bool(self._playback_remainder)

    def _pcm16_rms(self, pcm_bytes: bytes) -> float:
        if not pcm_bytes:
            return 0.0

        samples = memoryview(pcm_bytes).cast("h")
        if not samples:
            return 0.0

        total = 0.0
        for sample in samples:
            total += float(sample) * float(sample)
        return math.sqrt(total / len(samples))

    def _should_forward_capture(self, in_data: bytes) -> bool:
        if not self._has_active_playback():
            self._barge_in_active = False
            self._barge_in_candidate_frames = 0
            self._barge_in_release_counter = 0
            self._barge_in_notified = False
            return True

        mic_rms = self._pcm16_rms(in_data)
        with self._audio_lock:
            playback_rms = self._last_playback_rms

        threshold = max(self._barge_in_min_rms, playback_rms * self._barge_in_playback_ratio)
        if self._barge_in_active:
            hold_threshold = max(self._barge_in_min_rms * 0.65, threshold * 0.65)
            if mic_rms >= hold_threshold:
                self._barge_in_release_counter = 0
                return True

            self._barge_in_release_counter += 1
            if self._barge_in_release_counter >= self._barge_in_release_frames:
                self._barge_in_active = False
                self._barge_in_candidate_frames = 0
                self._barge_in_release_counter = 0
                self._barge_in_notified = False
            return False

        if mic_rms >= threshold:
            self._barge_in_candidate_frames += 1
            if self._barge_in_candidate_frames >= self._barge_in_consecutive_frames:
                self._barge_in_active = True
                self._barge_in_release_counter = 0
                if not self._barge_in_notified and self.on_local_barge_in:
                    self._barge_in_notified = True
                    self.on_local_barge_in()
                return True
            return False

        self._barge_in_candidate_frames = 0
        return False

    def suppress_capture_for(self, seconds: float) -> None:
        if seconds <= 0:
            return
        with self._audio_lock:
            self._suppress_input_until = max(self._suppress_input_until, time.monotonic() + seconds)

    def suppress_after_response(self) -> None:
        self.suppress_capture_for(self._response_suppress_seconds)

    def _register_playback_chunk(self, audio_len: int) -> None:
        with self._audio_lock:
            self._pending_playback_bytes += max(0, audio_len)

    def _consume_playback_bytes(self, consumed: int) -> None:
        with self._audio_lock:
            self._pending_playback_bytes = max(0, self._pending_playback_bytes - max(0, consumed))

    def interrupt_playback(self) -> None:
        with self._audio_lock:
            self._pending_playback_bytes = 0
            self._last_playback_rms = 0.0
            self._suppress_input_until = time.monotonic()
            self._playback_remainder = bytes()
            self._barge_in_active = False
            self._barge_in_candidate_frames = 0
            self._barge_in_release_counter = 0
            self._barge_in_notified = False

        while True:
            try:
                self.playback_queue.get_nowait()
            except queue.Empty:
                break

    def start_capture(self) -> None:
        if self.input_stream:
            return

        self.loop = asyncio.get_event_loop()

        def _capture_callback(in_data, _frame_count, _time_info, _status_flags):
            if self._is_capture_blocked():
                return (None, self._pyaudio.paContinue)

            if not self._should_forward_capture(in_data):
                return (None, self._pyaudio.paContinue)

            audio_base64 = base64.b64encode(in_data).decode("utf-8")
            asyncio.run_coroutine_threadsafe(
                self.connection.input_audio_buffer.append(audio=audio_base64),
                self.loop,
            )
            return (None, self._pyaudio.paContinue)

        self.input_stream = self.audio.open(
            format=self.format,
            channels=self.channels,
            rate=self.rate,
            input=True,
            frames_per_buffer=self.chunk_size,
            stream_callback=_capture_callback,
        )

    def start_playback(self) -> None:
        if self.output_stream:
            return

        def _playback_callback(_in_data, frame_count, _time_info, _status_flags):
            byte_count = frame_count * self._pyaudio.get_sample_size(self._pyaudio.paInt16)
            consumed_audio = 0

            out = self._playback_remainder[:byte_count]
            consumed_audio += len(out)
            self._playback_remainder = self._playback_remainder[byte_count:]
            while len(out) < byte_count:
                try:
                    packet = self.playback_queue.get_nowait()
                except queue.Empty:
                    out += bytes(byte_count - len(out))
                    break
                if packet is None:
                    out += bytes(byte_count - len(out))
                    break
                take = byte_count - len(out)
                chunk = packet[:take]
                out += chunk
                consumed_audio += len(chunk)
                self._playback_remainder = packet[take:]

            self._consume_playback_bytes(consumed_audio)
            with self._audio_lock:
                self._last_playback_rms = self._pcm16_rms(out)
            return (out, self._pyaudio.paContinue)

        self.output_stream = self.audio.open(
            format=self.format,
            channels=self.channels,
            rate=self.rate,
            output=True,
            frames_per_buffer=self.chunk_size,
            stream_callback=_playback_callback,
        )

    def queue_audio(self, audio_bytes: bytes) -> None:
        self._register_playback_chunk(len(audio_bytes))
        self.playback_queue.put(audio_bytes)

    def shutdown(self) -> None:
        if self.input_stream:
            self.input_stream.stop_stream()
            self.input_stream.close()
            self.input_stream = None
        if self.output_stream:
            self.playback_queue.put(None)
            self.output_stream.stop_stream()
            self.output_stream.close()
            self.output_stream = None
        if self.audio:
            self.audio.terminate()


@dataclass
class PendingFunctionCall:
    name: str
    call_id: str
    previous_item_id: str
    arguments: Optional[Union[str, Mapping[str, Any]]] = None


class VoiceLivePCAssistant:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.credential = build_token_credential()
        self.connection = None
        self.audio: Optional[AudioProcessor] = None
        self.event_stream_enabled = os.environ.get("PC_ASSISTANT_EVENT_STREAM", "").strip() == "1"

        if self.event_stream_enabled:
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(encoding="utf-8")
            if hasattr(sys.stderr, "reconfigure"):
                sys.stderr.reconfigure(encoding="utf-8")

        self._pending_calls: Dict[str, PendingFunctionCall] = {}
        self._active_response = False
        self._response_api_done = False
        self._interrupting_response = False

        self.available_functions: Dict[
            str, Callable[[Union[str, Mapping[str, Any], None]], Awaitable[Any]]
        ] = {
            "pc_get_volume": self.pc_get_volume,
            "pc_set_volume": self.pc_set_volume,
            "pc_set_mute": self.pc_set_mute,
            "pc_open_calculator": self.pc_open_calculator,
            "pc_open_notepad": self.pc_open_notepad,
            "pc_open_explorer": self.pc_open_explorer,
            "pc_open_settings": self.pc_open_settings,
            "pc_show_desktop": self.pc_show_desktop,
            "pc_open_camera": self.pc_open_camera,
            "pc_start_camera_observation": self.pc_start_camera_observation,
            "pc_stop_camera": self.pc_stop_camera,
            "pc_analyze_camera_recent_frames": self.pc_analyze_camera_recent_frames,
            "pc_get_weather": self.pc_get_weather,
            "pc_get_news": self.pc_get_news,
        }

    def _emit_event(self, event_type: str, **payload: Any) -> None:
        if not self.event_stream_enabled:
            return

        message = {"type": event_type, **payload}
        print(json.dumps(message, ensure_ascii=False), flush=True)

    def _write_text(self, text: str) -> None:
        if self.event_stream_enabled:
            return
        print(text, end="", flush=True)

    def _write_line(self, text: str) -> None:
        if self.event_stream_enabled:
            return
        print(text, flush=True)

    async def start(self) -> None:
        from azure.ai.voicelive.aio import connect

        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

        async with connect(
            endpoint=self.settings.voicelive_endpoint,
            credential=self.credential,
            model=self.settings.voicelive_model,
        ) as conn:
            self.connection = conn
            self.audio = AudioProcessor(conn, on_local_barge_in=self._handle_local_barge_in)
            await self._setup_session()

            self.audio.start_playback()
            self.audio.start_capture()

            self._emit_event("session_ready", message="Voice Live PC assistant ready.")

            self._write_line("Voice Live PC assistant ready. Speak to your microphone (Ctrl+C to exit).")
            try:
                await self._process_events()
            finally:
                self.audio.shutdown()
                self._emit_event("session_stopped", message="Voice Live PC assistant stopped.")

    def _handle_local_barge_in(self) -> None:
        if not self.loop or not self._active_response:
            return
        self.loop.call_soon_threadsafe(lambda: asyncio.create_task(self._interrupt_active_response("local_barge_in")))

    async def _interrupt_active_response(self, reason: str) -> None:
        if not self.audio:
            return

        self.audio.interrupt_playback()
        if not self._active_response or self._response_api_done:
            return
        if self._interrupting_response:
            return

        self._interrupting_response = True
        self._emit_event("assistant_log", level="info", message=f"Interrupting active response: {reason}")
        assert self.connection is not None
        try:
            await self.connection.response.cancel()
        except Exception as exc:  # noqa: BLE001
            self._emit_event("assistant_log", level="warn", message=f"Response cancel failed: {exc}")

    async def _setup_session(self) -> None:
        from azure.ai.voicelive.models import (
            AudioEchoCancellation,
            AudioInputTranscriptionOptions,
            AudioNoiseReduction,
            AzureStandardVoice,
            FunctionTool,
            InputAudioFormat,
            Modality,
            OutputAudioFormat,
            RequestSession,
            ServerVad,
            Tool,
            ToolChoiceLiteral,
        )

        voice: Union[AzureStandardVoice, str]
        if "-" in self.settings.voicelive_voice and self.settings.voicelive_voice.lower() != "alloy":
            voice = AzureStandardVoice(name=self.settings.voicelive_voice)
        else:
            voice = self.settings.voicelive_voice

        tools: list[Tool] = [
            FunctionTool(
                name="pc_get_volume",
                description="Get current Windows master volume and mute state.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_set_volume",
                description="Set Windows master volume level (0-100).",
                parameters={
                    "type": "object",
                    "properties": {"level": {"type": "integer", "minimum": 0, "maximum": 100}},
                    "required": ["level"],
                },
            ),
            FunctionTool(
                name="pc_set_mute",
                description="Mute or unmute Windows master volume.",
                parameters={
                    "type": "object",
                    "properties": {"muted": {"type": "boolean"}},
                    "required": ["muted"],
                },
            ),
            FunctionTool(
                name="pc_open_calculator",
                description="Open Windows Calculator.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_open_notepad",
                description="Open Windows Notepad.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_open_explorer",
                description="Open Windows File Explorer.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_open_settings",
                description="Open Windows Settings.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_show_desktop",
                description="Show the Windows desktop by minimizing open windows.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_open_camera",
                description="Open the browser camera preview in the web console.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_start_camera_observation",
                description="Start browser camera observation mode in the web console and analyze one frame every few seconds.",
                parameters={
                    "type": "object",
                    "properties": {
                        "interval_seconds": {"type": "integer", "minimum": 3, "maximum": 12}
                    },
                    "required": [],
                },
            ),
            FunctionTool(
                name="pc_stop_camera",
                description="Stop the browser camera preview and observation mode in the web console.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
            FunctionTool(
                name="pc_analyze_camera_recent_frames",
                description="Analyze the most recent cached camera frames from the web console and return the actual visual result for narration.",
                parameters={
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string"}
                    },
                    "required": [],
                },
            ),
            FunctionTool(
                name="pc_get_weather",
                description="Query the current weather and today's forecast for a city or region.",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"}
                    },
                    "required": [],
                },
            ),
            FunctionTool(
                name="pc_get_news",
                description="Query recent news headlines. Can search by topic like AI, Microsoft, China, finance, sports, or use top headlines when no topic is given.",
                parameters={
                    "type": "object",
                    "properties": {
                        "topic": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 8}
                    },
                    "required": [],
                },
            ),
        ]

        camera_guidance = (
            "\n\n当用户询问摄像头里现在看到了什么、当前画面是什么、镜头前的人在做什么、"
            "或者要求你根据摄像头内容回答时，必须优先调用 pc_analyze_camera_recent_frames，"
            "并且只基于工具返回的视觉结果作答，不要自行猜测画面内容。"
        )
        knowledge_guidance = (
            "\n\n当用户询问天气、温度、降雨、风力、空气体感等信息时，必须优先调用 pc_get_weather。"
            "当用户询问新闻、头条、某个主题最近发生了什么时，必须优先调用 pc_get_news。"
            "回答时要基于工具结果，不要编造实时信息。"
        )

        session = RequestSession(
            modalities=[Modality.TEXT, Modality.AUDIO],
            instructions=f"{self.settings.assistant_instructions}{camera_guidance}{knowledge_guidance}",
            voice=voice,
            input_audio_format=InputAudioFormat.PCM16,
            output_audio_format=OutputAudioFormat.PCM16,
            turn_detection=ServerVad(threshold=0.5, prefix_padding_ms=300, silence_duration_ms=500),
            input_audio_echo_cancellation=AudioEchoCancellation(),
            input_audio_noise_reduction=AudioNoiseReduction(
                type="azure_deep_noise_suppression"
            ),
            tools=tools,
            tool_choice=ToolChoiceLiteral.AUTO,
            input_audio_transcription=AudioInputTranscriptionOptions(model="whisper-1"),
        )

        assert self.connection is not None
        await self.connection.session.update(session=session)

    async def _process_events(self) -> None:
        from azure.ai.voicelive.models import ItemType, ServerEventType

        assert self.connection is not None
        assert self.audio is not None

        async for event in self.connection:
            if event.type == ServerEventType.INPUT_AUDIO_BUFFER_SPEECH_STARTED:
                self._emit_event("speech_started")
                await self._interrupt_active_response("server_speech_started")
            elif event.type == ServerEventType.INPUT_AUDIO_BUFFER_SPEECH_STOPPED:
                self._emit_event("speech_stopped")
            elif event.type == ServerEventType.CONVERSATION_ITEM_INPUT_AUDIO_TRANSCRIPTION_DELTA:
                self._emit_event("user_transcript_delta", text=event.delta or "", item_id=event.item_id)
            elif event.type == ServerEventType.CONVERSATION_ITEM_INPUT_AUDIO_TRANSCRIPTION_COMPLETED:
                self._emit_event(
                    "user_transcript_done",
                    text=event.transcript,
                    item_id=event.item_id,
                )
            elif event.type == ServerEventType.CONVERSATION_ITEM_INPUT_AUDIO_TRANSCRIPTION_FAILED:
                self._emit_event(
                    "user_transcript_failed",
                    error=getattr(event.error, "message", "input transcription failed"),
                )
            elif event.type == ServerEventType.RESPONSE_CREATED:
                self._active_response = True
                self._response_api_done = False
                self._interrupting_response = False
                self._emit_event("response_created")
            elif event.type == ServerEventType.RESPONSE_TEXT_DELTA:
                self._emit_event("assistant_text_delta", text=event.delta)
                self._write_text(event.delta)
            elif event.type == ServerEventType.RESPONSE_TEXT_DONE:
                self._emit_event("assistant_text_done")
                self._write_line("")
            elif event.type == ServerEventType.RESPONSE_AUDIO_TRANSCRIPT_DELTA:
                self._emit_event("assistant_audio_transcript_delta", text=event.delta or "")
            elif event.type == ServerEventType.RESPONSE_AUDIO_TRANSCRIPT_DONE:
                self._emit_event("assistant_audio_transcript_done", text=getattr(event, "transcript", ""))
            elif event.type == ServerEventType.RESPONSE_AUDIO_DELTA:
                if not self._interrupting_response:
                    self.audio.queue_audio(event.delta)
            elif event.type == ServerEventType.RESPONSE_DONE:
                self._active_response = False
                self._response_api_done = True
                self._interrupting_response = False
                self._emit_event("response_done")
                self.audio.suppress_after_response()
                call_ids = [cid for cid, c in self._pending_calls.items() if c.arguments is not None]
                for cid in call_ids:
                    c = self._pending_calls.pop(cid)
                    await self._execute_function_call(c)
            elif event.type == ServerEventType.CONVERSATION_ITEM_CREATED:
                if event.item.type == ItemType.FUNCTION_CALL:
                    call = PendingFunctionCall(
                        name=event.item.name,
                        call_id=event.item.call_id,
                        previous_item_id=event.item.id,
                    )
                    self._pending_calls[call.call_id] = call
                    self._emit_event("tool_call", name=event.item.name, call_id=event.item.call_id)
                    self._write_line(f"Tool call: {event.item.name}")
            elif event.type == ServerEventType.RESPONSE_FUNCTION_CALL_ARGUMENTS_DONE:
                call = self._pending_calls.get(event.call_id)
                if call:
                    call.arguments = event.arguments
            elif event.type == ServerEventType.ERROR:
                self._emit_event("error", message=getattr(event.error, "message", str(event)))
                logger.error("VoiceLive error: %s", getattr(event.error, "message", event))

    async def _execute_function_call(self, call: PendingFunctionCall) -> None:
        from azure.ai.voicelive.models import FunctionCallOutputItem

        assert self.connection is not None

        fn = self.available_functions.get(call.name)
        if not fn:
            output = {"ok": False, "error": f"unknown tool: {call.name}"}
        else:
            try:
                result = await fn(call.arguments)
                output = {"ok": True, "result": result}
            except Exception as e:  # noqa: BLE001
                output = {"ok": False, "error": str(e)}

        self._emit_event("tool_result", name=call.name, call_id=call.call_id, output=output)

        item = FunctionCallOutputItem(call_id=call.call_id, output=json.dumps(output, ensure_ascii=False))
        await self.connection.conversation.item.create(previous_item_id=call.previous_item_id, item=item)
        await self.connection.response.create()

    async def pc_get_volume(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        try:
            state = await asyncio.to_thread(get_master_volume_state)
            return {"level": state.level, "muted": state.muted}
        except VolumeControlNotSupported as e:
            return {"error": str(e)}

    async def pc_set_volume(self, arguments: Union[str, Mapping[str, Any], None]) -> Any:
        args = _safe_json_loads(arguments)
        level = int(args.get("level", 0))
        try:
            state = await asyncio.to_thread(set_master_volume_level, level)
            return {"level": state.level, "muted": state.muted}
        except VolumeControlNotSupported as e:
            return {"error": str(e)}

    async def pc_set_mute(self, arguments: Union[str, Mapping[str, Any], None]) -> Any:
        args = _safe_json_loads(arguments)
        muted = bool(args.get("muted", False))
        try:
            state = await asyncio.to_thread(set_master_mute, muted)
            return {"level": state.level, "muted": state.muted}
        except VolumeControlNotSupported as e:
            return {"error": str(e)}

    async def _perform_windows_action(self, action: str) -> Any:
        try:
            return await asyncio.to_thread(perform_windows_action, action)
        except WindowsActionNotSupported as e:
            return {"error": str(e)}

    async def _request_camera_control(
        self,
        action: str,
        *,
        detail: str,
        interval_seconds: Optional[int] = None,
    ) -> Any:
        payload: Dict[str, Any] = {
            "action": action,
            "detail": detail,
        }
        if interval_seconds is not None:
            payload["interval_seconds"] = interval_seconds

        self._emit_event("camera_control", **payload)
        return payload

    async def _request_browser_camera_analysis(self, prompt: str | None = None) -> Any:
        base_url = os.environ.get("PC_ASSISTANT_WEB_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
        api_url = f"{base_url}/api/camera/request-analysis"
        body = json.dumps({"prompt": prompt, "mode": "manual"}).encode("utf-8")

        http_request = request.Request(
            api_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        def _send_request() -> Any:
            try:
                with request.urlopen(http_request, timeout=35) as response:
                    payload = json.loads(response.read().decode("utf-8"))
            except error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"camera analysis bridge failed: {exc.code} {detail}") from exc
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"camera analysis bridge failed: {exc}") from exc

            if not payload.get("ok"):
                raise RuntimeError(payload.get("error") or "camera analysis failed")
            return payload.get("result")

        return await asyncio.to_thread(_send_request)

    async def pc_open_calculator(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        return await self._perform_windows_action("open_calculator")

    async def pc_open_notepad(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        return await self._perform_windows_action("open_notepad")

    async def pc_open_explorer(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        return await self._perform_windows_action("open_explorer")

    async def pc_open_settings(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        return await self._perform_windows_action("open_settings")

    async def pc_show_desktop(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        return await self._perform_windows_action("show_desktop")

    async def pc_open_camera(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        return await self._request_camera_control(
            "open",
            detail="已请求打开浏览器里的摄像头预览。",
        )

    async def pc_start_camera_observation(self, arguments: Union[str, Mapping[str, Any], None]) -> Any:
        args = _safe_json_loads(arguments)
        interval_seconds = int(args.get("interval_seconds", 5) or 5)
        interval_seconds = max(3, min(12, interval_seconds))
        return await self._request_camera_control(
            "observe_start",
            detail=f"已请求开启摄像头观察模式，每 {interval_seconds} 秒分析一帧。",
            interval_seconds=interval_seconds,
        )

    async def pc_stop_camera(self, _arguments: Union[str, Mapping[str, Any], None]) -> Any:
        return await self._request_camera_control(
            "stop",
            detail="已请求关闭浏览器里的摄像头预览和观察模式。",
        )

    async def pc_analyze_camera_recent_frames(self, arguments: Union[str, Mapping[str, Any], None]) -> Any:
        args = _safe_json_loads(arguments)
        prompt = str(args.get("prompt") or "请基于最近三帧摄像头画面，给出准确、简洁、不要猜测的中文描述。")
        return await self._request_browser_camera_analysis(prompt)

    async def pc_get_weather(self, arguments: Union[str, Mapping[str, Any], None]) -> Any:
        args = _safe_json_loads(arguments)
        location = str(args.get("location") or "北京")
        return await asyncio.to_thread(_fetch_weather, location)

    async def pc_get_news(self, arguments: Union[str, Mapping[str, Any], None]) -> Any:
        args = _safe_json_loads(arguments)
        topic = str(args.get("topic") or "").strip() or None
        limit = int(args.get("limit", 5) or 5)
        limit = max(1, min(8, limit))
        return await asyncio.to_thread(_fetch_news, topic, limit)


async def _amain() -> None:
    settings = load_settings()
    assistant = VoiceLivePCAssistant(settings)
    try:
        await assistant.start()
    finally:
        await assistant.credential.close()


def main() -> None:
    asyncio.run(_amain())


if __name__ == "__main__":
    main()



