#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prepare_review.py — Gera o diff costurado para revisão usando diff-tool.py e
copia para a área de transferência (clipboard) junto com o prompt padrão de revisão.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROMPT_TEXT = (
    "Me ajude a revisar este codigo procurando por problemas P0 e P1, e regressoes.\n"
    "Alem disso procure por melhorias em readability, manutenability, e scalability.\n"
    "Garanta que não haja regressões em CLS, FCP, LCP, TTFB, e similares.\n"
    "Depois me diga se voce aprovaria ou não este PR (de uma nota de 0 a  10 onde 10 é 'aprovo incondicionalmente' e 0 é 'pessimo/bugado')\n"
    "Me devolva a avaliação em formato .md para que eu possa apenas copiar e colar."
)

def copy_to_clipboard_windows(text: str) -> bool:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".txt") as f:
        f.write(text)
        temp_path = f.name
    try:
        cmd = [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0] | Set-Clipboard",
            temp_path,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            sys.stderr.write(f"Aviso ao copiar para o clipboard: {res.stderr}\n")
            return False
        return True
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass

def main():
    script_dir = Path(__file__).parent.resolve()
    diff_tool = script_dir / "diff-tool.py"
    if not diff_tool.exists():
        sys.stderr.write(f"diff-tool.py não encontrado em {diff_tool}\n")
        sys.exit(1)

    diff_args = sys.argv[1:]
    if not diff_args:
        diff_args = ["HEAD", "--untracked"]

    proc = subprocess.run(
        [sys.executable, str(diff_tool)] + diff_args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace"
    )

    if proc.returncode != 0:
        sys.stderr.write(f"Erro executando diff-tool.py:\n{proc.stderr}\n")
        sys.exit(proc.returncode)

    diff_output = proc.stdout
    full_payload = f"{PROMPT_TEXT}\n\n{diff_output}"

    ok = copy_to_clipboard_windows(full_payload)
    if ok:
        print("Prompt de revisão e diff copiados com sucesso para o clipboard!")
        print(f"Total de caracteres copiados: {len(full_payload):,}")
    else:
        print("Falha ao copiar para o clipboard.")
        sys.exit(1)

if __name__ == "__main__":
    main()
