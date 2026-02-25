#!/usr/bin/env python3
import argparse
import base64
import json
import os
import struct
import sys
import time
from typing import Any, Dict

import numpy as np
from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run offline ASR with faster-whisper")
    parser.add_argument("--audio", help="Path to wav file (single-run mode)")
    parser.add_argument("--model", required=True, help="Local path to faster-whisper model")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--serve", action="store_true", help="Run as a persistent JSONL worker")
    parser.add_argument(
        "--framed-io",
        action="store_true",
        help="Use framed stdin/stdout protocol (uint32 json_len, uint32 audio_len, json, audio)",
    )
    return parser.parse_args()


def transcribe_audio(model: WhisperModel, audio_path: str) -> Dict[str, Any]:
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    started = time.time()
    segments, info = model.transcribe(audio_path, beam_size=1, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()

    return {
        "text": text,
        "language": getattr(info, "language", None),
        "durationSeconds": round(time.time() - started, 3),
    }


def transcribe_pcm16(model: WhisperModel, pcm_bytes: bytes) -> Dict[str, Any]:
    started = time.time()
    audio = np.frombuffer(pcm_bytes, np.int16).astype(np.float32) / 32768.0
    segments, info = model.transcribe(audio, beam_size=1, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()

    return {
        "text": text,
        "language": getattr(info, "language", None),
        "durationSeconds": round(time.time() - started, 3),
    }


def read_exact(reader: Any, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = reader.read(size - len(data))
        if not chunk:
            return b""
        data.extend(chunk)
    return bytes(data)


def read_framed_request(reader: Any) -> tuple[dict[str, Any] | None, bytes | None]:
    header = read_exact(reader, 8)
    if not header:
        return None, None

    json_len, audio_len = struct.unpack("<II", header)
    if json_len == 0:
        raise ValueError("Invalid framed request: json_len must be > 0")

    json_bytes = read_exact(reader, json_len)
    if len(json_bytes) != json_len:
        raise ValueError("Invalid framed request: could not read JSON payload")

    audio_bytes = b""
    if audio_len > 0:
        audio_bytes = read_exact(reader, audio_len)
        if len(audio_bytes) != audio_len:
            raise ValueError("Invalid framed request: could not read audio payload")

    payload = json.loads(json_bytes.decode("utf-8"))
    return payload, audio_bytes


def write_framed_response(writer: Any, response: dict[str, Any]) -> None:
    json_bytes = json.dumps(response, ensure_ascii=False).encode("utf-8")
    writer.write(struct.pack("<I", len(json_bytes)))
    writer.write(json_bytes)
    writer.flush()


def serve_loop(model: WhisperModel, framed_io: bool = False) -> int:
    if framed_io:
        reader = sys.stdin.buffer
        writer = sys.stdout.buffer
        while True:
            request_id = None
            try:
                payload, framed_audio = read_framed_request(reader)
                if payload is None:
                    break

                request_id = payload.get("id")
                action = payload.get("action", "transcribe")

                if action == "warmup":
                    response = {"id": request_id, "ok": True, "result": {"ready": True}}
                elif action == "transcribe":
                    if framed_audio is not None and len(framed_audio) > 0:
                        sample_rate = payload.get("sampleRate", 16000)
                        if sample_rate != 16000:
                            raise ValueError("Only sampleRate=16000 is currently supported for transcribe")
                        result = transcribe_pcm16(model, framed_audio)
                    else:
                        audio_base64 = payload.get("audioBase64")
                        if isinstance(audio_base64, str) and audio_base64:
                            sample_rate = payload.get("sampleRate", 16000)
                            if sample_rate != 16000:
                                raise ValueError("Only sampleRate=16000 is currently supported for audioBase64")
                            raw_audio = base64.b64decode(audio_base64)
                            if len(raw_audio) == 0:
                                raise ValueError("Field 'audioBase64' decoded to empty audio")
                            result = transcribe_pcm16(model, raw_audio)
                        else:
                            audio_path = payload.get("audio")
                            if not isinstance(audio_path, str) or not audio_path:
                                raise ValueError("Missing required field 'audio' or binary audio payload")
                            result = transcribe_audio(model, audio_path)
                    response = {"id": request_id, "ok": True, "result": result}
                else:
                    raise ValueError(f"Unsupported action: {action}")
            except Exception as exc:  # noqa: BLE001
                response = {"id": request_id, "ok": False, "error": str(exc)}

            write_framed_response(writer, response)

        return 0

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        request_id = None

        try:
            payload = json.loads(raw)
            request_id = payload.get("id")
            action = payload.get("action", "transcribe")

            if action == "warmup":
                response = {"id": request_id, "ok": True, "result": {"ready": True}}
            elif action == "transcribe":
                audio_base64 = payload.get("audioBase64")
                if isinstance(audio_base64, str) and audio_base64:
                    sample_rate = payload.get("sampleRate", 16000)
                    if sample_rate != 16000:
                        raise ValueError("Only sampleRate=16000 is currently supported for audioBase64")
                    raw_audio = base64.b64decode(audio_base64)
                    if len(raw_audio) == 0:
                        raise ValueError("Field 'audioBase64' decoded to empty audio")
                    result = transcribe_pcm16(model, raw_audio)
                else:
                    audio_path = payload.get("audio")
                    if not isinstance(audio_path, str) or not audio_path:
                        raise ValueError("Missing required field 'audio' or 'audioBase64'")
                    result = transcribe_audio(model, audio_path)
                response = {"id": request_id, "ok": True, "result": result}
            else:
                raise ValueError(f"Unsupported action: {action}")
        except Exception as exc:  # noqa: BLE001
            response = {"id": request_id, "ok": False, "error": str(exc)}

        print(json.dumps(response, ensure_ascii=False), flush=True)

    return 0


def main() -> int:
    args = parse_args()

    if not os.path.exists(args.model):
        raise FileNotFoundError(
            f"ASR model path not found: {args.model}. DingoFlow requires a local faster-whisper model."
        )

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        local_files_only=True,
    )

    if args.serve:
        return serve_loop(model, framed_io=args.framed_io)

    if not args.audio:
        raise ValueError("--audio is required unless --serve is enabled")

    result = transcribe_audio(model, args.audio)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
