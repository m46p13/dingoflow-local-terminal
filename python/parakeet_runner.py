#!/usr/bin/env python3
import argparse
import base64
import json
import os
import struct
import sys
import tempfile
import time
import wave
from typing import Any, Dict, Optional

import mlx.core as mx
import mlx.nn as nn
import numpy as np
from parakeet_mlx import DecodingConfig, Greedy, from_pretrained
from parakeet_mlx.utils import from_config

STREAM_CONTEXT_SIZE = (64, 8)
STREAM_DEPTH = 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run offline ASR with parakeet-mlx")
    parser.add_argument("--audio", help="Path to wav file (single-run mode)")
    parser.add_argument("--model", required=True, help="Local path to parakeet-mlx model")
    parser.add_argument("--serve", action="store_true", help="Run as a persistent JSONL worker")
    parser.add_argument(
        "--dtype",
        choices=["bfloat16", "float16", "float32"],
        default="bfloat16",
        help="Model weight dtype",
    )
    parser.add_argument(
        "--framed-io",
        action="store_true",
        help="Use framed stdin/stdout protocol (uint32 json_len, uint32 audio_len, json, audio)",
    )
    return parser.parse_args()


def parse_dtype(value: str) -> Any:
    mapping = {
        "bfloat16": mx.bfloat16,
        "float16": mx.float16,
        "float32": mx.float32,
    }
    return mapping[value]


def load_local_model(model_path: str, dtype: Any) -> Any:
    config_path = os.path.join(model_path, "config.json")
    weights_path = os.path.join(model_path, "model.safetensors")

    if not os.path.exists(config_path) or not os.path.exists(weights_path):
        raise FileNotFoundError(
            f"Invalid parakeet model directory: {model_path}. Missing config.json or model.safetensors."
        )

    with open(config_path, "r", encoding="utf-8") as config_file:
        config = json.load(config_file)

    quantization = config.get("quantization")
    if isinstance(quantization, dict):
        bits = quantization.get("bits")
        group_size = quantization.get("group_size")
        if not isinstance(bits, int) or not isinstance(group_size, int):
            raise ValueError("Quantized model config must include integer quantization.bits and quantization.group_size")

        model = from_config(config)
        nn.quantize(model, bits=bits, group_size=group_size)
        model.load_weights(weights_path)
        return model

    return from_pretrained(model_path, dtype=dtype)


def transcribe_audio(model: Any, audio_path: str) -> Dict[str, Any]:
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    started = time.time()
    result = model.transcribe(
        audio_path,
        chunk_duration=None,
        decoding_config=DecodingConfig(decoding=Greedy()),
    )
    text = result.text.strip()

    return {
        "text": text,
        "language": "en",
        "durationSeconds": round(time.time() - started, 3),
    }


def transcribe_pcm16(model: Any, pcm_bytes: bytes, sample_rate: int) -> Dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
        temp_path = temp_file.name

    try:
        with wave.open(temp_path, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm_bytes)

        return transcribe_audio(model, temp_path)
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


class StreamingState:
    def __init__(self, model: Any):
        self.model = model
        self.stream = None
        self.last_finalized_index = 0
        self.sample_rate: Optional[int] = None

    def reset(
        self,
        sample_rate: int,
        context_left: int = STREAM_CONTEXT_SIZE[0],
        context_right: int = STREAM_CONTEXT_SIZE[1],
        depth: int = STREAM_DEPTH,
    ) -> None:
        self.close()

        model_rate = int(getattr(self.model.preprocessor_config, "sample_rate", 16000))
        if sample_rate != model_rate:
            raise ValueError(
                f"sampleRate mismatch: expected {model_rate} for current model, got {sample_rate}"
            )

        stream = self.model.transcribe_stream(
            context_size=(context_left, context_right),
            depth=depth,
            decoding_config=DecodingConfig(decoding=Greedy()),
        )
        self.stream = stream.__enter__()
        self.last_finalized_index = 0
        self.sample_rate = sample_rate

    def push(self, pcm_bytes: bytes, sample_rate: int) -> Dict[str, Any]:
        if self.stream is None:
            self.reset(sample_rate)

        if self.sample_rate != sample_rate:
            raise ValueError(
                f"stream sampleRate changed from {self.sample_rate} to {sample_rate}; reset stream first"
            )

        started = time.time()
        audio = np.frombuffer(pcm_bytes, np.int16).astype(np.float32) / 32768.0
        self.stream.add_audio(mx.array(audio))

        finalized_tokens = self.stream.finalized_tokens
        delta_tokens = finalized_tokens[self.last_finalized_index :]
        self.last_finalized_index = len(finalized_tokens)
        text = "".join(token.text for token in delta_tokens).strip()

        return {
            "text": text,
            "language": "en",
            "durationSeconds": round(time.time() - started, 3),
        }

    def flush(self) -> Dict[str, Any]:
        if self.stream is None:
            return {"text": "", "language": "en", "durationSeconds": 0.0}

        started = time.time()
        finalized_tokens = self.stream.finalized_tokens
        new_finalized_tokens = finalized_tokens[self.last_finalized_index :]
        self.last_finalized_index = len(finalized_tokens)

        draft_tokens = self.stream.draft_tokens
        text = (
            "".join(token.text for token in new_finalized_tokens)
            + "".join(token.text for token in draft_tokens)
        ).strip()

        return {
            "text": text,
            "language": "en",
            "durationSeconds": round(time.time() - started, 3),
        }

    def close(self) -> None:
        if self.stream is not None:
            self.stream.__exit__(None, None, None)
            self.stream = None

        self.last_finalized_index = 0
        self.sample_rate = None


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


