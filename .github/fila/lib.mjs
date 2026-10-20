// Lógica pura da fila automática (ver spec-fila-automatica.md). Sem I/O: testável.
// Regra: a pior cor vence; na dúvida, vermelho; erro do robô não mergeia (tratado no run.mjs).

// Aprovadores do vermelho. João confirmado. Victor: login do GitHub não confirmado (item aberto).
export const APROVADORES = ['l0z4n0-a1'];
export const MIN_AMARELO_MS = 24 * 3600 * 1000;
export const LIMITE_FILA = 5;
export const CHAVES_CONFIG = ['vermelho', 'verde', 'checks_obrigatorios'];

// Sempre vermelho, em qualquer caminho e independente do fila.yml do repo (que é por repo e pode omitir):
// template de PR e CONTRIBUTING mudam o processo de contribuição. GitHub aceita qualquer caixa e a pasta PULL_REQUEST_TEMPLATE/.
export const SEMPRE_VERMELHO = [/(^|\/)pull_request_template(\.[^/]+)?$/i, /(^|\/)pull_request_template\//i, /(^|\/)contributing(\.[^/]+)?$/i];

const ORDEM = { verde: 0, amarelo: 1, vermelho: 2 };

// Glob mínimo: ** (qualquer caminho; "**/" também casa zero pastas), * (sem barra), ? (um caractere sem barra).
export function globToRegex(glob) {
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
    re += c.replace(/[.+^${}()|[\]\/]/g, '\$&');
    i += 1;
  }
  return new RegExp('^' + re + '$');
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

// Cor por arquivo: vermelho se casa com a lista vermelha (vence mesmo se casar com verde);
// verde se casa com a verde; o resto é amarelo. Cor do PR = a pior. Sem arquivos = vermelho.
export function corDosArquivos(arquivos, cfg) {
  if (!Array.isArray(arquivos) || arquivos.length === 0) {
    return { cor: 'vermelho', motivo: 'sem arquivos (dúvida)' };
  }
  const reVerm = cfg.vermelho.map(globToRegex);
  const reVerde = cfg.verde.map(globToRegex);
  let pior = 'verde';
  let exemplo = null;
  for (const f of arquivos) {
    let cor;
    if (SEMPRE_VERMELHO.some((r) => r.test(f)) || reVerm.some((r) => r.test(f))) cor = 'vermelho';
    else if (reVerde.some((r) => r.test(f))) cor = 'verde';
    else cor = 'amarelo';
    if (ORDEM[cor] > ORDEM[pior]) { pior = cor; exemplo = f; }
  }
  return { cor: pior, motivo: exemplo ? `pior arquivo: ${exemplo}` : 'só verde' };
}

// Checks do commit, ignorando os do próprio robô (nome começa com "fila").
// Estado: 'falha' | 'pendente' | 'ok' | 'nenhum' (sem checks = vacuamente ok, sinalizado no relatório).
export function estadoChecks(runs, obrigatorios = []) {
  const outros = runs.filter((r) => !/^fila\b/i.test(r.name));
  const falhas = [];
  const pendentes = [];
  for (const r of outros) {
    if (r.status !== 'completed') pendentes.push(r.name);
    else if (!['success', 'neutral', 'skipped'].includes(r.conclusion)) falhas.push(r.name);
  }
  for (const nome of obrigatorios) {
    const achados = outros.filter((r) => r.name === nome).sort((a, b) => b.id - a.id);
    if (achados.length === 0) pendentes.push(`${nome} (ausente)`);
    else if (achados[0].status !== 'completed') pendentes.push(nome);
    else if (achados[0].conclusion !== 'success') falhas.push(nome);
  }
  if (falhas.length) return { estado: 'falha', nomes: falhas };
  if (pendentes.length) return { estado: 'pendente', nomes: pendentes };
  if (outros.length === 0 && obrigatorios.length === 0) return { estado: 'nenhum', nomes: [] };
  return { estado: 'ok', nomes: [] };
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
export function decidir({ draft, mergeable, labels, cor, checks, idadeMs, mudancasPedidas, aprovado, minAmareloMs = MIN_AMARELO_MS }) {
  const espera = (motivo, esperando) => ({ acao: 'espera', motivo, esperando });
  if (draft) return espera('rascunho nunca mergeia', 'autor (rascunho)');
  if (labels.includes('fila:segura')) return { acao: 'segura', motivo: 'fila:segura', esperando: 'quem pôs fila:segura' };
  if (!Object.prototype.hasOwnProperty.call(ORDEM, cor)) return espera('cor indefinida (dúvida = vermelho)', 'João (classificar)');
  if (checks.estado === 'falha') return espera(`checks falhando: ${checks.nomes.join(', ')}`, 'autor (checks)');
  if (checks.estado === 'pendente') return espera(`checks em andamento: ${checks.nomes.join(', ')}`, 'tempo');
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
