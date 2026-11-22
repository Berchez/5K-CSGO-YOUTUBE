---
name: code-review-diff
description: >-
  Prepara prompt de revisão de código e diff costurado (ai-diff) comparando o código atual
  com a última versão ou commit via diff-tool.py, copiando o resultado pronto para o clipboard.
  Use quando o usuário pedir para gerar diff para revisão, comparar com o último commit, preparar
  revisão de PR ou enviar código para auditoria externa.
---

# Code Review Diff Skill

Gera um diff completo "costurado" (onde cada arquivo modificado aparece uma única vez com contexto inline) usando o `diff-tool.py`, adiciona o prompt padrão de revisão de código solicitado pelo usuário e copia tudo para a área de transferência (clipboard).

## Prompt Padrão de Revisão

```text
Me ajude a revisar este codigo procurando por problemas P0 e P1, e regressoes.
Alem disso procure por melhorias em readability, manutenability, e scalability.
Garanta que não haja regressões em CLS, FCP, LCP, TTFB, e similares.
Depois me diga se voce aprovaria ou não este PR (de uma nota de 0 a  10 onde 10 é 'aprovo incondicionalmente' e 0 é 'pessimo/bugado')
Me devolva a avaliação em formato .md para que eu possa apenas copiar e colar.
```

## Como Usar

### 1. Execução Automática (Diff + Clipboard)

Execute o script auxiliar `prepare_review.py`:

```powershell
python .agents/skills/code-review-diff/scripts/prepare_review.py
```

Ou especificando argumentos do git (ex: commit base, range ou flags):

```powershell
# Comparando com o último commit incluindo arquivos untracked (padrão):
python .agents/skills/code-review-diff/scripts/prepare_review.py HEAD --untracked

# Excluindo testes e lockfiles com --clean:
python .agents/skills/code-review-diff/scripts/prepare_review.py HEAD --untracked --clean

# Comparando dois commits específicos:
python .agents/skills/code-review-diff/scripts/prepare_review.py HEAD~1 HEAD
```

### 2. Uso Direto do `diff-tool.py`

O script `diff-tool.py` localiza-se em `scripts/diff-tool.py` dentro desta skill:

```powershell
python .agents/skills/code-review-diff/scripts/diff-tool.py HEAD --untracked
```

## Recursos

- **`scripts/diff-tool.py`**: Ferramenta `ai-diff` portada do repositório OSINT-STEAM para diff estruturado para LLMs.
- **`scripts/prepare_review.py`**: Automatiza a junção do prompt de revisão com o diff e realiza a cópia atômica para o clipboard via PowerShell.
