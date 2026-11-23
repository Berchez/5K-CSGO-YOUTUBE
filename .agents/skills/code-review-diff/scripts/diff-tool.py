#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ai-diff — diff "costurado" (woven) para revisão de código por IA sem harness.

Cada arquivo alterado aparece UMA única vez e completo. Linhas removidas (-) e
adicionadas (+) ficam exatamente no ponto onde a mudança ocorreu; o restante do
arquivo aparece como contexto (prefixo " ").

Como funciona:
  1. git diff --raw -z      -> lista exata de arquivos, status, modos e blobs
  2. git diff -U0           -> apenas as linhas alteradas, com posições exatas
  3. git cat-file --batch   -> conteúdo-base dos arquivos (um único processo)
  4. costura                -> percorre o arquivo-base e insere cada hunk no lugar

Requisitos: Python 3.8+ e git 2.x. Nenhuma dependência externa.
"""

import os
import posixpath
import re
import shlex
import subprocess
import sys

VERSION = "1.0.0"
PROG = "ai-diff"

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------

# Exclusões do --clean. São aplicadas como ":(top,glob,exclude)<padrão>":
#   top  -> relativo à raiz do repositório (funciona igual de qualquer subpasta)
#   glob -> "**/" casa zero ou mais diretórios, então "**/dist/**" também pega
#           "dist/" na raiz e "**/yarn.lock" pega lockfiles de monorepos.
CLEAN_EXCLUDES = (
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/__e2e__/**",
    "**/e2e/**",
    "**/tests/**",
    "**/test/**",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/bun.lockb",
    "**/bun.lock",
    "**/.next/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
)

# Opções do git diff que mudam o FORMATO da saída (quebrariam o parser).
BLOCKED_EXACT = frozenset((
    "-p", "-u", "--patch", "-s", "--no-patch", "-z", "--raw", "--binary",
    "--full-index", "--no-prefix", "--default-prefix", "--ext-diff", "--textconv",
    "--check", "--exit-code", "--quiet", "--name-only", "--name-status",
    "--summary", "--compact-summary", "--patch-with-raw", "--patch-with-stat",
    "--shortstat", "--numstat", "--cc", "-c", "--combined-all-paths",
))
BLOCKED_PREFIXES = (
    "--stat", "--dirstat", "--color", "--word-diff", "--src-prefix",
    "--dst-prefix", "--line-prefix", "--output-indicator", "--abbrev", "-X",
)

STATUS_WORDS = {
    "M": "modified", "A": "added", "D": "deleted", "R": "renamed",
    "C": "copied", "T": "type changed", "U": "unmerged", "X": "unknown",
}

HELP = """\
ai-diff {version} — diff completo e "costurado" para revisão de código por IA.

USO
  ai-diff [opções] [<revisões>] [--] [<pathspec>...]

REVISÕES (mesma semântica do git diff)
  (nada)                  alterações não staged          (index -> working tree)
  --cached | --staged     alterações staged              (HEAD -> index)
  <commit>                <commit> -> estado atual        (working tree)
  <a> <b>  |  <a>..<b>    <a> -> <b>
  <a>...<b>               merge-base(<a>, <b>) -> <b>      (o que <b> introduziu)
  --merge-base <a> [<b>]  idem, explicitando o merge-base
  Commits, branches, tags, HEAD~3, @{{u}} etc. são aceitos.

OPÇÕES
  --clean                 exclui testes, lockfiles e saídas de build
  --untracked             inclui arquivos não rastreados como "added"
                          (só quando o alvo é o working tree)
  -o, --output <arquivo>  grava o resultado em <arquivo> (UTF-8)
  -U<n>, --unified=<n>    mantém só <n> linhas de contexto em volta de cada
                          mudança e recolhe o resto (padrão: arquivo inteiro)
  --line-numbers          prefixa cada linha com seu número
  --no-summary            omite o cabeçalho (resumo, legenda, índice)
  --no-markers            omite as linhas "@@ change k/n ... @@"
  --no-symbols            omite símbolos afetados e relações entre arquivos
  --no-log                omite a lista de commits do intervalo
  -h, --help              mostra esta ajuda
  --version               mostra a versão

Opções do git diff que filtram ou ajustam a comparação são repassadas ao git
(ex.: -M50%, --no-renames, --diff-filter=AM, -w, --patience, --relative, -R).
Opções que mudam o formato de saída (--stat, --name-only, --color...) são
ignoradas com um aviso.

EXEMPLOS
  ai-diff f3ff96f
  ai-diff main..damto-380 --clean -o review.txt
  ai-diff main...HEAD --clean -- src/ ':!src/generated'
  ai-diff --cached
  ai-diff HEAD --untracked -U20
