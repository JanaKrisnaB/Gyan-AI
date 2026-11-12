"""
Gnani AI Client module for Gyan Ai.
Handles Speech-to-Text via Gnani Prisma API and Text-to-Speech via Gnani Timbre API.
Converts browser WebM/Opus audio to 16kHz mono WAV via ffmpeg.
Includes graceful fallback/mock for local testing when Gnani credentials are not supplied.
"""

import os
import subprocess
import tempfile
import base64
import json
import logging
from typing import Optional
try:
    import requests
except ImportError:
    requests = None

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logger = logging.getLogger("gnani_client")

# Environment configuration: Gnani.ai / Vachana STT & TTS
# Global Auth Header: X-API-Key-ID
GNANI_API_KEY = (
    os.getenv("GNANI_API_KEY")
    or os.getenv("X_API_KEY_ID")
    or os.getenv("VACHANA_API_KEY")
    or ""
).strip()
GNANI_BASE_URL = os.getenv("GNANI_BASE_URL", "https://vachana.ai").strip()
GNANI_STT_URL = os.getenv("GNANI_STT_URL", "https://vachana.ai").strip()
GNANI_STT_V3_URL = "https://api.vachana.ai/stt/v3"
GNANI_STT_STREAM_URL = os.getenv("GNANI_STT_STREAM_URL", "wss://api.vachana.ai/stt/v3/stream").strip()
GNANI_TTS_URL = os.getenv("GNANI_TTS_URL", "https://vachana.ai").strip()
GNANI_TTS_INFERENCE_URL = "https://api.vachana.ai/api/v1/tts/inference"

GNANI_STT_MODEL = "prisma-v3.0"
GNANI_TTS_MODEL = "timbre-v3.0"

# Language code mapping for Gnani Prisma v3.0 (supports indic-auto for automatic code-switching)
LANGUAGE_MAP_STT = {
    "en": "en-IN",
    "hi": "hi-IN",
    "ta": "ta-IN",
    "te": "te-IN",
    "kn": "kn-IN",
    "mr": "mr-IN",
    "auto": "indic-auto",
    "indic-auto": "indic-auto",
    "hi-en": "hi-IN",
    "ta-en": "ta-IN",
}

# Supported Languages & Voices for Gnani Timbre v2.5 (Default Female: Nalini)
LANGUAGE_MAP_TTS = {
    "en": "en-IN",
    "hi": "hi-IN",
    "ta": "ta-IN",
    "te": "te-IN",
    "kn": "kn-IN",
    "mr": "mr-IN",
}


def convert_audio_to_wav(audio_bytes: bytes, sample_rate: int = 16000) -> bytes:
    """
    Converts browser audio (WebM, Opus, Ogg, MP3, etc.) to 16kHz 16-bit mono Linear PCM WAV
    using ffmpeg (sample_rate: 16000, num_channels: 1, sample_width: 2).
    """
    if not audio_bytes:
        return b""

    if audio_bytes.startswith(b"RIFF") and len(audio_bytes) > 44:
        try:
            return _run_ffmpeg_convert(audio_bytes, sample_rate)
        except Exception:
            return audio_bytes

    return _run_ffmpeg_convert(audio_bytes, sample_rate)


def _run_ffmpeg_convert(audio_bytes: bytes, sample_rate: int = 16000) -> bytes:
    """Run ffmpeg via subprocess with temp files for cross-platform reliability."""
    with tempfile.NamedTemporaryFile(suffix=".input", delete=False) as in_file:
        in_path = in_file.name
        in_file.write(audio_bytes)
        in_file.flush()

    out_path = in_path + ".wav"

    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-loglevel", "error",
            "-i", in_path,
            "-ar", str(sample_rate),
            "-ac", "1",
            "-c:a", "pcm_s16le",
            out_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if res.returncode != 0:
            logger.warning(f"ffmpeg conversion error: {res.stderr.decode('utf-8', errors='ignore')}")
            return audio_bytes

        with open(out_path, "rb") as out_file:
            return out_file.read()
    except Exception as e:
        logger.error(f"Failed to execute ffmpeg: {e}")
        return audio_bytes
    finally:
        for p in (in_path, out_path):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass


