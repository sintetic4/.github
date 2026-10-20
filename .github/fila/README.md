# Fila automática de PRs: como confirmar, operar e destravar

Código: `lib.mjs` (regras puras), `driver.mjs` (API + decisão), `run.mjs` (entrada). Workflow: `.github/workflows/fila.yml`.
Modelo do caller: `caller.exemplo.yml`. Testes: `node --test .github/fila/*.test.mjs`.

## Confirmar no 1º run (o que ainda é suposição)
1. Abra o log do passo "Avaliar PRs". Cada PR imprime `... checks=<estado> ignorados=[<nomes>]`.
2. `ignorados` deve conter o job da própria fila (provavelmente `fila / fila`). O robô ignora o check da PRÓPRIA run
   pelo `check_suite` da run (`GET /actions/runs/{GITHUB_RUN_ID}` -> `check_suite_id`), sem depender do nome.
3. Se `ignorados=[]` e o PR ficou "checks em andamento: <nome da fila>": a API da run falhou. Copie o nome exato e
   passe no caller: `with: { checks_proprios: "<nome exato>" }` (ou env `FILA_CHECKS_PROPRIOS`).

## `.github` público (opção A em vigor, decidida pelo João)
`sintetic4/.github` é PÚBLICO, então o checkout da ferramenta funciona com o `github.token` de qualquer repo chamador, sem App nem token extra.
O código e as regras genéricas da fila ficam públicos; o `fila.yml` de cada repo continua privado no repo dele. Nunca pôr segredo neste repo.
Se o checkout falhar mesmo assim: conferir visibilidade e o SHA do `uses:` no caller (o erro do passo "Erro claro..." aponta para aqui).
Alternativas descartadas (só se voltar a privado): GitHub App com `actions/create-github-app-token` (Contents: read só em `.github`, chave em segredo) ou
vendorizar `lib/driver/run.mjs` e o workflow em cada repo (sem checkout do head; deriva entre repos).

## Limites conhecidos (documentados de propósito)
- O CI do repo (`validate.yml`, gatilho `pull_request`) roda o arquivo de workflow do HEAD do PR. Um PR pode editar o próprio `validate.yml`.
  Isso só é aceitável porque `.github/**` é sempre vermelho no robô (nunca mergeia sozinho, mesmo aprovado) e exige revisão humana.
  O validador em si vem da base; o que o head controla é só o próprio arquivo de workflow.
- Aprovação de review não dispara o robô: vale no próximo evento (push/label/CI/cron) ou em "Run workflow".
- O formato do nome do check da fila (`fila / fila`) é só reserva; o mecanismo principal é o check_suite da run atual.
