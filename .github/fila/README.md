# Fila automática de PRs: como confirmar, operar e destravar

Código: `lib.mjs` (regras puras), `driver.mjs` (API + decisão), `run.mjs` (entrada). Workflow: `.github/workflows/fila.yml`.
Modelo do caller: `caller.exemplo.yml`. Testes: `node --test .github/fila/*.test.mjs`.

## Confirmar no 1º run (o que ainda é suposição)
1. Abra o log do passo "Avaliar PRs". Cada PR imprime `... checks=<estado> ignorados=[<nomes>]`.
2. `ignorados` deve conter o job da própria fila (provavelmente `fila / fila`). O robô ignora o check da PRÓPRIA run
   pelo `check_suite` da run (`GET /actions/runs/{GITHUB_RUN_ID}` -> `check_suite_id`), sem depender do nome.
3. Se `ignorados=[]` e o PR ficou "checks em andamento: <nome da fila>": a API da run falhou. Copie o nome exato e
   passe no caller: `with: { checks_proprios: "<nome exato>" }` (ou env `FILA_CHECKS_PROPRIOS`).

## Problema aberto: `.github` privado (decisão do João)
O passo de checkout de `sintetic4/.github` usa o `github.token` do repo CHAMADOR, que não lê outro repo privado. O workflow
falha com uma mensagem clara (`fila: sem acesso a sintetic4/.github`). Três saídas; escolher UMA.

Pré-requisito comum de qualquer uma que mantenha o reusable workflow em `.github` privado: em `sintetic4/.github`,
Settings > Actions > General > Access > "Accessible from repositories in the 'sintetic4' organization" (sem isso nem o
`uses:` do caller resolve).

### A. Tornar `sintetic4/.github` público (mais simples)
1. Conferir que o repo não tem segredo/histórico sensível: `git log -p | grep -iE "ghp_|github_pat_|sk-|BEGIN .* PRIVATE"` e revisar `profile/` e `SECURITY.md`.
2. `sintetic4/.github` > Settings > General > Danger Zone > Change repository visibility > Make public.
3. Nada muda nos workflows: o checkout passa a funcionar sem token. Custo zero. Contra: o código e as regras da fila ficam públicos
   (os `fila.yml` de cada repo continuam privados, em cada repo).

### B. GitHub App com token de instalação (mantém privado)
1. Org sintetic4 > Settings > Developer settings > GitHub Apps > New: permissão de repositório `Contents: Read-only`, sem webhook.
2. Instalar o App só no repo `sintetic4/.github`. Gerar uma private key (.pem).
3. Em cada repo chamador (ou como segredos da org): `FILA_APP_ID` (variável) e `FILA_APP_KEY` (segredo = conteúdo do .pem).
4. No `fila.yml` antes do checkout, adicionar `actions/create-github-app-token` (pinar por SHA) com
   `app-id: ${{ vars.FILA_APP_ID }}`, `private-key: ${{ secrets.FILA_APP_KEY }}`, `owner: sintetic4`, `repositories: .github`,
   e passar `token: ${{ steps.app.outputs.token }}` ao checkout. No caller: `secrets: inherit` (ou mapear os dois nomes).
5. Contra: um segredo (a chave) por repo/org para rotacionar. Custo zero no plano Free.

### C. Vendorizar a ferramenta em cada repo (sem reusable workflow)
1. Copiar `.github/fila/{lib,driver,run}.mjs` e o conteúdo de `.github/workflows/fila.yml` para o repo chamador
   (`.github/fila/` e `.github/workflows/fila.yml`, já com os gatilhos do `caller.exemplo.yml`).
2. O workflow NÃO pode fazer checkout do PR: se precisar do código, `actions/checkout` com
   `ref: ${{ github.event.repository.default_branch }}` (branch padrão, nunca o head). `pull_request_target` já roda o arquivo da padrão.
3. Mudanças na ferramenta passam a exigir PR em cada repo (todas tocam `.github/**`, vermelho, merge manual). Risco de deriva entre repos.