"""


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

class GitError(Exception):
    pass


def die(msg, code=2):
    sys.stderr.write(f"{PROG}: erro: {msg}\n")
    sys.exit(code)


def warn(msg):
    sys.stderr.write(f"{PROG}: aviso: {msg}\n")


def run_git(args, check=True):
    try:
        proc = subprocess.run(["git"] + list(args),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        die("git não encontrado no PATH.")
    if check and proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise GitError(err or "git " + " ".join(args) + " falhou")
    return proc.stdout


def is_zero(sha):
    return not sha or set(sha) <= {"0"}


def decode_path(b):
    return b.decode("utf-8", "replace")


def dec(b):
    s = b.decode("utf-8", "replace")
    return s[:-1] if s.endswith("\r") else s


def split_lines(data):
    if not data:
        return []
    lines = data.split(b"\n")
    if lines[-1] == b"":
        lines.pop()
    return lines


def human_size(n):
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def truncate(s, n):
    s = s.strip()
    return s if len(s) <= n else s[: n - 3].rstrip() + "..."


def c_quote(path_bytes):
    """Forma C-quoted que o git usa em cabeçalhos para caminhos 'estranhos'."""
    out = []
    for ch in path_bytes:
        c = chr(ch)
        if c == '"':
            out.append('\\"')
        elif c == "\\":
            out.append("\\\\")
        elif c == "\t":
            out.append("\\t")
        elif c == "\n":
            out.append("\\n")
        elif ch < 0x20 or ch == 0x7F:
            out.append("\\%03o" % ch)
        else:
            out.append(c)
    return "".join(out).encode("latin-1", "replace")


# ---------------------------------------------------------------------------
# Linha de comando
# ---------------------------------------------------------------------------

class Options:
    def __init__(self):
        self.clean = False
        self.untracked = False
        self.output = None
        self.unified = None
        self.line_numbers = False
        self.summary = True
        self.markers = True
        self.symbols = True
        self.log = True


def parse_int(value, flag):
    if value is None or not value.isdigit():
        die(f"{flag} espera um número inteiro >= 0.")
    return int(value)


def parse_cli(argv):
    o = Options()
    git_opts, positionals, pathspecs = [], [], []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            pathspecs = list(argv[i + 1:])
            break
        if a in ("-h", "--help"):
            sys.stdout.write(HELP.format(version=VERSION))
            sys.exit(0)
        elif a == "--version":
            sys.stdout.write(f"{PROG} {VERSION}\n")
            sys.exit(0)
        elif a == "--clean":
            o.clean = True
        elif a == "--untracked":
            o.untracked = True
        elif a in ("-o", "--output"):
            i += 1
            if i >= len(argv):
                die(f"{a} exige um caminho de arquivo.")
            o.output = argv[i]
        elif a.startswith("--output="):
            o.output = a.split("=", 1)[1]
        elif a in ("-U", "--unified"):
            if i + 1 < len(argv) and argv[i + 1].isdigit():
                i += 1
                o.unified = int(argv[i])
            else:
                o.unified = 3
        elif a.startswith("--unified="):
            o.unified = parse_int(a.split("=", 1)[1], "--unified")
        elif a.startswith("-U"):
            o.unified = parse_int(a[2:], "-U")
        elif a == "--line-numbers":
            o.line_numbers = True
        elif a == "--no-summary":
            o.summary = False
        elif a == "--no-markers":
            o.markers = False
        elif a == "--no-symbols":
            o.symbols = False
        elif a == "--no-log":
            o.log = False
        elif a == "--no-index":
            die("--no-index não é suportado: o ai-diff compara estados do repositório.")
        elif a.startswith("-") and a != "-":
            if a in BLOCKED_EXACT or a.startswith(BLOCKED_PREFIXES):
                warn(f"opção de formato ignorada: {a}")
            else:
                git_opts.append(a)
        else:
            positionals.append(a)
        i += 1
    return o, git_opts, positionals, pathspecs


def rev_resolves(name):
    if not name:  # lado vazio de um range ("main..") significa HEAD
        return True
    out = run_git(["rev-parse", "--verify", "-q", name + "^{commit}"], check=False)
    return bool(out.strip())


def classify_positionals(positionals):
    """Separa revisões de caminhos, como o git faz, mas com mensagens claras."""
    revs, paths = [], []
    for tok in positionals:
        exists = os.path.exists(tok)
        looks_like_spec = tok.startswith(":") or any(c in tok for c in "*?[")
        if not exists and ("..." in tok or ".." in tok):
            parts = tok.split("...", 1) if "..." in tok else tok.split("..", 1)
            if not all(rev_resolves(p) for p in parts):
                die(f"intervalo inválido: '{tok}' (alguma ref não existe).")
            revs.append(tok)
            continue
        is_rev = bool(run_git(["rev-parse", "--verify", "-q", tok + "^{object}"],
                              check=False).strip())
        if is_rev and exists:
            die(f"'{tok}' é ao mesmo tempo uma revisão e um caminho; "
                f"use '--' para separar (ex.: {PROG} {tok} -- <caminhos>).")
        if is_rev:
            revs.append(tok)
        elif exists or looks_like_spec:
            paths.append(tok)
        else:
            die(f"'{tok}' não é uma revisão válida nem um caminho existente.")
    if len(revs) > 2:
        die("informe no máximo duas revisões (ou um intervalo).")
    return revs, paths


def is_exclude_spec(p):
    if p.startswith((":!", ":^")):
        return True
    return p.startswith(":(") and "exclude" in p.split(")", 1)[0]


# ---------------------------------------------------------------------------
# Leitura da saída do git
# ---------------------------------------------------------------------------

class Entry:
    __slots__ = ("status", "score", "old_mode", "new_mode", "old_sha",
                 "new_sha", "src", "dst", "untracked")

    def __init__(self, status, score, old_mode, new_mode, old_sha, new_sha,
                 src, dst, untracked=False):
        self.status, self.score = status, score
        self.old_mode, self.new_mode = old_mode, new_mode
        self.old_sha, self.new_sha = old_sha, new_sha
        self.src, self.dst = src, dst
        self.untracked = untracked


def parse_raw(data):
    toks = data.split(b"\0")
    entries, i, n = [], 0, len(toks)
    while i < n:
        t = toks[i]
        if not t.startswith(b":") or t.startswith(b"::"):
            i += 1
            continue
        meta = t[1:].decode("ascii", "replace").split()
        if len(meta) < 5 or i + 1 >= n:
            i += 1
            continue
        old_mode, new_mode, old_sha, new_sha, st = meta[:5]
        letter = st[0]
        score = int(st[1:]) if st[1:].isdigit() else None
        if letter in "RC" and i + 2 < n:
            src, dst = toks[i + 1], toks[i + 2]
            i += 3
        else:
            src = dst = toks[i + 1]
            i += 2
        entries.append(Entry(letter, score, old_mode, new_mode, old_sha, new_sha, src, dst))
    return entries


HUNK_RE = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class Hunk:
    __slots__ = ("old_start", "old_count", "new_start", "new_count", "lines", "start", "end")

    def __init__(self, old_start, old_count, new_start, new_count, lines=None):
        self.old_start, self.old_count = old_start, old_count
        self.new_start, self.new_count = new_start, new_count
        self.lines = lines if lines is not None else []  # [sinal, bytes, sem_newline]
        self.start = self.end = 0  # intervalo dentro da visão costurada


def split_patch(data):
    sections, cur = [], None
    for line in data.split(b"\n"):
        if line.startswith(b"diff --git "):
            cur = [line]
            sections.append(cur)
        elif line.startswith((b"diff --cc ", b"diff --combined ", b"* Unmerged path ")):
            cur = None
        elif cur is not None:
            cur.append(line)
    return sections


def parse_section(lines):
    hunks, binary = [], False
    cur, rem_old, rem_new = None, 0, 0
    for line in lines[1:]:
        if cur is not None and (rem_old > 0 or rem_new > 0):
            c = line[:1]
            if c == b"-":
                cur.lines.append(["-", line[1:], False])
                rem_old -= 1
                continue
            if c == b"+":
                cur.lines.append(["+", line[1:], False])
                rem_new -= 1
                continue
            if c == b" " or line == b"":
                cur.lines.append([" ", line[1:], False])
                rem_old -= 1
                rem_new -= 1
                continue
            if c == b"\\":
                if cur.lines:
                    cur.lines[-1][2] = True
                continue
            rem_old = rem_new = 0
        if line.startswith(b"@@"):
            m = HUNK_RE.match(line)
            if m:
                oc = int(m.group(2)) if m.group(2) is not None else 1
                nc = int(m.group(4)) if m.group(4) is not None else 1
                cur = Hunk(int(m.group(1)), oc, int(m.group(3)), nc)
                hunks.append(cur)
                rem_old, rem_new = oc, nc
            continue
        if line.startswith(b"\\") and cur is not None and cur.lines:
            cur.lines[-1][2] = True
        elif cur is None and line.startswith((b"Binary files ", b"GIT binary patch")):
            binary = True
    return hunks, binary


def header_matches(header, entry):
    return entry.dst in header or c_quote(entry.dst) in header


def pair_sections(entries, sections):
    """Associa entradas do --raw às seções do patch (mesma ordem no git)."""
    result, j = [], 0
    for e in entries:
        if e.status == "U":
            result.append((e, []))
            continue
        if j >= len(sections) or not header_matches(sections[j][0], e):
            return None
        secs = [sections[j]]
        j += 1
        # type change (ex.: arquivo -> symlink) gera duas seções para o mesmo caminho
        while e.status == "T" and j < len(sections) and header_matches(sections[j][0], e):
            secs.append(sections[j])
            j += 1
        result.append((e, secs))
    return result if j == len(sections) else None


def merge_sections(secs):
    hunks, binary = [], False
    for s in secs:
        h, b = parse_section(s)
        hunks.extend(h)
        binary = binary or b
    if len(secs) > 1:  # type change: tudo removido e depois tudo adicionado
        lines = [l for h in hunks for l in h.lines if l[0] == "-"] + \
                [l for h in hunks for l in h.lines if l[0] == "+"]
        minus = sum(1 for l in lines if l[0] == "-")
        plus = len(lines) - minus
        hunks = [Hunk(1 if minus else 0, minus, 1 if plus else 0, plus, lines)] if lines else []
    return hunks, binary


class BlobStore:
    """Lê blobs com um único `git cat-file --batch` (eficiente em repos grandes)."""

    def __init__(self):
        self.proc = None

    def read(self, sha):
        if is_zero(sha):
            return None
        try:
            if self.proc is None:
                self.proc = subprocess.Popen(["git", "cat-file", "--batch"],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.proc.stdin.write(sha.encode("ascii") + b"\n")
            self.proc.stdin.flush()
            header = self.proc.stdout.readline().split()
            if len(header) != 3:
                return None
            left, chunks = int(header[2]), []
            while left > 0:
                b = self.proc.stdout.read(left)
                if not b:
                    break
                chunks.append(b)
                left -= len(b)
            self.proc.stdout.read(1)  # LF final do formato --batch
            return b"".join(chunks)
        except (OSError, ValueError):
            return None

    @staticmethod
    def size(sha):
        if is_zero(sha):
            return None
        out = run_git(["cat-file", "-s", sha], check=False).strip()
        return int(out) if out.isdigit() else None

    def close(self):
        if self.proc is not None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()


# ---------------------------------------------------------------------------
# Linguagens
# ---------------------------------------------------------------------------

LANGUAGES = {
    ".ts": ("TypeScript", "js"), ".mts": ("TypeScript", "js"), ".cts": ("TypeScript", "js"),
    ".tsx": ("TypeScript (TSX)", "js"), ".js": ("JavaScript", "js"),
    ".mjs": ("JavaScript", "js"), ".cjs": ("JavaScript", "js"),
    ".jsx": ("JavaScript (JSX)", "js"), ".vue": ("Vue", "js"),
    ".svelte": ("Svelte", "js"), ".astro": ("Astro", "js"),
    ".py": ("Python", "py"), ".pyi": ("Python", "py"),
    ".go": ("Go", "go"), ".rs": ("Rust", "rust"),
    ".java": ("Java", "clike"), ".kt": ("Kotlin", "clike"), ".kts": ("Kotlin", "clike"),
    ".scala": ("Scala", "clike"), ".swift": ("Swift", "clike"), ".dart": ("Dart", "clike"),
    ".cs": ("C#", "clike"), ".c": ("C", "clike"), ".h": ("C/C++ header", "clike"),
    ".cpp": ("C++", "clike"), ".cc": ("C++", "clike"), ".cxx": ("C++", "clike"),
    ".hpp": ("C++", "clike"), ".hh": ("C++", "clike"), ".m": ("Objective-C", "clike"),
    ".mm": ("Objective-C++", "clike"), ".php": ("PHP", "clike"), ".lua": ("Lua", "clike"),
    ".groovy": ("Groovy", "clike"), ".gradle": ("Gradle", "clike"),
    ".rb": ("Ruby", "rb"), ".rake": ("Ruby", "rb"), ".ex": ("Elixir", "rb"),
    ".exs": ("Elixir", "rb"),
    ".sh": ("Shell", "sh"), ".bash": ("Shell", "sh"), ".zsh": ("Shell", "sh"),
    ".css": ("CSS", "css"), ".scss": ("SCSS", "css"), ".sass": ("Sass", "css"),
    ".less": ("Less", "css"),
    ".md": ("Markdown", "md"), ".mdx": ("MDX", "md"), ".markdown": ("Markdown", "md"),
    ".yaml": ("YAML", "yaml"), ".yml": ("YAML", "yaml"),
    ".json": ("JSON", "json"), ".jsonc": ("JSON", "json"), ".json5": ("JSON5", "json"),
    ".toml": ("TOML", "toml"), ".ini": ("INI", "toml"), ".cfg": ("INI", "toml"),
    ".graphql": ("GraphQL", "schema"), ".gql": ("GraphQL", "schema"),
    ".prisma": ("Prisma", "schema"), ".proto": ("Protobuf", "schema"),
    ".tf": ("Terraform", "hcl"), ".tfvars": ("Terraform", "hcl"), ".hcl": ("HCL", "hcl"),
    ".html": ("HTML", None), ".htm": ("HTML", None), ".xml": ("XML", None),
    ".svg": ("SVG", None), ".sql": ("SQL", None), ".txt": ("Text", None),
    ".csv": ("CSV", None),
}

FILENAMES = {
    "makefile": ("Makefile", "make"), "gnumakefile": ("Makefile", "make"),
    "justfile": ("Justfile", "make"), "jenkinsfile": ("Groovy", "clike"),
    "gemfile": ("Ruby", "rb"), "rakefile": ("Ruby", "rb"),
}


def detect_language(path):
    low = posixpath.basename(path).lower()
    if low in FILENAMES:
        return FILENAMES[low]
    if low.startswith("dockerfile") or low.endswith(".dockerfile"):
        return ("Dockerfile", None)
    if low.startswith(".env"):
        return ("dotenv", None)
    ext = posixpath.splitext(low)[1]
    if ext in LANGUAGES:
        return LANGUAGES[ext]
    return (ext[1:] if ext else "text", None)


# ---------------------------------------------------------------------------
# Detecção de símbolos (heurística leve, sem dependências)
# ---------------------------------------------------------------------------

_ID = r"[A-Za-z_$][\w$]*"
JS_KEYWORDS = frozenset(
    "if for while switch catch with return function else do try typeof new await "
    "yield super throw case delete void import export in of instanceof finally".split())
JS_DECLS = (
    ("class", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+(" + _ID + ")")),
    ("interface", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?interface\s+(" + _ID + ")")),
    ("enum", re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(" + _ID + ")")),
    ("type", re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?type\s+(" + _ID + r")\s*(?:<.*>)?\s*=")),
    ("namespace", re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+(" + _ID + r"(?:\." + _ID + r")*)\s*\{")),
    ("function", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*(" + _ID + ")")),
    ("const", re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(" + _ID + r")\s*(?::(?:[^=]|=>)*?)?=(?![>=])")),
)
# lado direito de "const x =" que é diretamente uma função (e não uma chamada com callback)
JS_RHS_FN = re.compile(r"\s*(?:async\s+)?(?:function\b|(?:<[^>]*>\s*)?\([^)]*\)\s*(?::[^=]+)?=>|(?:<[^>]*>\s*)?\(\s*$|" + _ID + r"\s*=>)")
JS_FN_OPENER = re.compile(r"=>\s*[{(]\s*$|\bfunction\b.*\{\s*$")
JS_METHOD = re.compile(r"^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|accessor|get|set)\s+)*\*?\s*(#?" + _ID + r")\s*[?!]?\s*(?:<[^>]*>)?\s*\(")
JS_CLASS_FIELD_FN = re.compile(r"^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?" + _ID + r")\s*[?!]?\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\(|" + _ID + r"\s*=>)")
JS_OBJ_FN = re.compile(r"^\s*(" + _ID + r")\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|" + _ID + r"\s*=>)")
JS_SHORTHAND = re.compile(r"^\s*(?:async\s+)?\*?\s*(" + _ID + r")\s*\([^()]*\)\s*(?::[^{]+)?\{\s*$")
JS_CALL = re.compile(r"^\s*(?:await\s+)?(" + _ID + r"(?:\??\." + _ID + r")*)\s*\(\s*(?:(['\"`])([^'\"`]{0,60})\2)?")

PY_DEF = re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)")
PY_CLASS = re.compile(r"^\s*class\s+([A-Za-z_]\w*)")
GO_FUNC = re.compile(r"^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*([\w.]+)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)")
GO_TYPE = re.compile(r"^\s*type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b")
RS_FN = re.compile(r'^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)')
RS_ITEM = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union|mod)\s+([A-Za-z_]\w*)")
RS_IMPL = re.compile(r"^\s*(?:unsafe\s+)?impl\b(?:\s*<[^>]*>)?\s+([^{]+?)\s*(?:where\b[^{]*)?\{?\s*$")
CL_TYPE = re.compile(r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|export|inline|value|annotation|inner|enum|case|fileprivate|readonly|unsafe|ref|override|non-sealed|strictfp)\s+)*(class|interface|enum|record|struct|trait|object|protocol|extension|namespace|union|actor|mixin)\s+([A-Za-z_][\w.:]*)")
CL_FUNC_KW = re.compile(r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|override|open|suspend|inline|async|virtual|extern|unsafe|mutating|nonmutating|fileprivate|operator|infix|tailrec|external|local|export|convenience|required|dynamic|class)\s+)*(?:fun|func|def|function)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?&?([A-Za-z_]\w*)")
CL_FUNC_TYPED = re.compile(r"^\s*(?:[\w:<>,\[\]?*&.]+\s+)+[*&]*\s*([A-Za-z_~][\w:~]*)\s*\([^;]*$")
CL_STMT = frozenset(
    "return new else throw case goto delete await yield if for foreach while switch "
    "catch using lock sizeof typeof do try echo print package import".split())
RB_DEF = re.compile(r"^\s*(?:def|defp|defmacro|defmacrop)\s+(?:self\.)?([\w?!=\[\]<>+*/%-]+)")
RB_MOD = re.compile(r"^\s*(class|module|defmodule|defprotocol|defimpl)\s+([\w:.]+)")
SH_FUNC = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\s*\)|^\s*function\s+([A-Za-z_][\w:.-]*)")
CSS_RULE = re.compile(r"^\s*([^\s{};/][^{};]*?)\s*\{\s*$")
YAML_KEY = re.compile(r"""^\s*(-\s+)?(?:"([^"]+)"|'([^']+)'|([^\s#'"\-?:,\[\]{}&*!|>%@`][^#:]*?))\s*:(?:\s+(.*))?$""")
JSON_KEY = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*:')
SCHEMA_DECL = re.compile(r"^\s*(?:extend\s+)?(type|input|interface|enum|union|scalar|query|mutation|subscription|fragment|schema|directive|model|view|datasource|generator|message|service|rpc)\s+@?([A-Za-z_]\w*)")
HCL_BLOCK = re.compile(r'^\s*(resource|data|module|variable|output|provider|locals|terraform|backend|dynamic|moved|import|check)\b\s*((?:"[^"]*"\s*)*)\{')
MAKE_TARGET = re.compile(r"^([A-Za-z0-9_.%/$(){}-][^:=#\t]*?)\s*::?(?!=)")
MD_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
TOML_TABLE = re.compile(r"^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(?:[#;].*)?$")

FN_KINDS = frozenset(("function", "method", "call"))
TYPE_KINDS = frozenset(("class", "interface", "struct", "trait", "object", "protocol",
                        "extension", "record", "enum", "impl", "actor", "mixin"))


def det_js(line, s, parent, in_fn=False):
    for kind, rx in JS_DECLS:
        m = rx.match(line)
        if m:
            if kind == "const":
                if JS_RHS_FN.match(line, m.end()):
                    kind = "function"
                elif in_fn:
                    return None  # variável local: não é um escopo relevante
            return kind, m.group(1)
    if parent in ("class", "interface"):
        m = JS_CLASS_FIELD_FN.match(line) or JS_METHOD.match(line)
        if m and m.group(1) not in JS_KEYWORDS:
            return "method", m.group(1)
        return None
    m = JS_OBJ_FN.match(line)
    if m:
        return "method", m.group(1)
    m = JS_SHORTHAND.match(line)
    if m and m.group(1) not in JS_KEYWORDS:
        return "method", m.group(1)
    if ("=>" in line or "function" in line) and s.endswith(("{", "(", "[")):
        m = JS_CALL.match(line)
        if m and m.group(1).split(".")[0] not in JS_KEYWORDS:
            if m.group(3) is not None:
                q = m.group(2)
                return "call", f"{m.group(1)}({q}{m.group(3)}{q})"
            return "call", f"{m.group(1)}(...)"
    return None


def det_py(line, s, parent, in_fn=False):
    m = PY_DEF.match(line)
    if m:
        return ("method" if parent == "class" else "function"), m.group(1)
    m = PY_CLASS.match(line)
    return ("class", m.group(1)) if m else None


def det_go(line, s, parent, in_fn=False):
    m = GO_FUNC.match(line)
    if m:
        if m.group(1):
            return "method", f"{m.group(1)}.{m.group(2)}"
        return "function", m.group(2)
    m = GO_TYPE.match(line)
    return (m.group(2) if m.group(2) == "interface" else "struct", m.group(1)) if m else None


def det_rust(line, s, parent, in_fn=False):
    m = RS_FN.match(line)
    if m:
        return ("method" if parent in TYPE_KINDS else "function"), m.group(1)
    m = RS_ITEM.match(line)
    if m:
        return m.group(1), m.group(2)
    m = RS_IMPL.match(line)
    return ("impl", truncate(m.group(1), 60)) if m else None


def det_clike(line, s, parent, in_fn=False):
    m = CL_FUNC_KW.match(line)
    if m:
        return ("method" if parent in TYPE_KINDS else "function"), m.group(1)
    m = CL_TYPE.match(line)
    if m:
        return m.group(1), m.group(2)
    if s.endswith(";") or s.split(None, 1)[0] in CL_STMT:
        return None
    m = CL_FUNC_TYPED.match(line)
    if m and m.group(1) not in CL_STMT:
        return ("method" if parent in TYPE_KINDS else "function"), m.group(1)
    return None


def det_rb(line, s, parent, in_fn=False):
    m = RB_DEF.match(line)
    if m:
        return ("method" if parent in ("class", "module") else "function"), m.group(1)
    m = RB_MOD.match(line)
    if m:
        return ("module" if m.group(1) != "class" else "class"), m.group(2)
    return None


def det_sh(line, s, parent, in_fn=False):
    m = SH_FUNC.match(line)
    return ("function", m.group(1) or m.group(2)) if m else None


def det_css(line, s, parent, in_fn=False):
    m = CSS_RULE.match(line)
    return ("selector", truncate(m.group(1), 60)) if m else None


def det_yaml(line, s, parent, in_fn=False):
    m = YAML_KEY.match(line)
    if not m:
        return None
    key = m.group(2) or m.group(3) or m.group(4)
    if m.group(1):
        val = (m.group(5) or "").strip()
        return "key", truncate(f"- {key}: {val}" if val else f"- {key}", 50)
    return "key", key


def det_json(line, s, parent, in_fn=False):
    m = JSON_KEY.match(line)
    return ("key", m.group(1)) if m else None


def det_schema(line, s, parent, in_fn=False):
    m = SCHEMA_DECL.match(line)
    return (m.group(1), m.group(2)) if m else None


def det_hcl(line, s, parent, in_fn=False):
    m = HCL_BLOCK.match(line)
    if not m:
        return None
    names = " ".join(re.findall(r'"([^"]*)"', m.group(2)))
    return "block", (m.group(1) + (" " + names if names else ""))


def det_make(line, s, parent, in_fn=False):
    m = MAKE_TARGET.match(line)
    return ("target", m.group(1).strip()) if m else None


DETECTORS = {
    "js": det_js, "py": det_py, "go": det_go, "rust": det_rust, "clike": det_clike,
    "rb": det_rb, "sh": det_sh, "css": det_css, "yaml": det_yaml, "json": det_json,
    "schema": det_schema, "hcl": det_hcl, "make": det_make,
}
HASH_COMMENTS = frozenset(("py", "yaml", "sh", "rb", "make", "hcl"))
NO_DECL_TRACKING = frozenset(("yaml", "json"))  # chaves de dados: só o caminho importa


def fmt_symbol(kind, name):
    if kind in ("function", "method"):
        return name + "()"
    if kind == "const":
        return "const " + name
    if kind in ("key", "heading", "selector", "call", "target", "block", "table"):
        return name
    return f"{kind} {name}"


def fmt_chain(chain):
    return " › ".join(fmt_symbol(k, n) for k, n in chain)


def indent_of(s):
    n = 0
    for ch in s:
        if ch == " ":
            n += 1
        elif ch == "\t":
            n += 4
        else:
            break
    return n


def scan_indent(woven, skip_sign, family):
    """Pilha de indentação: para cada linha alterada, a cadeia de escopos que a envolve."""
    det = DETECTORS[family]
    hash_comments = family in HASH_COMMENTS
    fn_opener = JS_FN_OPENER if family == "js" else None
    chains, decls, stack = {}, {}, []  # stack: [indent, kind, name, idx, abre_função]
    for i, ln in enumerate(woven):
        sign = ln[0]
        if sign == skip_sign or sign == "~":
            continue
        text = ln[1]
        s = text.strip()
        changed = sign != " "
        if not s or (hash_comments and s.startswith("#")):
            if changed:
                chains[i] = tuple((e[1], e[2], e[3]) for e in stack if e[1])
            continue
        ind = indent_of(text)
        same = None
        while stack and stack[-1][0] >= ind:
            e = stack.pop()
            if e[0] == ind:
                same = e
        parent = stack[-1][1] if stack else None
        chain = tuple((e[1], e[2], e[3]) for e in stack if e[1])
        in_fn = any(e[1] in FN_KINDS or e[4] for e in stack)
        found = det(text, s, parent, in_fn)
        opens_fn = bool(fn_opener and fn_opener.search(s))
        if found:
            kind, name = found
            entry = [ind, kind, name, i, opens_fn]
            if changed:
                decls[i] = found
                chains[i] = chain + ((kind, name, i),)
        else:
            # "): Promise<T> {", "} else {", "{" (Allman) continuam a declaração anterior
            if same is not None and same[1] and s[0] in ")]}{":
                entry = [ind, same[1], same[2], same[3], opens_fn or same[4]]
                if changed:
                    chains[i] = chain + ((same[1], same[2], same[3]),)
            else:
                entry = [ind, None, None, i, opens_fn]
                if changed:
                    chains[i] = chain
        stack.append(entry)
    return chains, decls


def scan_headings(woven, skip_sign, family):
    """Markdown (# títulos) e TOML/INI ([tabelas]): escopo por hierarquia de seções."""
    chains, decls, stack, fence = {}, {}, [], False
    for i, ln in enumerate(woven):
        sign = ln[0]
        if sign == skip_sign or sign == "~":
            continue
        text, changed, m = ln[1], ln[0] != " ", None
        if family == "md":
            st = text.lstrip()
            if st.startswith(("```", "~~~")):
                fence = not fence
            elif not fence:
                m = MD_HEADING.match(text)
            if m:
                level, name = len(m.group(1)), m.group(1) + " " + m.group(2)
        else:
            m = TOML_TABLE.match(text)
            if m:
                level, name = 1, f"{m.group(1)}{m.group(2)}{']' * len(m.group(1))}"
        if m:
            while stack and stack[-1][0] >= level:
                stack.pop()
            chain = tuple(("heading", n, j) for _, n, j in stack)
            stack.append((level, name, i))
            if changed:
                decls[i] = ("heading", name)
                chains[i] = chain + (("heading", name, i),)
        elif changed:
            chains[i] = tuple(("heading", n, j) for _, n, j in stack)
    return chains, decls


