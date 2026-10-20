// Driver da fila: busca dados pela API, chama lib.mjs, aplica rótulo/merge/comentário.
// Sem I/O próprio: recebe `gh(method, path, body, opts)` (fetch real no run.mjs, mock nos testes).
// Contrato de segurança: só LÊ metadados do PR pela API. Nunca faz checkout nem executa código do head.
// Título/branch/corpo do PR nunca vão para shell; só para comentário/relatório como texto.
import {
  parseFilaYaml, corDosArquivos, estadoChecks, nomesProprios, aprovacaoEMudancas, decidir, tocaGithub, instanteDoEvento, LIMITE_FILA,
} from './lib.mjs';

export const COR_LABEL = { verde: 'fila:verde', amarelo: 'fila:amarelo', vermelho: 'fila:vermelho' };
export const ROTULOS = [
  { name: 'fila:verde', color: '0e8a16', description: 'fila: entra sozinho' },
  { name: 'fila:amarelo', color: 'fbca04', description: 'fila: entra após 24h sem objeção' },
  { name: 'fila:vermelho', color: 'd93f0b', description: 'fila: precisa de aprovação' },
  { name: 'fila:segura', color: '5319e7', description: 'fila: congela o PR' },
];
const TRUNCADO = 3000; // limite da API de arquivos do PR
const titulo12 = (t) => String(t || '').split(/\s+/).slice(0, 12).join(' ');

