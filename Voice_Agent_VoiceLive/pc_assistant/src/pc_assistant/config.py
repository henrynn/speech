from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    voicelive_endpoint: str
    voicelive_model: str
    voicelive_voice: str
    assistant_instructions: str


def load_settings() -> Settings:
    load_dotenv(override=True)

    endpoint = os.environ.get("AZURE_VOICELIVE_ENDPOINT", "").strip()
    if not endpoint:
        raise RuntimeError("Missing env: AZURE_VOICELIVE_ENDPOINT")

    return Settings(
        voicelive_endpoint=endpoint,
        voicelive_model=os.environ.get("AZURE_VOICELIVE_MODEL", "gpt-4o-realtime-preview").strip(),
        voicelive_voice=os.environ.get("AZURE_VOICELIVE_VOICE", "alloy").strip(),
        assistant_instructions=os.environ.get(
            "ASSISTANT_INSTRUCTIONS",
            "你是一个运行在 Windows PC 上的个人语音助手。",
        ).strip(),
    )
