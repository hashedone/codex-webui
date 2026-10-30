#!/usr/bin/env python3
"""Long-lived, line-oriented Supertonic synthesis worker for the overlay."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--voice", default="F5")
    parser.add_argument("--lang", default="pl")
    args = parser.parse_args()

    os.environ["SUPERTONIC_CACHE_DIR"] = args.model_dir

    try:
        from supertonic import TTS

        tts = TTS(model="supertonic-3")
        voice_style = tts.get_voice_style(args.voice)
    except Exception as error:
        emit("fatal", message=str(error))
        return 1

    emit("ready", voice=args.voice, lang=args.lang)
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            text = request["text"]
            output = Path(request["output"])
            if not isinstance(text, str) or not text.strip():
                raise ValueError("text must be a non-empty string")
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary = output.with_name(f".{output.stem}.tmp{output.suffix}")
            temporary.unlink(missing_ok=True)
            wav, _ = tts.synthesize(
                text=text,
                voice_style=voice_style,
                total_steps=8,
                speed=1.05,
                lang=args.lang,
                verbose=False,
            )
            tts.save_audio(wav, temporary)
            temporary.replace(output)
            emit("done")
        except Exception as error:
            emit("error", message=str(error))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