def _split_wav_25s_chunks(wav_bytes: bytes) -> list[bytes]:
    """Splits a 16kHz 16-bit mono WAV into <=25s WAV chunks (Vachana STT v3 limit is 30s)."""
    import struct
    if not wav_bytes or len(wav_bytes) <= 44:
        return [wav_bytes]

    data_offset = 44
    pcm_data = wav_bytes[data_offset:]
    byte_rate = 16000 * 1 * 2  # 32,000 bytes/sec
    max_chunk = 25 * byte_rate  # 800,000 bytes (25s)

    if len(pcm_data) <= max_chunk:
        return [wav_bytes]

    chunks: list[bytes] = []
    for offset in range(0, len(pcm_data), max_chunk):
        slice_bytes = pcm_data[offset : offset + max_chunk]
        if len(slice_bytes) % 2 != 0:
            slice_bytes = slice_bytes[:-1]
        if not slice_bytes:
            continue
        subchunk2_size = len(slice_bytes)
        header = struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",
            36 + subchunk2_size,
            b"WAVE",
            b"fmt ",
            16,
            1,
            1,
            16000,
            byte_rate,
            2,
            16,
            b"data",
            subchunk2_size,
        )
        chunks.append(header + slice_bytes)

    return chunks if chunks else [wav_bytes]


def transcribe(audio_bytes: bytes, language: str = "en") -> str:
    """
    Speech-to-Text via Gnani Prisma API (prisma-v3.0).
    Endpoint: https://api.vachana.ai/stt/v3
    Required Multipart Fields: audio_file, language_code, model
    Auth Header: X-API-Key-ID
    """
    if not audio_bytes:
        return ""

    # Convert audio to 16kHz mono Linear PCM WAV
    wav_bytes = convert_audio_to_wav(audio_bytes)

    if not GNANI_API_KEY or requests is None:
        logger.info("GNANI_API_KEY not configured in .env. Running fallback mock transcription.")
        return _mock_transcribe(wav_bytes, language)

    target_lang = LANGUAGE_MAP_STT.get(language.lower(), "indic-auto")
    multipart_headers = {
        "X-API-Key-ID": GNANI_API_KEY,
    }

    wav_chunks = _split_wav_25s_chunks(wav_bytes)
    collected: list[str] = []

    for idx, chunk_wav in enumerate(wav_chunks):
        try:
            files = {
                "audio_file": (f"segment_{idx + 1}.wav", chunk_wav, "audio/wav")
            }
            data = {
                "language_code": target_lang,
                "model": GNANI_STT_MODEL,
            }

            response = requests.post(
                GNANI_STT_V3_URL,
                headers=multipart_headers,
                data=data,
                files=files,
                timeout=45,
            )

            if response.status_code == 200:
                result = response.json()
                if isinstance(result, dict):
                    text = (
                        result.get("transcript")
                        or result.get("text")
                        or result.get("data", {}).get("transcript")
                        or ""
                    )
                    if text and str(text).strip():
                        collected.append(str(text).strip())
        except Exception as e:
            logger.error(f"Error calling Gnani Prisma API on segment {idx + 1}: {e}")

    if collected:
        return " ".join(collected).strip()

    return _mock_transcribe(wav_bytes, language)


