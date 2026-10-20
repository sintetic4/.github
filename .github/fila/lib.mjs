// Lógica pura da fila automática (ver spec-fila-automatica.md). Sem I/O: testável.
// Regra: a pior cor vence; na dúvida, vermelho; erro do robô não mergeia (tratado no run.mjs).

// Aprovadores do vermelho. João confirmado. Victor: login do GitHub não confirmado (item aberto).
export const APROVADORES = ['l0z4n0-a1'];
export const MIN_AMARELO_MS = 24 * 3600 * 1000;
export const LIMITE_FILA = 5;
export const CHAVES_CONFIG = ['vermelho', 'verde', 'checks_obrigatorios'];

// Sempre vermelho, em qualquer caminho e independente do fila.yml do repo (que é por repo e pode omitir):
// .github/** (workflows, fila.yml, templates) é o próprio robô e o CI: nunca entra sozinho (ver tocaGithub).
// template de PR e CONTRIBUTING mudam o processo de contribuição. GitHub aceita qualquer caixa e a pasta PULL_REQUEST_TEMPLATE/.
export const SEMPRE_VERMELHO = [/^\.github(\/|$)/i, /(^|\/)pull_request_template(\.[^/]+)?$/i, /(^|\/)pull_request_template\//i, /(^|\/)contributing(\.[^/]+)?$/i];

const ORDEM = { verde: 0, amarelo: 1, vermelho: 2 };

// Glob mínimo: ** (qualquer caminho; "**/" também casa zero pastas), * (sem barra), ? (um caractere sem barra).
export function globToRegex(glob, flags = '') {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    i += 1;
  }
  return new RegExp('^' + re + '$', flags + 's');
}