export function criarDriver({ gh, repo, runId = null, proprios = nomesProprios(''), agora = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  let rotulosCriados = false;
  let padrao = null;
  let houveErro = false;
  let suite;

  async function paginar(path, max = 30) {
    const out = [];
    for (let p = 1; p <= max; p++) {
      const sep = path.includes('?') ? '&' : '?';
      const arr = await gh('GET', `${path}${sep}per_page=100&page=${p}`);
      out.push(...arr);
      if (arr.length < 100) break;
    }
    return out;
  }

  async function checksDoCommit(sha) {
    const runs = [];
    for (let p = 1; p <= 20; p++) {
      const r = await gh('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${p}`);
      runs.push(...r.check_runs);
      if (runs.length >= r.total_count || r.check_runs.length === 0) break;
    }
    return runs;
  }

  // check_suite da run atual: todos os jobs desta run (inclusive "fila / fila") ficam nela. Ignorar por id não depende de nome.
  async function suiteDaRun() {
    if (suite !== undefined) return suite;
    suite = null;
    if (runId) {
      try { suite = (await gh('GET', `/repos/${repo}/actions/runs/${runId}`)).check_suite_id || null; } catch { suite = null; }
    }
    return suite;
  }

  async function branchPadrao() {
    if (!padrao) padrao = (await gh('GET', `/repos/${repo}`)).default_branch;
    return padrao;
  }

  // Momento do push do commit atual (API de atividade do repo do head). null se indisponível.
  async function pushDoCommit(pr, sha) {
    try {
      const headRepo = pr.head.repo && pr.head.repo.full_name;
      if (!headRepo) return null;
      const ref = encodeURIComponent(`refs/heads/${pr.head.ref}`);
      const acts = await gh('GET', `/repos/${headRepo}/activity?ref=${ref}&per_page=100`);
      const ts = (Array.isArray(acts) ? acts : []).filter((a) => a.after === sha && a.timestamp).map((a) => Date.parse(a.timestamp));
      return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
    } catch { return null; }
  }

  async function garantirRotulos() {
    if (rotulosCriados) return;
    for (const l of ROTULOS) {
      try { await gh('POST', `/repos/${repo}/labels`, l); } catch (e) {
        // 422 = já existe. Outro erro não derruba o robô.
        if (e.status !== 422) log.warn(`aviso: não criei rótulo ${l.name}: ${e.message}`);
      }
    }
    rotulosCriados = true;
  }

  async function comentar(numero, marca, texto) {
    const cs = await paginar(`/repos/${repo}/issues/${numero}/comments`);
    if (cs.some((c) => c.body && c.body.includes(marca))) return;
    await gh('POST', `/repos/${repo}/issues/${numero}/comments`, { body: `${marca}\n${texto}` });
  }

  async function ajustarRotulo(numero, labelsAtuais, cor) {
    await garantirRotulos();
    const alvo = COR_LABEL[cor];
    for (const l of labelsAtuais) {
      if (Object.values(COR_LABEL).includes(l) && l !== alvo) {
        await gh('DELETE', `/repos/${repo}/issues/${numero}/labels/${encodeURIComponent(l)}`, null, { ok404: true });
      }
    }
    if (!labelsAtuais.includes(alvo)) {
      await gh('POST', `/repos/${repo}/issues/${numero}/labels`, { labels: [alvo] });
    }
  }

  // Avalia um PR. Retorna o registro para fila.json, ou null se o PR não é da fila (fechado / base não padrão).
  async function avaliar(numero, { acaoEvento = null, abertos = 0 } = {}) {
    let pr = await gh('GET', `/repos/${repo}/pulls/${numero}`);
    if (pr.state !== 'open') return null;
    for (let t = 0; pr.mergeable === null && t < 6; t++) {
      await sleep(5000);
      pr = await gh('GET', `/repos/${repo}/pulls/${numero}`);
    }
    const sha = pr.head.sha;
    const marcaErro = `<!-- fila-erro:${sha} -->`;
    try {
      if (pr.base.ref !== await branchPadrao()) {
        log.log(`PR #${numero} ignorado: base ${pr.base.ref} não é a branch padrão`);
        return null;
      }
      const arquivos = await paginar(`/repos/${repo}/pulls/${numero}/files`, 30);
      // Regras da branch padrão ATUAL (não do head, não do pr.base.sha que pode estar defasado): o PR não escolhe as regras
      // e uma regra nova vale para PRs já abertos.
      const cfgResp = await gh('GET', `/repos/${repo}/contents/.github/fila.yml?ref=${encodeURIComponent(await branchPadrao())}`, null, { ok404: true });
      if (!cfgResp) throw new Error('.github/fila.yml ausente na branch padrão (sem config, não classifica)');
      const cfg = parseFilaYaml(Buffer.from(cfgResp.content, 'base64').toString('utf8'));
      const pushIso = await pushDoCommit(pr, sha);
      const t0 = instanteDoEvento({ pushIso, updatedIso: pr.updated_at, createdIso: pr.created_at });
      const idadeMs = t0 === null ? 0 : Math.max(0, agora() - t0);
      const revisoes = await paginar(`/repos/${repo}/pulls/${numero}/reviews`);
      const checks = estadoChecks(await checksDoCommit(sha), cfg.checks_obrigatorios, { runId, proprios, checkSuiteId: await suiteDaRun() });
      const { aprovado, mudancasPedidas } = aprovacaoEMudancas(revisoes, sha);
      const labels = pr.labels.map((l) => l.name);

      const cls = arquivos.length >= TRUNCADO
        ? { cor: 'vermelho', motivo: 'lista de arquivos truncada (dúvida)' }
        : corDosArquivos(arquivos, cfg);
      const bloqueioGithub = arquivos.length >= TRUNCADO || tocaGithub(arquivos);
      const dec = decidir({
        draft: pr.draft, mergeable: pr.mergeable, labels, cor: cls.cor, checks,
        idadeMs, mudancasPedidas, aprovado, bloqueioGithub,
      });

      if (acaoEvento === 'opened' && !pr.draft && abertos > LIMITE_FILA) {
        await comentar(numero, '<!-- fila-cheia -->', `fila cheia: esvaziar antes (${abertos} PRs abertos, limite ${LIMITE_FILA}). O robô não bloqueia; avisa.`);
      }

      await ajustarRotulo(numero, labels, cls.cor);

      let acao = dec.acao;
      if (dec.acao === 'merge') {
        try {
          await gh('PUT', `/repos/${repo}/pulls/${numero}/merge`, { merge_method: 'squash', sha });
          acao = 'mesclado';
          if (pr.head.repo && pr.head.repo.full_name === repo) {
            const ref = pr.head.ref.split('/').map(encodeURIComponent).join('/');
            await gh('DELETE', `/repos/${repo}/git/refs/heads/${ref}`, null, { ok404: true });
          }
        } catch (e) {
          await comentar(numero, marcaErro, `fila: merge recusado pelo GitHub (${e.message}). Não mergeou; ver o job.`);
          acao = 'erro';
        }
      }
      log.log(`PR #${numero} cor=${cls.cor} acao=${acao} motivo="${dec.motivo}" (${cls.motivo}) checks=${checks.estado} ignorados=[${checks.ignorados.join(' | ')}]`);
      return {
        repo, pr: numero, titulo: titulo12(pr.title), cor: cls.cor, acao,
        idade_h: Math.floor(idadeMs / 3600000), esperando: dec.esperando, motivo: dec.motivo,
      };
    } catch (e) {
      log.error(`PR #${numero} ERRO do robô: ${e.message}`);
      await comentar(numero, marcaErro, `fila: erro do robô, não mergeia. Motivo: ${e.message}`).catch(() => {});
      houveErro = true;
      return { repo, pr: numero, titulo: titulo12(pr.title), cor: 'vermelho', acao: 'erro', idade_h: null, esperando: 'robô (ver job)', motivo: e.message };
    }
  }

  // Quais PRs avaliar para este evento. Só eventos que rodam o workflow da BASE (ver fila-caller): pull_request_target,
  // workflow_run, schedule, workflow_dispatch. Outros = erro (nunca avalia às cegas).
  async function rodar(evento, ev) {
    const abertosTodos = await paginar(`/repos/${repo}/pulls?state=open`);
    const abertos = abertosTodos.filter((p) => !p.draft).length;
    const sweep = evento === 'schedule' || evento === 'workflow_dispatch';
    let numeros;
    let acaoEvento = null;
    if (sweep) {
      numeros = abertosTodos.map((p) => p.number);
    } else if (evento === 'workflow_run') {
      const wr = ev.workflow_run;
      numeros = (wr.pull_requests || []).map((p) => p.number);
      if (numeros.length === 0) numeros = abertosTodos.filter((p) => p.head && p.head.sha === wr.head_sha).map((p) => p.number);
    } else if (evento === 'pull_request_target') {
      numeros = [ev.pull_request.number];
      acaoEvento = ev.action;
    } else {
      throw new Error(`evento não suportado: ${evento} (a fila só roda com código da base)`);
    }
    const registros = [];
    for (const n of numeros) {
      const r = await avaliar(n, { acaoEvento, abertos });
      if (r) registros.push(r);
    }
    return { sweep, registros };
  }

  return { avaliar, rodar, paginar, houveErro: () => houveErro };
}