# ---------------------------------------------------------------------------
# Costura (weave)
# ---------------------------------------------------------------------------

def weave(old_lines, hunks):
    """Visão única do arquivo: contexto do arquivo-base + hunks na posição exata.

    Retorna lista de (sinal, texto, nº linha antiga, nº linha nova, sem_newline)
    ou None se o conteúdo-base não bater com as posições dos hunks.
    """
    out, pos, new_no, n_old = [], 0, 0, len(old_lines)
    for h in hunks:
        # Com contagem 0 o git informa a linha APÓS a qual ocorre a inserção.
        target = h.old_start if h.old_count == 0 else h.old_start - 1
        if target < pos or target > n_old:
            return None
        while pos < target:
            pos += 1
            new_no += 1
            out.append((" ", dec(old_lines[pos - 1]), pos, new_no, False))
        h.start = len(out)
        for sign, text, noeol in h.lines:
            if sign == " ":
                pos += 1
                new_no += 1
                out.append((" ", dec(text), pos, new_no, noeol))
            elif sign == "-":
                pos += 1
                out.append(("-", dec(text), pos, None, noeol))
            else:
                new_no += 1
                out.append(("+", dec(text), None, new_no, noeol))
        h.end = len(out)
    while pos < n_old:
        pos += 1
        new_no += 1
        out.append((" ", dec(old_lines[pos - 1]), pos, new_no, False))
    return out


