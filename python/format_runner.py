#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from typing import Any, Dict

from mlx_lm import generate, load


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run offline formatting with MLX model")
    parser.add_argument("--model", required=True, help="Local path to MLX model")
    parser.add_argument("--max-tokens", type=int, default=240)
    parser.add_argument("--serve", action="store_true", help="Run as a persistent JSONL worker")
    return parser.parse_args()


def load_input() -> dict:
    payload = json.loads(sys.stdin.read())
    if "prompt" not in payload:
        raise ValueError("Missing prompt in stdin payload")
    return payload


def extract_final(text: str) -> str:
    match = re.search(r"<final>([\s\S]*?)</final>", text, flags=re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return text.strip()


def run_format(model: Any, tokenizer: Any, prompt: str, max_tokens: int) -> Dict[str, str]:
    generated = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=max_tokens,
        verbose=False,
    )

    return {"text": extract_final(generated)}


def serve_loop(model: Any, tokenizer: Any, default_max_tokens: int) -> int:
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        request_id = None

        try:
            payload = json.loads(raw)
            request_id = payload.get("id")
            action = payload.get("action", "format")

            if action == "warmup":
                response = {"id": request_id, "ok": True, "result": {"ready": True}}
            elif action == "format":
                prompt = payload.get("prompt")
                max_tokens = payload.get("maxTokens", default_max_tokens)

                if not isinstance(prompt, str) or not prompt.strip():
                    raise ValueError("Missing required string field 'prompt'")

                if not isinstance(max_tokens, int):
                    raise ValueError("Field 'maxTokens' must be an integer")

                result = run_format(model, tokenizer, prompt, max_tokens)
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
            f"Formatter model path not found: {args.model}. DingoFlow requires a local MLX model."
        )

    model, tokenizer = load(args.model)

    if args.serve:
        return serve_loop(model, tokenizer, args.max_tokens)

    payload = load_input()
    prompt = payload["prompt"]

    result = run_format(model, tokenizer, prompt, args.max_tokens)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
