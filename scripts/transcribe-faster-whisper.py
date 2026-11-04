"""Worker do faster-whisper chamado pelo bot.

Recebe um WAV 16 kHz mono e devolve JSON com os segmentos. Roda no venv
.tools/py312 (o Python global do Windows pode não ter as wheels); o
caminho do python é resolvido pelo TypeScript.

Uso:
  python transcribe-faster-whisper.py <wav> <modelo> <idioma|auto> <vad 1|0> <saida.json>
"""
import json
import sys


def main() -> int:
    if len(sys.argv) < 6:
        print("uso: transcribe-faster-whisper.py <wav> <modelo> <idioma> <vad> <saida>", file=sys.stderr)
        return 2
    wav, model_id, language, vad, out_path = sys.argv[1:6]
    from faster_whisper import WhisperModel

    model = WhisperModel(model_id, device="cpu", compute_type="int8")
    kwargs = {
        "vad_filter": vad == "1",
        "beam_size": 5,
        # Sem condicionar no texto anterior: em áudio de jogo (tiros/gritos)
        # o modelo entra em loop de alucinação e repete a última frase.
        "condition_on_previous_text": False,
    }
    if language and language.lower() != "auto":
        kwargs["language"] = language
    segments, info = model.transcribe(wav, **kwargs)
    data = {
        "language": getattr(info, "language", None),
        "segments": [],
    }
    for segment in segments:
        text = (segment.text or "").strip()
        if not text:
            continue
        data["segments"].append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": text,
            }
        )
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