def weave_without_base(hunks):
    """Fallback quando o conteúdo-base não está disponível: só os hunks."""
    out = []
    for h in hunks:
        out.append(("~", "base content unavailable — surrounding lines not shown", None, None, False))
        h.start = len(out)
        o, n = h.old_start, h.new_start
        for sign, text, noeol in h.lines:
            if sign == "-":
                out.append(("-", dec(text), o, None, noeol))
                o += 1
            elif sign == "+":
                out.append(("+", dec(text), None, n, noeol))
                n += 1
            else:
                out.append((" ", dec(text), o, n, noeol))
                o += 1
                n += 1
        h.end = len(out)
    return out


# ---------------------------------------------------------------------------
# Arquivo alterado
# ---------------------------------------------------------------------------

class FileDiff:
    def __init__(self, entry, hunks, binary):
        self.e = entry
        self.hunks = hunks
        self.binary = binary
        self.path = decode_path(entry.dst)
        self.old_path = decode_path(entry.src)
        self.lang, self.family = detect_language(self.path)
        self.adds = sum(1 for h in hunks for l in h.lines if l[0] == "+")
        self.dels = sum(1 for h in hunks for l in h.lines if l[0] == "-")
        self.woven = None
        self.pinned = set()
        self.block_scopes = []
        self.symbols = []
        self.uses = []
        self.used_by = []
        self.notes = []
        self.sizes = None
        self.index = 0

    @property
    def status(self):
        return self.e.status

    def side_lines(self):
        if not self.woven:
            return []
        drop = "+" if self.status == "D" else "-"
        return [l[1] for l in self.woven if l[0] not in (drop, "~")]


