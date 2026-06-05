from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any


class VolumeControlNotSupported(RuntimeError):
    pass


@dataclass(frozen=True)
class VolumeState:
    level: int  # 0-100
    muted: bool


def _require_windows() -> None:
    if not sys.platform.startswith("win"):
        raise VolumeControlNotSupported("Master volume control is only supported on Windows.")


def _endpoint_volume():
    _require_windows()
    try:
        from ctypes import POINTER, cast
        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
    except Exception as e:  # noqa: BLE001
        raise VolumeControlNotSupported(
            "Missing dependencies for volume control. Install: pycaw comtypes"
        ) from e

    devices = AudioUtilities.GetSpeakers()
    # pycaw API differs across versions: newer exposes EndpointVolume directly.
    endpoint = getattr(devices, "EndpointVolume", None)
    if endpoint is not None:
        return endpoint

    interface = devices.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
    return cast(interface, POINTER(IAudioEndpointVolume))


class _CoInit:
    def __enter__(self) -> None:
        try:
            from comtypes import CoInitialize
        except Exception as e:  # noqa: BLE001
            raise VolumeControlNotSupported(
                "Missing COM runtime dependency. Install: comtypes"
            ) from e
        CoInitialize()

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        from comtypes import CoUninitialize

        CoUninitialize()


def get_master_volume_state() -> VolumeState:
    with _CoInit():
        ev = _endpoint_volume()
        scalar = float(ev.GetMasterVolumeLevelScalar())
        muted = bool(ev.GetMute())
        level = int(round(max(0.0, min(1.0, scalar)) * 100))
        return VolumeState(level=level, muted=muted)


def set_master_volume_level(level: int) -> VolumeState:
    with _CoInit():
        ev = _endpoint_volume()
        clamped = max(0, min(100, int(level)))
        ev.SetMasterVolumeLevelScalar(clamped / 100.0, None)
        scalar = float(ev.GetMasterVolumeLevelScalar())
        muted = bool(ev.GetMute())
        level_now = int(round(max(0.0, min(1.0, scalar)) * 100))
        return VolumeState(level=level_now, muted=muted)


def set_master_mute(muted: bool) -> VolumeState:
    with _CoInit():
        ev = _endpoint_volume()
        ev.SetMute(bool(muted), None)
        scalar = float(ev.GetMasterVolumeLevelScalar())
        muted_now = bool(ev.GetMute())
        level_now = int(round(max(0.0, min(1.0, scalar)) * 100))
        return VolumeState(level=level_now, muted=muted_now)
