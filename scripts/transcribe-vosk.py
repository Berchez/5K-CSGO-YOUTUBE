"""Worker do Vosk chamado pelo bot.

Recebe um WAV 16 kHz mono e devolve JSON com as PALAVRAS e tempos; a
junção em blocos de legenda é feita no TypeScript (função pura testada).

Uso:
  python transcribe-vosk.py <wav> <pasta-do-modelo> <saida.json>
"""
import json
import sys
import wave


def main() -> int:
    if len(sys.argv) < 4:
        print("uso: transcribe-vosk.py <wav> <modelo> <saida>", file=sys.stderr)
        return 2
    wav_path, model_dir, out_path = sys.argv[1:4]
    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)
    with wave.open(wav_path, "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            print("WAV precisa ser mono 16-bit", file=sys.stderr)
            return 3
        recognizer = KaldiRecognizer(Model(model_dir), wav.getframerate())
        recognizer.SetWords(True)
        words = []
        while True:
            chunk = wav.readframes(4000)
            if len(chunk) == 0:
                break
            if recognizer.AcceptWaveform(chunk):
                words.extend(_words_of(recognizer.Result()))
        words.extend(_words_of(recognizer.FinalResult()))
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"language": "pt", "words": words}, handle, ensure_ascii=False)
    return 0


def _words_of(raw: str) -> list:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    out = []
    for item in data.get("result", []):
        text = str(item.get("word", "")).strip()
        if not text:
            continue
        out.append(
            {
                "start": float(item.get("start", 0.0)),
                "end": float(item.get("end", 0.0)),
                "text": text,
            }
        )
    return out


if __name__ == "__main__":
    raise SystemExit(main())