def analyze_symbols(fd):
    if not fd.woven or not fd.hunks:
        return
    if fd.family in ("md", "toml"):
        scanner = scan_headings
    elif fd.family in DETECTORS:
        scanner = scan_indent
    else:
        return
    old_chains, old_decls = scanner(fd.woven, "+", fd.family)
    new_chains, new_decls = scanner(fd.woven, "-", fd.family)
    chains = dict(old_chains)
    chains.update(new_chains)
    track = fd.family not in NO_DECL_TRACKING

    first, plus, minus, touched = {}, set(), set(), set()
    for h in fd.hunks:
        scopes = []
        for i in range(h.start, h.end):
            sign, text = fd.woven[i][0], fd.woven[i][1]
            if sign == " " or not text.strip():
                continue
            chain = chains.get(i, ())
            key = tuple((k, n) for k, n, _ in chain)
            if key not in scopes:
                scopes.append(key)
            fd.pinned.update(j for _, _, j in chain if j != i)
            decl = (new_decls if sign == "+" else old_decls).get(i)
            if decl and track:
                (plus if sign == "+" else minus).add(key)
                first.setdefault(key, i)
            elif key:
                touched.add(key)
                first.setdefault(key, i)
        fd.block_scopes.append(scopes)

    def status_of(p):
        if p in plus and p in minus:
            return "modified"
        if p in plus:
            return "added"
        if p in minus:
            return "removed"
        return "changed"

    result = []
    for p in sorted(first, key=lambda k: first[k]):
        st = status_of(p)
        # não lista membros de um símbolo que já aparece inteiro como added/removed
        if any(status_of(p[:k]) in ("added", "removed") and p[:k] in first
               for k in range(1, len(p))):
            continue
        result.append((fmt_chain(p), st))
    fd.symbols = result


# ---------------------------------------------------------------------------
# Relações entre arquivos (imports que apontam para outros arquivos do diff)
# ---------------------------------------------------------------------------

RESOLVABLE_EXTS = frozenset((
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte",
    ".astro", ".json", ".css", ".scss", ".sass", ".less", ".py", ".pyi", ".go"))