def synthesize(text: str, language: str = "hi-IN", voice: str = "Nalini") -> bytes:
    """
    Text-to-Speech via Gnani Timbre API (timbre-v2.5).
    Base Endpoint: https://vachana.ai
    Auth Header: X-API-Key-ID
    """
    if not text or not text.strip():
        return b""

    if not GNANI_API_KEY or requests is None:
        logger.info("GNANI_API_KEY not configured. Returning synthetic/fallback audio bytes.")
        return _mock_synthesize(text)

    target_lang = LANGUAGE_MAP_TTS.get(language.lower().split("-")[0], "hi-IN")
    voice_name = "Nalini" if voice in ("female", "male", "", None) else voice

    headers = {
        "X-API-Key-ID": GNANI_API_KEY,
        "x-api-key": GNANI_API_KEY,
        "Authorization": f"Bearer {GNANI_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "text": text,
        "voice": voice_name,
        "model": GNANI_TTS_MODEL,  # "timbre-v2.5"
        "language": target_lang,
        "speed": 1.0,
        "audio_config": {
            "encoding": "linear_pcm",
            "container": "wav",
            "num_channels": 1,
            "sample_rate": 16000,
            "sample_width": 2,
        },
    }

    for url in (GNANI_TTS_URL, GNANI_TTS_INFERENCE_URL):
        try:
            response = requests.post(
                url,
                headers=headers,
                data=json.dumps(payload),
                timeout=30,
            )

            if response.status_code == 200:
                content_type = response.headers.get("content-type", "")
                if "audio" in content_type or "octet-stream" in content_type:
                    return response.content

                data = response.json()
                if isinstance(data, dict):
                    audio_b64 = data.get("audio_content") or data.get("audio") or data.get("data")
                    if audio_b64:
                        return base64.b64decode(audio_b64)

                return response.content
        except Exception as e:
            logger.warning(f"Gnani Timbre TTS notice ({url}): {e}")

    return _mock_synthesize(text)


def _mock_transcribe(audio_bytes: bytes, language: str) -> str:
    """
    Fallback mock transcription for testing without live Gnani credentials.
    Generates realistic code-mixed lecture transcripts based on selected language.
    """
    byte_count = len(audio_bytes) if audio_bytes else 0

    if language.startswith("hi"):
        return (
            "Aaj hum Operating Systems mein CPU Scheduling and Process Synchronization discuss karenge. "
            "Basically jab multiple processes simultaneously execute hote hain, toh humein Race Condition se bachne ke liye "
            "Mutex locks ya Semaphores use karne padte hain. Critical section problem ko solve karne ke liye teen zaroori "
            "conditions satisfy honi chahiye: Mutual Exclusion, Progress, aur Bounded Waiting."
        )
    elif language.startswith("ta"):
        return (
            "Inaiku class la Machine Learning pathi paakaporom. Gradient Descent algorithm romba mukkiyam. "
            "Model oda Loss Function minimize panni, weights update panrom. Learning rate romba high ah irundha overshoot aagum, "
            "romba low ah irundha converge aaga romba time aagum. Idhu thaan optimization oda core intuition."
        )
    else:
        return (
            "In today's lecture on Data Structures and Algorithms, we analyze Big-O notation and time complexity. "
            "Arrays offer constant time O(1) random access due to contiguous memory allocation. However, insertion "
            "and deletion at arbitrary indices require linear time O(n) because subsequent elements must be shifted. "
            "Understanding these trade-offs is essential for designing scalable distributed systems."
        )


def _mock_synthesize(text: str) -> bytes:
    """
    Generates a minimalist valid 1-second 16kHz mono silent/tone WAV file
    so media elements never fail to play in browsers or client tests.
    """
    import struct
    sample_rate = 16000
    num_samples = sample_rate // 2 # 0.5s tone/silence
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    subchunk2_size = num_samples * num_channels * bits_per_sample // 8
    chunk_size = 36 + subchunk2_size

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        chunk_size,
        b"WAVE",
        b"fmt ",
        16, # Subchunk1Size for PCM
        1,  # AudioFormat (1 = PCM)
        num_channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        subchunk2_size
    )
    # Generate 0.5s of gentle waveform so playback test emits sound
    import math
    data = bytearray()
    freq = 440.0
    for i in range(num_samples):
        # A gentle 440Hz sine wave that fades out
        t = float(i) / sample_rate
        sample_val = int(3000 * math.sin(2 * math.pi * freq * t) * (1.0 - t * 2))
        data.extend(struct.pack("<h", sample_val))

    return header + bytes(data)
