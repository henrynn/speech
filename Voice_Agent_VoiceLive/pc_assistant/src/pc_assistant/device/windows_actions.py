from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, asdict
from typing import Callable, Dict


class WindowsActionNotSupported(RuntimeError):
    pass


@dataclass(frozen=True)
class WindowsActionResult:
    action: str
    detail: str


def _require_windows() -> None:
    if not sys.platform.startswith("win"):
        raise WindowsActionNotSupported("Windows desktop actions are only supported on Windows.")


def _launch_process(action: str, executable: str, detail: str) -> WindowsActionResult:
    _require_windows()
    try:
        subprocess.Popen([executable], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:  # noqa: BLE001
        raise WindowsActionNotSupported(f"Failed to launch {executable}: {exc}") from exc
    return WindowsActionResult(action=action, detail=detail)


def open_calculator() -> WindowsActionResult:
    return _launch_process("open_calculator", "calc.exe", "Calculator opened.")


def open_notepad() -> WindowsActionResult:
    return _launch_process("open_notepad", "notepad.exe", "Notepad opened.")


def open_explorer() -> WindowsActionResult:
    return _launch_process("open_explorer", "explorer.exe", "File Explorer opened.")


def open_settings() -> WindowsActionResult:
    _require_windows()
    try:
        os.startfile("ms-settings:")  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        raise WindowsActionNotSupported(f"Failed to open Windows Settings: {exc}") from exc
    return WindowsActionResult(action="open_settings", detail="Windows Settings opened.")


def show_desktop() -> WindowsActionResult:
    _require_windows()
    try:
        import ctypes

        user32 = ctypes.windll.user32
        key_up = 0x0002
        vk_lwin = 0x5B
        vk_d = 0x44

        user32.keybd_event(vk_lwin, 0, 0, 0)
        user32.keybd_event(vk_d, 0, 0, 0)
        user32.keybd_event(vk_d, 0, key_up, 0)
        user32.keybd_event(vk_lwin, 0, key_up, 0)
    except Exception as exc:  # noqa: BLE001
        raise WindowsActionNotSupported(f"Failed to show the desktop: {exc}") from exc
    return WindowsActionResult(action="show_desktop", detail="Desktop shown.")


_ACTION_MAP: Dict[str, Callable[[], WindowsActionResult]] = {
    "open_calculator": open_calculator,
    "open_notepad": open_notepad,
    "open_explorer": open_explorer,
    "open_settings": open_settings,
    "show_desktop": show_desktop,
}


def perform_windows_action(action: str) -> dict[str, str]:
    handler = _ACTION_MAP.get(action)
    if handler is None:
        raise WindowsActionNotSupported(f"Unsupported Windows action: {action}")
    return asdict(handler())