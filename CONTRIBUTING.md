# Como mudar algo na Sintética

Somos 4 sócios e muitos agentes. O ciclo é o mesmo para todos (detalhes por repo no `AGENTS.md` de cada um).

1. **Issue.** Toda mudança nasce de uma issue (backlog: Project da org). Sem fonte, sem issue. Dados de aluno: use F-NN, nunca nome.
2. **Worktree.** Uma por tarefa: `git worktree add D:/work/wt/<nome> -b <tipo>/<nome> origin/main` (`fix/`, `feat/`, `docs/`). Antes do PR: `git fetch origin && git merge origin/main`. Nunca `--force`, nunca reescrever `main`.
3. **PR pequeno, com o template** (`pull_request_template.md`; um repo com template próprio, como o `sintetica-cloud`, sobrescreve este). Uma coisa só, em rascunho até a prova existir. `Closes #N`. Refatoração exige matriz de impacto.
4. **Revisão cega.** Um agente "fresco", que não viu a construção, lê o diff e devolve relatório e veredito. Linke no PR. Autor não aprova o próprio PR.
5. **Fila por cor** (workflow reutilizável deste repo, quando ligado; até lá vale como regra manual). A pior cor vence, dúvida = vermelho:
   - verde (docs, texto, testes, estilo): entra com checks verdes;
   - amarelo (funcionalidade comum): entra 24h depois se ninguém objetar; `fila:segura` congela;
   - vermelho (dinheiro, login, segurança, dados, regras do desafio, `.github/`): só com Approve do João ou do Victor.
6. **Deploy com smoke.** Merge não publica. Só se publica commit que já está em `origin/main`, por qualquer sócio (avisando o outro), e confere-se no domínio real. Registre SHA e rollback no estado do repo.

Nunca: commitar segredo, rodar seed que grava em produção sem dry-run lido, publicar fora de canal aprovado (agente prepara, pessoa publica).
