from __future__ import annotations

import json
import os
from typing import Any
from urllib import error, request

from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv


class VisionInferenceError(RuntimeError):
    pass


def _resolve_endpoint() -> tuple[str, str]:
    raw_endpoint = (
        os.environ.get("AZURE_VISION_ENDPOINT", "").strip()
        or os.environ.get("AZURE_INFERENCE_ENDPOINT", "").strip()
        or os.environ.get("AZURE_VOICELIVE_ENDPOINT", "").strip()
    )
    if not raw_endpoint:
        raise VisionInferenceError(
            "Missing env: AZURE_VISION_ENDPOINT or AZURE_INFERENCE_ENDPOINT or AZURE_VOICELIVE_ENDPOINT"
        )

    endpoint = raw_endpoint.rstrip("/")
    normalized = endpoint.lower()

    if "/openai/v1" in normalized:
        return endpoint, "azure_openai_v1"

    if not endpoint.endswith("/models"):
        endpoint = f"{endpoint}/models"
    return endpoint, "foundry_models"


def _resolve_model() -> str:
    model = (
        os.environ.get("AZURE_VISION_MODEL", "").strip()
        or os.environ.get("AZURE_INFERENCE_MODEL", "").strip()
        or os.environ.get("AZURE_VOICELIVE_MODEL", "").strip()
    )
    if not model:
        raise VisionInferenceError(
            "Missing env: AZURE_VISION_MODEL or AZURE_INFERENCE_MODEL or AZURE_VOICELIVE_MODEL"
        )
    return model


def _build_user_prompt(prompt: str | None) -> str:
    base_prompt = (
        "请基于这一帧摄像头画面，用中文给出实时观察结论。"
        "优先说明当前正在发生的动作、主要人物或物体、所在场景、屏幕或纸张上的明显文字。"
        "如果看不清，请明确说看不清，不要猜测。"
        "回答尽量具体，避免只说“室内”“有人”“桌子”这类过于笼统的话。"
    )
    extra_prompt = (prompt or "").strip()
    if not extra_prompt:
        return base_prompt
    return f"{base_prompt}\n\n补充要求：{extra_prompt}"


def _normalize_image_inputs(image_data: str | list[str] | tuple[str, ...]) -> list[str]:
    if isinstance(image_data, str):
        images = [image_data]
    else:
        images = [str(item) for item in image_data]

    cleaned = [image.strip() for image in images if str(image).strip()]
    if not cleaned:
        raise VisionInferenceError("At least one camera frame image is required.")

    for image in cleaned:
        if not image.startswith("data:image/"):
            raise VisionInferenceError("Camera frame must be provided as a data URL.")

    return cleaned


def analyze_camera_frame(image_data_url: str | list[str] | tuple[str, ...], prompt: str | None = None) -> dict[str, Any]:
    load_dotenv(override=True)

    image_inputs = _normalize_image_inputs(image_data_url)

    endpoint, endpoint_kind = _resolve_endpoint()
    model = _resolve_model()
    user_prompt = _build_user_prompt(prompt)

    user_content: list[dict[str, Any]] = [{"type": "text", "text": user_prompt}]
    for image in image_inputs:
        user_content.append({"type": "image_url", "image_url": {"url": image, "detail": "high"}})

    credential = DefaultAzureCredential()
    try:
        token = credential.get_token("https://cognitiveservices.azure.com/.default")
    except Exception as exc:  # noqa: BLE001
        raise VisionInferenceError(f"Failed to acquire Azure token: {exc}") from exc

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a precise real-time vision assistant. "
                    "Reply in Chinese. Focus on what is happening now in the current frame, "
                    "including people, actions, objects, scene context, visible text, and any notable change clues. "
                    "If something is uncertain or blurry, say so explicitly instead of guessing."
                ),
            },
            {
                "role": "user",
                "content": user_content,
            },
        ],
        "temperature": 0.1,
    }

    if endpoint_kind == "azure_openai_v1":
        payload["max_completion_tokens"] = 320
        api_url = f"{endpoint}/chat/completions"
    else:
        payload["max_tokens"] = 320
        api_url = f"{endpoint}/chat/completions?api-version=2024-05-01-preview"

    http_request = request.Request(
        api_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token.token}",
        },
        method="POST",
    )

    try:
        with request.urlopen(http_request, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise VisionInferenceError(f"Vision request failed: {exc.code} {detail}") from exc
    except Exception as exc:  # noqa: BLE001
        raise VisionInferenceError(f"Vision request failed: {exc}") from exc

    choices = result.get("choices") or []
    if not choices:
        raise VisionInferenceError("Vision model returned no choices.")

    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        text = "\n".join(
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and item.get("type") in {None, "text"}
        ).strip()
    else:
        text = str(content or "").strip()

    if not text:
        raise VisionInferenceError("Vision model returned an empty description.")

    return {
        "description": text,
        "model": result.get("model", model),
    }