def serve_loop(model: Any, framed_io: bool = False) -> int:
    streaming = StreamingState(model)

    try:
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
                    elif action == "stream_reset":
                        sample_rate = payload.get("sampleRate", 16000)
                        if not isinstance(sample_rate, int):
                            raise ValueError("Field 'sampleRate' must be an integer")
                        context_left = payload.get("contextLeft", STREAM_CONTEXT_SIZE[0])
                        context_right = payload.get("contextRight", STREAM_CONTEXT_SIZE[1])
                        depth = payload.get("depth", STREAM_DEPTH)
                        if not isinstance(context_left, int) or not isinstance(context_right, int):
                            raise ValueError("Fields 'contextLeft' and 'contextRight' must be integers")
                        if not isinstance(depth, int):
                            raise ValueError("Field 'depth' must be an integer")
                        streaming.reset(
                            sample_rate,
                            context_left=context_left,
                            context_right=context_right,
                            depth=depth,
                        )
                        response = {"id": request_id, "ok": True, "result": {"ready": True}}
                    elif action == "stream_push":
                        sample_rate = payload.get("sampleRate", 16000)
                        if not isinstance(sample_rate, int):
                            raise ValueError("Field 'sampleRate' must be an integer")
                        if framed_audio is None or len(framed_audio) == 0:
                            raise ValueError("Missing binary audio payload for stream_push")
                        result = streaming.push(framed_audio, sample_rate)
                        response = {"id": request_id, "ok": True, "result": result}
                    elif action == "stream_flush":
                        result = streaming.flush()
                        response = {"id": request_id, "ok": True, "result": result}
                    elif action == "stream_close":
                        streaming.close()
                        response = {"id": request_id, "ok": True, "result": {"closed": True}}
                    elif action == "transcribe":
                        if framed_audio is not None and len(framed_audio) > 0:
                            sample_rate = payload.get("sampleRate", 16000)
                            if not isinstance(sample_rate, int):
                                raise ValueError("Field 'sampleRate' must be an integer")
                            result = transcribe_pcm16(model, framed_audio, sample_rate)
                        else:
                            audio_base64 = payload.get("audioBase64")
                            if isinstance(audio_base64, str) and audio_base64:
                                raw_audio = base64.b64decode(audio_base64)
                                if len(raw_audio) == 0:
                                    raise ValueError("Field 'audioBase64' decoded to empty audio")
                                sample_rate = payload.get("sampleRate", 16000)
                                if not isinstance(sample_rate, int):
                                    raise ValueError("Field 'sampleRate' must be an integer")
                                result = transcribe_pcm16(model, raw_audio, sample_rate)
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
                elif action == "stream_reset":
                    sample_rate = payload.get("sampleRate", 16000)
                    if not isinstance(sample_rate, int):
                        raise ValueError("Field 'sampleRate' must be an integer")
                    context_left = payload.get("contextLeft", STREAM_CONTEXT_SIZE[0])
                    context_right = payload.get("contextRight", STREAM_CONTEXT_SIZE[1])
                    depth = payload.get("depth", STREAM_DEPTH)
                    if not isinstance(context_left, int) or not isinstance(context_right, int):
                        raise ValueError("Fields 'contextLeft' and 'contextRight' must be integers")
                    if not isinstance(depth, int):
                        raise ValueError("Field 'depth' must be an integer")
                    streaming.reset(sample_rate, context_left=context_left, context_right=context_right, depth=depth)
                    response = {"id": request_id, "ok": True, "result": {"ready": True}}
                elif action == "stream_push":
                    sample_rate = payload.get("sampleRate", 16000)
                    if not isinstance(sample_rate, int):
                        raise ValueError("Field 'sampleRate' must be an integer")
                    audio_base64 = payload.get("audioBase64")
                    if not isinstance(audio_base64, str) or not audio_base64:
                        raise ValueError("Missing required string field 'audioBase64'")
                    raw_audio = base64.b64decode(audio_base64)
                    if len(raw_audio) == 0:
                        raise ValueError("Field 'audioBase64' decoded to empty audio")
                    result = streaming.push(raw_audio, sample_rate)
                    response = {"id": request_id, "ok": True, "result": result}
                elif action == "stream_flush":
                    result = streaming.flush()
                    response = {"id": request_id, "ok": True, "result": result}
                elif action == "stream_close":
                    streaming.close()
                    response = {"id": request_id, "ok": True, "result": {"closed": True}}
                elif action == "transcribe":
                    audio_base64 = payload.get("audioBase64")
                    if isinstance(audio_base64, str) and audio_base64:
                        raw_audio = base64.b64decode(audio_base64)
                        if len(raw_audio) == 0:
                            raise ValueError("Field 'audioBase64' decoded to empty audio")
                        sample_rate = payload.get("sampleRate", 16000)
                        if not isinstance(sample_rate, int):
                            raise ValueError("Field 'sampleRate' must be an integer")
                        result = transcribe_pcm16(model, raw_audio, sample_rate)
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
    finally:
        streaming.close()

    return 0


def main() -> int:
    args = parse_args()

    if not os.path.exists(args.model):
        raise FileNotFoundError(
            f"ASR model path not found: {args.model}. DingoFlow requires a local parakeet-mlx model."
        )

    model = load_local_model(args.model, dtype=parse_dtype(args.dtype))

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