JS_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]""")
CSS_IMPORT = re.compile(r"""@(?:import|use|forward)\s+(?:url\(\s*)?['"]([^'"]+)['"]""")
GO_IMPORT = re.compile(r'^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"\s]+/[^"\s]+)"\s*$')
PY_FROM = re.compile(r"^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)")
PY_IMPORT = re.compile(r"^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)")
JS_ALIASES = ("@/", "~/", "#/", "$lib/", "@src/")


def stem_of(p):
    if p.endswith(".d.ts"):
        return p[:-5]
    root, ext = posixpath.splitext(p)
    return root if ext.lower() in RESOLVABLE_EXTS else p


class StemIndex:
    def __init__(self, paths):
        self.paths = set(paths)
        self.stems, self.by_tail = {}, {}
        for p in sorted(paths):
            st = stem_of(p)
            self._add(st, p)
            base = posixpath.basename(st)
            if base in ("index", "__init__", "mod"):
                self._add(posixpath.dirname(st), p)
            elif base.startswith("_"):
                self._add(posixpath.join(posixpath.dirname(st), base[1:]), p)
            if p.endswith(".go"):
                self._add(posixpath.dirname(p), p)

    def _add(self, stem, p):
        if stem:
            self.stems.setdefault(stem, set()).add(p)
            self.by_tail.setdefault(posixpath.basename(stem), set()).add(stem)

    def exact(self, cand):
        if cand in self.paths:
            return {cand}
        return set(self.stems.get(stem_of(cand), ())) or set(self.stems.get(cand, ()))

    def suffix(self, rest):
        rest = stem_of(rest.strip("/"))
        if not rest:
            return set()
        out = set()
        for st in self.by_tail.get(posixpath.basename(rest), ()):
            if st == rest or st.endswith("/" + rest):
                out |= self.stems[st]
        return out if len(out) <= 6 else set()


def resolve_spec(spec, src, family, idx):
    spec = spec.split("?", 1)[0]
    if spec.startswith("."):
        return idx.exact(posixpath.normpath(posixpath.join(posixpath.dirname(src), spec)))
    if family == "go":
        return idx.suffix(spec)
    for a in JS_ALIASES:
        if spec.startswith(a):
            return idx.suffix(spec[len(a):])
    if spec.startswith("~"):
        return idx.suffix(spec[1:])
    if "/" in spec and not spec.startswith("@"):
        return idx.suffix(spec)  # imports via baseUrl ("components/Button")
    return set()


def python_targets(lines, src, idx):
    out = set()
    for l in lines:
        m = PY_FROM.match(l)
        if m:
            dots, mod, names = m.groups()
            names = [n.strip().split(" as ")[0].strip("()\\ ") for n in names.split(",")]
            names = [n for n in names if n and n != "*"]
            if dots:
                base = posixpath.dirname(src)
                for _ in range(len(dots) - 1):
                    base = posixpath.dirname(base)
                modpath = posixpath.join(base, mod.replace(".", "/")) if mod else base
                hits = idx.exact(modpath) if modpath else set()
                for n in names:
                    hits |= idx.exact(posixpath.join(modpath, n))
            else:
                mp = mod.replace(".", "/")
                hits = idx.suffix(mp)
                for n in names:
                    hits |= idx.suffix(mp + "/" + n)
            out |= hits
            continue
        m = PY_IMPORT.match(l)
        if m:
            for mod in m.group(1).split(","):
                out |= idx.suffix(mod.strip().split()[0].replace(".", "/"))
    return out


def compute_relations(files):
    by_path = {f.path: f for f in files}
    idx = StemIndex(by_path.keys())
    for f in files:
        if f.family not in ("js", "py", "go", "css") or not f.woven:
            continue
        lines = f.side_lines()
        targets = set()
        if f.family == "py":
            targets = python_targets(lines, f.path, idx)
        else:
            rx = {"js": JS_IMPORT, "css": CSS_IMPORT, "go": GO_IMPORT}[f.family]
            for l in lines:
                for m in rx.finditer(l):
                    targets |= resolve_spec(m.group(1), f.path, f.family, idx)
                if f.family == "js":  # .vue/.svelte podem ter <style> com @import
                    for m in CSS_IMPORT.finditer(l):
                        targets |= resolve_spec(m.group(1), f.path, "css", idx)
        targets.discard(f.path)
        f.uses = sorted(targets, key=lambda p: by_path[p].index)
    for f in files:
        for t in f.uses:
            by_path[t].used_by.append(f.path)
    for f in files:
        f.used_by = sorted(set(f.used_by), key=lambda p: by_path[p].index)
    return by_path


# ---------------------------------------------------------------------------
# Renderização
# ---------------------------------------------------------------------------

def line_range(nums):
    nums = [n for n in nums if n is not None]
    if not nums:
        return "?"
    a, b = min(nums), max(nums)
    return str(a) if a == b else f"{a}-{b}"


def scope_text(scopes):
    parts, top = [], False
    scopes = [sc for sc in scopes
              if not any(len(o) > len(sc) and o[:len(sc)] == sc for o in scopes)]
    for sc in scopes:
        if sc:
            parts.append(fmt_chain(sc))
        else:
            top = True
    if not parts:
        return "(top level)"
    extra = f"; +{len(parts) - 3} more" if len(parts) > 3 else ""
    return "; ".join(parts[:3]) + extra + ("; (top level)" if top else "")


MODE_NAMES = {"100644": "file", "100755": "executable", "120000": "symlink",
              "160000": "submodule", "040000": "directory"}


def kind_label(fd):
    e = fd.e
    if e.new_mode == "160000" or e.old_mode == "160000":
        return "submodule"
    if e.new_mode == "120000" or (e.status == "D" and e.old_mode == "120000"):
        return "symlink"
    return "binary" if fd.binary else fd.lang


def file_header(fd, total):
    e = fd.e
    parts = [f"[{fd.index}/{total}] {fd.path}"]
    if e.untracked:
        parts.append("added (untracked)")
    elif e.status in ("R", "C"):
        sim = f" ({e.score}% similar)" if e.score is not None else ""
        parts.append(f"{STATUS_WORDS[e.status]} from {fd.old_path}{sim}")
    elif e.status == "T":
        parts.append(f"type changed ({MODE_NAMES.get(e.old_mode, e.old_mode)} → "
                     f"{MODE_NAMES.get(e.new_mode, e.new_mode)})")
    else:
        parts.append(STATUS_WORDS.get(e.status, e.status))
    parts.append(kind_label(fd))
    if fd.binary:
        old_s, new_s = fd.sizes or (None, None)
        if e.status == "A":
            parts.append(human_size(new_s))
        elif e.status == "D":
            parts.append(human_size(old_s))
        else:
            parts.append(f"{human_size(old_s)} → {human_size(new_s)}")
    elif fd.hunks:
        stat = []
        if fd.adds:
            stat.append(f"+{fd.adds}")
        if fd.dels:
            stat.append(f"-{fd.dels}")
        parts.append(" ".join(stat))
        if e.status in ("M", "R", "C") and len(fd.hunks) > 0:
            parts.append(f"{len(fd.hunks)} change" + ("s" if len(fd.hunks) != 1 else ""))
    modes_differ = (e.old_mode != e.new_mode and e.old_mode != "000000"
                    and e.new_mode != "000000" and e.status != "T")
    if modes_differ:
        parts.append(f"mode {e.old_mode} → {e.new_mode}")
    return "===== " + " | ".join(parts) + " ====="


def file_meta(fd, by_path, opts):
    lines = []
    if opts.symbols and fd.symbols:
        cap = 15
        items = fd.symbols[:cap]
        more = f"; (+{len(fd.symbols) - cap} more)" if len(fd.symbols) > cap else ""
        if fd.status == "A":
            lines.append("defines: " + "; ".join(s for s, _ in items) + more)
        elif fd.status == "D":
            lines.append("removes: " + "; ".join(s for s, _ in items) + more)
        else:
            lines.append("symbols: " + "; ".join(f"{s} [{st}]" for s, st in items) + more)
    cap = 12
    if opts.symbols and fd.uses:
        refs = []
        for p in fd.uses[:cap]:
            t = by_path[p]
            refs.append(f"{p} [{t.index}]" + (" (deleted in this diff!)" if t.status == "D" else ""))
        more = f", (+{len(fd.uses) - cap} more)" if len(fd.uses) > cap else ""
        lines.append("uses: " + ", ".join(refs) + more)
    if opts.symbols and fd.used_by:
        more = f", (+{len(fd.used_by) - cap} more)" if len(fd.used_by) > cap else ""
        lines.append("used by: " + ", ".join(f"{p} [{by_path[p].index}]"
                                             for p in fd.used_by[:cap]) + more)
    return lines


def render_body(fd, opts, write):
    e = fd.e
    if e.status == "U":
        write("(unmerged path — resolve the conflict to see its diff)")
        return
    if fd.binary:
        write("(binary file — content not shown)")
        return
    if not fd.hunks:
        if e.status in ("R", "C"):
            write(f"({STATUS_WORDS[e.status]} without content changes)")
        elif e.old_mode != e.new_mode and e.status == "M":
            write("(file mode change only — content unchanged)")
        elif e.status == "A":
            write("(empty file)")
        elif e.status == "D":
            write("(empty file deleted)")
        else:
            write("(no textual changes)")
        return
    for note in fd.notes:
        write(f"~ [{note}]")

    woven = fd.woven
    n = len(woven)
    starts = {h.start: k for k, h in enumerate(fd.hunks)}
    show_markers = opts.markers and e.status not in ("A", "D") and fd.status != "T"

    visible = None
    if opts.unified is not None:
        ctx = opts.unified
        visible = [False] * n
        last = -(10 ** 9)
        for i in range(n):
            if woven[i][0] != " ":
                last = i
            if i - last <= ctx:
                visible[i] = True
        nxt = 10 ** 9
        for i in range(n - 1, -1, -1):
            if woven[i][0] != " ":
                nxt = i
            if nxt - i <= ctx:
                visible[i] = True
        for j in fd.pinned:  # mantém as linhas de declaração dos escopos alterados
            if 0 <= j < n:
                visible[j] = True

    width = len(str(max([l[2] or 0 for l in woven] + [l[3] or 0 for l in woven] + [1])))

    def emit(l):
        sign, text = l[0], l[1]
        if sign == "~":
            write(f"~ [{text}]")
            return
        if opts.line_numbers:
            num = l[2] if sign == "-" else l[3]
            write(f"{sign}{num if num is not None else '':>{width}}| {text}")
        else:
            write(sign + text)
        if l[4]:
            write("\\ No newline at end of file")

    i = 0
    while i < n:
        if show_markers and i in starts:
            k = starts[i]
            h = fd.hunks[k]
            seg = woven[h.start:h.end]
            plus = [l[3] for l in seg if l[0] == "+"]
            minus = [l[2] for l in seg if l[0] == "-"]
            parts = [f"change {k + 1}/{len(fd.hunks)}"]
            if plus:
                parts.append(f"+{len(plus)} at L{line_range(plus)}")
            if minus:
                parts.append(f"-{len(minus)} at old L{line_range(minus)}")
            if opts.symbols and fd.block_scopes:
                parts.append("in: " + scope_text(fd.block_scopes[k]))
            write("@@ " + " | ".join(parts) + " @@")
        if visible is not None and not visible[i]:
            j = i
            while j < n and not visible[j] and not (show_markers and j in starts):
                j += 1
            if j - i >= 3:
                a, b = woven[i][3], woven[j - 1][3]
                rng = f"L{a}" if a == b else f"L{a}-L{b}"
                write(f"~ [{j - i} unchanged lines hidden: {rng}]")
            else:
                for l in woven[i:j]:
                    emit(l)
            i = j
            continue
        emit(woven[i])
        i += 1


# ---------------------------------------------------------------------------
# Descrição da comparação
# ---------------------------------------------------------------------------

def short_ref(r):
    out = run_git(["rev-parse", "--short", (r or "HEAD") + "^{commit}"], check=False)
    sha = out.decode("ascii", "replace").strip()
    name = r or "HEAD"
    return f"{name} ({sha})" if sha and sha != name else name


def describe(revs, cached, merge_base, reverse):
    """Retorna (base, alvo, intervalo para git log)."""
    log = None
    if not revs:
        if cached:
            base, target = short_ref("HEAD"), "index (staged changes)"
        else:
            base, target = "index", "working tree (unstaged changes)"
    elif len(revs) == 1 and "..." in revs[0]:
        a, b = revs[0].split("...", 1)
        base = f"merge-base of {short_ref(a)} and {short_ref(b)}"
        target, log = short_ref(b), f"{a or 'HEAD'}..{b or 'HEAD'}"
    elif len(revs) == 1 and ".." in revs[0]:
        a, b = revs[0].split("..", 1)
        base, target, log = short_ref(a), short_ref(b), f"{a or 'HEAD'}..{b or 'HEAD'}"
    elif len(revs) == 1:
        r = revs[0]
        base = f"merge-base of {short_ref(r)} and HEAD" if merge_base else short_ref(r)
        target = "index (staged)" if cached else "working tree (current state, uncommitted changes included)"
        log = f"{r}..HEAD"
    else:
        a, b = revs
        base = f"merge-base of {short_ref(a)} and {short_ref(b)}" if merge_base else short_ref(a)
        target, log = short_ref(b), f"{a}..{b}"
    if reverse:
        base, target, log = target, base, None
    return base, target, log


def commit_log(rng, limit=50):
    if not rng:
        return [], False
    out = run_git(["log", "--no-decorate", "--no-color", "--format=%h %s",
                   f"-n{limit + 1}", rng, "--"], check=False)
    lines = [l for l in out.decode("utf-8", "replace").splitlines() if l.strip()]
    return lines[:limit], len(lines) > limit


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------

def main(argv):
    opts, git_opts, positionals, user_specs = parse_cli(argv)

    try:
        top = run_git(["rev-parse", "--show-toplevel"]).rstrip(b"\r\n")
    except GitError as err:
        die(f"não estou dentro de um repositório git ({err}).")

    revs, path_args = classify_positionals(positionals)
    cached = any(o in ("--cached", "--staged") for o in git_opts)
    reverse = "-R" in git_opts
    merge_base = "--merge-base" in git_opts
    worktree = not cached and (not revs or (len(revs) == 1 and ".." not in revs[0]))

    base_dir = top
    for o in git_opts:
        if o == "--relative":
            base_dir = os.getcwd().encode()
        elif o.startswith("--relative="):
            base_dir = os.path.join(top, os.fsencode(o.split("=", 1)[1]))
    lit_magic = ":(literal)" if any(o.startswith("--relative") for o in git_opts) else ":(top,literal)"

    pathspecs = path_args + user_specs
    plain_specs = list(pathspecs)
    if opts.clean:
        pathspecs = pathspecs + [":(top,glob,exclude)" + p for p in CLEAN_EXCLUDES]
    if pathspecs and all(is_exclude_spec(p) for p in pathspecs):
        pathspecs = [":/"] + pathspecs

    defaults = ["-M"]
    algo_given = any(o in ("--histogram", "--patience", "--minimal") or
                     o.startswith("--diff-algorithm") for o in git_opts)
    if not algo_given and not run_git(["config", "--get", "diff.algorithm"], check=False).strip():
        defaults.append("--histogram")

    common = ["--no-pager", "-c", "core.quotePath=false", "diff"] + defaults + git_opts
    raw_fmt = ["--raw", "-z", "--no-abbrev", "--no-color", "--no-ext-diff"]
    patch_fmt = ["-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
                 "--src-prefix=a/", "--dst-prefix=b/"]

    try:
        entries = parse_raw(run_git(common + raw_fmt + revs + ["--"] + pathspecs))
        sections = split_patch(run_git(common + patch_fmt + revs + ["--"] + pathspecs))
    except GitError as err:
        die(str(err))

    pairs = pair_sections(entries, sections)
    if pairs is None:  # muito raro: refaz arquivo a arquivo
        pairs = []
        for e in entries:
            if e.status == "U":
                pairs.append((e, []))
                continue
            specs = [lit_magic + os.fsdecode(e.src)]
            if e.dst != e.src:
                specs.append(lit_magic + os.fsdecode(e.dst))
            out = run_git(common + patch_fmt + revs + ["--"] + specs, check=False)
            pairs.append((e, split_patch(out)))

    files = []
    for e, secs in pairs:
        hunks, binary = merge_sections(secs)
        files.append(FileDiff(e, hunks, binary))

    # Arquivos não rastreados (o git diff normal não os mostra)
    untracked = []
    if worktree and not reverse:
        out = run_git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--"]
                      + (pathspecs or [":/"]), check=False)
        untracked = sorted(p for p in out.split(b"\0") if p)
    if untracked and opts.untracked:
        for p in untracked:
            full = os.path.join(top, p)
            try:
                if os.path.islink(full):
                    data, mode = os.readlink(full).encode(), "120000"
                else:
                    with open(full, "rb") as fh:
                        head = fh.read(8000)
                        binary = b"\0" in head
                        data = head if binary else head + fh.read()
                    mode = "100755" if os.access(full, os.X_OK) else "100644"
            except OSError:
                continue
            binary = mode != "120000" and b"\0" in data[:8000]
            e = Entry("A", None, "000000", mode, "0" * 40, "0" * 40, p, p, untracked=True)
            hunks = []
            if not binary and data:
                lines = split_lines(data)
                hl = [["+", l, False] for l in lines]
                if not data.endswith(b"\n"):
                    hl[-1][2] = True
                hunks = [Hunk(0, 0, 1, len(hl), hl)]
            fd = FileDiff(e, hunks, binary)
            if binary:
                fd.sizes = (None, os.path.getsize(full))
            files.append(fd)

    excluded = []
    if opts.clean:
        try:
            all_entries = parse_raw(run_git(common + raw_fmt + revs + ["--"] + plain_specs))
        except GitError:
            all_entries = []
        shown = {e.dst for e in entries}
        excluded = sorted({decode_path(e.dst) for e in all_entries if e.dst not in shown})

    files.sort(key=lambda f: f.e.dst)
    for k, fd in enumerate(files, 1):
        fd.index = k

    # Passo 1: costura + análise
    blobs = BlobStore()
    try:
        for fd in files:
            e = fd.e
            if fd.binary:
                if fd.sizes is None:
                    new_size = BlobStore.size(e.new_sha)
                    if new_size is None and e.status != "D":
                        try:
                            new_size = os.path.getsize(os.path.join(base_dir, e.dst))
                        except OSError:
                            new_size = None
                    fd.sizes = (BlobStore.size(e.old_sha), new_size)
                continue
            if not fd.hunks:
                continue
            old_lines = []
            if e.status in ("M", "R", "C") and e.old_mode not in ("000000", "160000"):
                if is_zero(e.old_sha):  # -R com working tree como base
                    try:
                        with open(os.path.join(base_dir, e.src), "rb") as fh:
                            data = fh.read()
                    except OSError:
                        data = None
                else:
                    data = blobs.read(e.old_sha)
                old_lines = split_lines(data) if data is not None else None
            fd.woven = weave(old_lines, fd.hunks) if old_lines is not None else None
            if fd.woven is None:
                fd.woven = weave_without_base(fd.hunks)
            if opts.symbols:
                analyze_symbols(fd)
    finally:
        blobs.close()

    by_path = compute_relations(files) if opts.symbols else {f.path: f for f in files}

    # Passo 2: saída
    if opts.output:
        try:
            out_fh = open(opts.output, "w", encoding="utf-8", newline="\n")
        except OSError as err:
            die(f"não foi possível abrir {opts.output}: {err}")
    else:
        out_fh = sys.stdout
        try:
            out_fh.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass

    stats = {"chars": 0, "lines": 0}

    def write(s=""):
        out_fh.write(s)
        out_fh.write("\n")
        stats["chars"] += len(s) + 1
        stats["lines"] += 1

    total = len(files)
    tot_add = sum(f.adds for f in files)
    tot_del = sum(f.dels for f in files)

    if opts.summary:
        base, target, log_rng = describe(revs, cached, merge_base, reverse)
        shown_args = []
        skip_next = False
        for a in argv:
            if skip_next:
                skip_next = False
                continue
            if a in ("-o", "--output"):
                skip_next = True
                continue
            if a.startswith("--output="):
                continue
            shown_args.append(a)
        write(f"# AI CODE REVIEW DIFF — generated by {PROG} {VERSION}")
        write(f"# command: {PROG} {' '.join(shlex.quote(a) for a in shown_args)}".rstrip())
        write(f"# base:    {base}")
        write(f"# target:  {target}")
        if opts.clean:
            write("# filter:  --clean (tests, lockfiles and build output excluded)")
        counts = {}
        for f in files:
            w = "added" if f.e.untracked else STATUS_WORDS.get(f.status, f.status)
            counts[w] = counts.get(w, 0) + 1
        breakdown = ", ".join(f"{v} {k}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))
        write(f"# files:   {total}" + (f" ({breakdown})" if breakdown else "") +
              f" | lines: +{tot_add} -{tot_del}")
        write("#")
        write("# HOW TO READ")
        write("#   Each changed file appears exactly once, complete, under a")
        write("#   \"===== [i/N] path | status | language | +added -removed =====\" header.")
        write("#   Every content line starts with a 1-char marker: \" \" unchanged, \"+\" added,")
        write("#   \"-\" removed. Removed lines stay at the position they had in the base version.")
        if opts.markers:
            write("#   \"@@ change k/n | +a at L.. | -b at old L.. | in: <scope> @@\" opens each change")
            write("#   block (L = line in the new version, old L = line in the base version).")
        if opts.symbols:
            write("#   \"symbols:\" lists touched functions/classes/sections; \"uses:\" / \"used by:\"")
            write("#   link files of this diff that import each other ([i] = file number).")
            write("#   Scopes and symbols are detected heuristically.")
        if opts.line_numbers:
            write("#   Line numbers: new version for \" \"/\"+\" lines, base version for \"-\" lines.")
        if opts.unified is not None:
            write(f"#   Only {opts.unified} unchanged line(s) around each change are shown;")
            write("#   \"~ [N unchanged lines hidden ...]\" marks collapsed regions.")
        write("#   \"\\ No newline at end of file\" refers to the line right above it.")

        if opts.log and log_rng:
            commits, more = commit_log(log_rng)
            if commits:
                write("#")
                write(f"# COMMITS ({log_rng})")
                for c in commits:
                    write(f"#   {c}")
                if more:
                    write("#   ... (more commits omitted)")

        if files:
            write("#")
            write("# FILES")
            labels = []
            for f in files:
                lbl = f"{f.old_path} → {f.path}" if f.status in ("R", "C") else f.path
                if f.status in ("R", "C") and f.e.score is not None:
                    lbl += f" ({f.e.score}%)"
                labels.append(lbl)
            wl = max(len(l) for l in labels)
            wi = len(str(total))
            for f, lbl in zip(files, labels):
                letter = "A" if f.e.untracked else f.status
                if f.binary:
                    info = "binary"
                elif not f.hunks and f.status in ("R", "C"):
                    info = "(no content changes)"
                elif not f.hunks and f.e.old_mode != f.e.new_mode and f.status == "M":
                    info = f"(mode {f.e.old_mode} → {f.e.new_mode})"
                else:
                    info = f"{('+' + str(f.adds)) if f.adds else '':>6} {('-' + str(f.dels)) if f.dels else '':>6}  {kind_label(f)}"
                extra = " (untracked)" if f.e.untracked else ""
                write(f"#   [{f.index:>{wi}}] {letter}  {lbl:<{wl}}  {info}{extra}".rstrip())

        if excluded:
            write("#")
            cap = 60
            write(f"# EXCLUDED BY --clean ({len(excluded)}): " + ", ".join(excluded[:cap]) +
                  (f", ... (+{len(excluded) - cap})" if len(excluded) > cap else ""))
        if untracked and not opts.untracked:
            write("#")
            cap = 30
            names = [decode_path(p) for p in untracked]
            write(f"# NOTE: {len(names)} untracked file(s) not included (use --untracked): " +
                  ", ".join(names[:cap]) + (", ..." if len(names) > cap else ""))
        write()

    if not files:
        write("(no changes)")

    for fd in files:
        write(file_header(fd, total))
        meta = file_meta(fd, by_path, opts)
        for m in meta:
            write(m)
        write()
        render_body(fd, opts, write)
        write()

    if opts.output:
        out_fh.close()
    else:
        out_fh.flush()

    if untracked and not opts.untracked:
        warn(f"{len(untracked)} arquivo(s) não rastreado(s) ficaram de fora (use --untracked).")
    dest = opts.output or "stdout"
    sys.stderr.write(f"{PROG}: {total} arquivo(s), +{tot_add} -{tot_del}, "
                     f"{stats['lines']} linhas, ~{stats['chars'] // 4} tokens → {dest}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        try:
            sys.stdout = None
        except Exception:
            pass
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