// Subconjunto de YAML do fila.yml: chaves de topo + listas de strings entre aspas.
export function parseFilaYaml(texto) {
  const out = {};
  let chave = null;
  for (const raw of texto.split(/\r?\n/)) {
    const linha = raw.replace(/\s+$/, '');
    if (!linha.trim() || linha.trim().startsWith('#')) continue;
    let m = linha.match(/^([a-z_]+):\s*(#.*)?$/);
    if (m) {
      if (!CHAVES_CONFIG.includes(m[1])) throw new Error(`fila.yml: chave desconhecida "${m[1]}"`);
      chave = m[1];
      out[chave] = [];
      continue;
    }
    m = linha.match(/^\s*-\s*"([^"]*)"\s*(#.*)?$/) || linha.match(/^\s*-\s*'([^']*)'\s*(#.*)?$/);
    if (m && chave) { out[chave].push(m[1]); continue; }
    throw new Error(`fila.yml: linha não reconhecida: ${raw}`);
  }
  if (!out.vermelho || !out.verde) throw new Error('fila.yml: faltam as listas "vermelho" e "verde"');
  out.checks_obrigatorios = out.checks_obrigatorios || [];
  return out;
}

// Caminhos que um arquivo do PR "toca": o atual E o anterior (rename). Aceita string ou objeto da API de arquivos.
export function caminhosDoArquivo(f) {
  if (typeof f === 'string') return [f];
  return [f.filename, f.previous_filename].filter((x) => typeof x === 'string' && x.length > 0);
}

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

// Cor de um caminho. Vermelho: case-insensitive (mais restritivo; FS de Windows/macOS ignoram caixa) e também
// com "\" tratado como "/". Verde: case-sensitive (se errar a caixa cai em amarelo, o lado seguro).
function corDoCaminho(p, reVerm, reVerde) {
  const n = norm(p);
  if (SEMPRE_VERMELHO.some((r) => r.test(p) || r.test(n)) || reVerm.some((r) => r.test(p) || r.test(n))) return 'vermelho';
  if (reVerde.some((r) => r.test(p))) return 'verde';
  return 'amarelo';
}

// Cor por arquivo: vermelho se casa com a lista vermelha (vence mesmo se casar com verde);
// verde se casa com a verde; o resto é amarelo. Cor do PR = a pior. Sem arquivos = vermelho.
// Rename: vale o pior entre filename e previous_filename. Deleção é classificada pelo caminho removido.
export function corDosArquivos(arquivos, cfg) {
  if (!Array.isArray(arquivos) || arquivos.length === 0) {
    return { cor: 'vermelho', motivo: 'sem arquivos (dúvida)' };
  }
  const reVerm = cfg.vermelho.map((g) => globToRegex(g, 'i'));
  const reVerde = cfg.verde.map((g) => globToRegex(g));
  let pior = 'verde';
  let exemplo = null;
  for (const f of arquivos) {
    const caminhos = caminhosDoArquivo(f);
    if (caminhos.length === 0) { pior = 'vermelho'; exemplo = '(arquivo sem nome)'; continue; }
    for (const p of caminhos) {
      const cor = corDoCaminho(p, reVerm, reVerde);
      if (ORDEM[cor] > ORDEM[pior]) { pior = cor; exemplo = p; }
    }
  }
  return { cor: pior, motivo: exemplo ? `pior arquivo: ${exemplo}` : 'só verde' };
}

// PR que toca .github/** (inclusive como origem de rename/deleção): o job de merge recusa, mesmo aprovado.
export function tocaGithub(arquivos) {
  return (arquivos || []).some((f) => caminhosDoArquivo(f).some((p) => /^\.github(\/|$)/i.test(norm(p))));
}

// Instante que abre a janela do amarelo: o push do commit atual (API de atividade) ou, sem ele, o updated_at do PR
// (conservador: nunca anterior ao push). Nunca antes de created_at. Não usa committer.date (o autor controla).
export function instanteDoEvento({ pushIso, updatedIso, createdIso }) {
  const t = [pushIso || updatedIso, createdIso].map((x) => Date.parse(x)).filter((n) => Number.isFinite(n));
  return t.length ? Math.max(...t) : null;
}

// Reserva por nome exato (formato "<job do caller> / <job do reusable>", NÃO confirmado até o 1º run). O mecanismo principal
// é o check_suite da run atual (ver driver.mjs). Configurável por FILA_CHECKS_PROPRIOS (lista separada por vírgula).
export const NOMES_PROPRIOS = ['fila / fila'];
export const nomesProprios = (env) => (env && env.trim() ? env.split(',').map((x) => x.trim()).filter(Boolean) : NOMES_PROPRIOS);

const ehProprio = (r, proprios, runId, checkSuiteId) => proprios.includes(r.name)
  || Boolean(checkSuiteId && r.check_suite && r.check_suite.id === checkSuiteId)
  || Boolean(runId && typeof r.details_url === 'string' && r.details_url.includes(`/actions/runs/${runId}/`));

// Checks do commit, sem os do próprio robô (nome exato ou run atual).
// Estado: 'falha' | 'pendente' | 'sem_obrigatorios' (config sem checks_obrigatorios) | 'nenhum' (nada registrado) | 'ok'.
// Ausência de checks NUNCA é verde: 'nenhum' e 'sem_obrigatorios' não mergeiam sozinhos.
export function estadoChecks(runs, obrigatorios = [], { proprios = NOMES_PROPRIOS, runId = null, checkSuiteId = null } = {}) {
  const outros = runs.filter((r) => !ehProprio(r, proprios, runId, checkSuiteId));
  const ignorados = runs.filter((r) => !outros.includes(r)).map((r) => r.name);
  const falhas = [];
  const pendentes = [];
  for (const r of outros) {
    if (r.status !== 'completed') pendentes.push(r.name);
    else if (!['success', 'neutral', 'skipped'].includes(r.conclusion)) falhas.push(r.name);
  }
  for (const nome of obrigatorios) {
    // obrigatório só vale se vier do GitHub Actions (quando o app é informado)
    const achados = outros.filter((r) => r.name === nome && (!r.app || r.app.slug === 'github-actions')).sort((a, b) => b.id - a.id);
    if (achados.length === 0) pendentes.push(`${nome} (ausente)`);
    else if (achados[0].status !== 'completed') pendentes.push(nome);
    else if (achados[0].conclusion !== 'success') falhas.push(nome);
  }
  if (falhas.length) return { estado: 'falha', nomes: falhas, ignorados };
  if (pendentes.length) return { estado: 'pendente', nomes: pendentes, ignorados };
  if (obrigatorios.length === 0) return { estado: 'sem_obrigatorios', nomes: [], ignorados };
  if (outros.length === 0) return { estado: 'nenhum', nomes: [], ignorados };
  return { estado: 'ok', nomes: [], ignorados };
}

// Revisão efetiva: a última decisiva (APPROVED / CHANGES_REQUESTED / DISMISSED) por pessoa; DISMISSED sai.
export function revisaoEfetiva(reviews) {
  const ult = new Map();
  const ordenadas = [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  for (const r of ordenadas) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    ult.set(r.user.login.toLowerCase(), r);
  }
  return [...ult.values()].filter((r) => r.state !== 'DISMISSED');
}

// Aprovação conta só se for de aprovador e no commit atual (push novo invalida).
export function aprovacaoEMudancas(reviews, shaHead, aprovadores = APROVADORES) {
  const ef = revisaoEfetiva(reviews);
  const lista = aprovadores.map((a) => a.toLowerCase());
  const aprovado = ef.some((r) => r.state === 'APPROVED' && r.commit_id === shaHead
    && lista.includes(r.user.login.toLowerCase()));
  const mudancasPedidas = ef.some((r) => r.state === 'CHANGES_REQUESTED');
  return { aprovado, mudancasPedidas };
}

// Decisão final. acao: 'merge' | 'espera' | 'segura'.
export function decidir({ draft, mergeable, labels, cor, checks, idadeMs, mudancasPedidas, aprovado, bloqueioGithub = false, minAmareloMs = MIN_AMARELO_MS }) {
  const espera = (motivo, esperando) => ({ acao: 'espera', motivo, esperando });
  if (draft) return espera('rascunho nunca mergeia', 'autor (rascunho)');
  if (labels.includes('fila:segura')) return { acao: 'segura', motivo: 'fila:segura', esperando: 'quem pôs fila:segura' };
  if (bloqueioGithub) return espera('toca .github/**: merge só manual', 'João (merge manual)');
  if (!Object.prototype.hasOwnProperty.call(ORDEM, cor)) return espera('cor indefinida (dúvida = vermelho)', 'João (classificar)');
  if (checks.estado === 'falha') return espera(`checks falhando: ${checks.nomes.join(', ')}`, 'autor (checks)');
  if (checks.estado === 'pendente') return espera(`checks em andamento: ${checks.nomes.join(', ')}`, 'tempo');
  if (checks.estado !== 'ok') return espera(`sem checks para confiar (${checks.estado}): não mergeia sozinho`, 'João (sem CI)');
  if (mergeable === false) return espera('conflito com a base', 'autor (conflito)');
  if (mergeable !== true) return espera('mergeabilidade ainda calculando', 'tempo');
  if (mudancasPedidas) return espera('review pedindo mudança', 'autor (mudanças pedidas)');
  if (cor === 'verde') return { acao: 'merge', motivo: 'verde', esperando: '-' };
  if (cor === 'amarelo') {
    if (idadeMs < minAmareloMs) {
      const falta = Math.ceil((minAmareloMs - idadeMs) / 3600000);
      return espera(`amarelo: faltam ${falta}h da janela de 24h`, `tempo (${falta}h)`);
    }
    return { acao: 'merge', motivo: 'amarelo após 24h', esperando: '-' };
  }
  // vermelho
  if (!aprovado) return espera('vermelho: aguarda aprovação (João)', 'João (aprovar)');
  return { acao: 'merge', motivo: 'vermelho aprovado', esperando: '-' };
}
