// Driver da fila automática: lê o evento, busca dados no GitHub, chama lib.mjs, aplica rótulo/merge/comentário.
// Erro do próprio robô = não mergeia, comenta o motivo no PR e falha o job.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseFilaYaml, corDosArquivos, estadoChecks, aprovacaoEMudancas, decidir, LIMITE_FILA,
} from './lib.mjs';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const API = 'https://api.github.com';
const COR_LABEL = { verde: 'fila:verde', amarelo: 'fila:amarelo', vermelho: 'fila:vermelho' };
const ROTULOS = [
  { name: 'fila:verde', color: '0e8a16', description: 'fila: entra sozinho' },
  { name: 'fila:amarelo', color: 'fbca04', description: 'fila: entra após 24h sem objeção' },
  { name: 'fila:vermelho', color: 'd93f0b', description: 'fila: precisa de aprovação' },
  { name: 'fila:segura', color: '5319e7', description: 'fila: congela o PR' },
];
const TRUNCADO = 3000; // limite da API de arquivos do PR
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rotulosCriados = false;

async function gh(method, path, body, { ok404 = false } = {}) {
  for (let t = 0; ; t++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && ok404) return null;
    if (res.status >= 500 && t < 3) { await sleep(2000 * (t + 1)); continue; }
    if (!res.ok) {
      const txt = await res.text();
      const e = new Error(`${method} ${path} -> ${res.status}: ${txt.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

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
    const r = await gh('GET', `/repos/${REPO}/commits/${sha}/check-runs?per_page=100&page=${p}`);
    runs.push(...r.check_runs);
    if (runs.length >= r.total_count || r.check_runs.length === 0) break;
  }
  return runs;
}

async function garantirRotulos() {
  if (rotulosCriados) return;
  for (const l of ROTULOS) {
    try { await gh('POST', `/repos/${REPO}/labels`, l); } catch (e) {
      // 422 = já existe. Outro erro (ex.: token sem permissão de issues) não derruba o robô: rótulo tem que existir.
      if (e.status !== 422) console.warn(`aviso: não criei rótulo ${l.name}: ${e.message}`);
    }
  }
  rotulosCriados = true;
}

async function comentar(numero, marca, texto) {
  const cs = await paginar(`/repos/${REPO}/issues/${numero}/comments`);
  if (cs.some((c) => c.body && c.body.includes(marca))) return;
  await gh('POST', `/repos/${REPO}/issues/${numero}/comments`, { body: `${marca}\n${texto}` });
}

async function ajustarRotulo(numero, labelsAtuais, cor) {
  await garantirRotulos();
  const alvo = COR_LABEL[cor];
  for (const l of labelsAtuais) {
    if (Object.values(COR_LABEL).includes(l) && l !== alvo) {
      await gh('DELETE', `/repos/${REPO}/issues/${numero}/labels/${encodeURIComponent(l)}`, null, { ok404: true });
    }
  }
  if (!labelsAtuais.includes(alvo)) {
    await gh('POST', `/repos/${REPO}/issues/${numero}/labels`, { labels: [alvo] });
  }
}

const titulo12 = (t) => t.split(/\s+/).slice(0, 12).join(' ');

// Avalia um PR. Retorna o registro para fila.json, ou null se o PR não está aberto.
async function avaliar(numero, { acaoEvento, abertos }) {
  let pr = await gh('GET', `/repos/${REPO}/pulls/${numero}`);
  if (pr.state !== 'open') return null;
  for (let t = 0; pr.mergeable === null && t < 6; t++) {
    await sleep(5000);
    pr = await gh('GET', `/repos/${REPO}/pulls/${numero}`);
  }
  const sha = pr.head.sha;
  const marcaErro = `<!-- fila-erro:${sha} -->`;
  try {
    const arquivos = await paginar(`/repos/${REPO}/pulls/${numero}/files`, 30);
    const cfgResp = await gh('GET', `/repos/${REPO}/contents/.github/fila.yml?ref=${pr.base.sha}`, null, { ok404: true });
    if (!cfgResp) throw new Error('.github/fila.yml ausente na base do PR (sem config, não classifica)');
    const cfg = parseFilaYaml(Buffer.from(cfgResp.content, 'base64').toString('utf8'));
    const commit = await gh('GET', `/repos/${REPO}/commits/${sha}`);
    const idadeMs = Date.now() - new Date(commit.commit.committer.date).getTime();
    const revisoes = await paginar(`/repos/${REPO}/pulls/${numero}/reviews`);
    const checks = estadoChecks(await checksDoCommit(sha), cfg.checks_obrigatorios);
    const { aprovado, mudancasPedidas } = aprovacaoEMudancas(revisoes, sha);
    const labels = pr.labels.map((l) => l.name);

    const cls = arquivos.length >= TRUNCADO
      ? { cor: 'vermelho', motivo: 'lista de arquivos truncada (dúvida)' }
      : corDosArquivos(arquivos.map((f) => f.filename), cfg);
    const dec = decidir({
      draft: pr.draft, mergeable: pr.mergeable, labels, cor: cls.cor, checks,
      idadeMs, mudancasPedidas, aprovado,
    });

    // Fila cheia: só avisa no PR recém-aberto, uma vez.
    if (acaoEvento === 'opened' && !pr.draft && abertos > LIMITE_FILA) {
      await comentar(numero, '<!-- fila-cheia -->', `fila cheia: esvaziar antes (${abertos} PRs abertos, limite ${LIMITE_FILA}). O robô não bloqueia; avisa.`);
    }

    await ajustarRotulo(numero, labels, cls.cor);

    let acao = dec.acao;
    if (dec.acao === 'merge') {
      try {
        await gh('PUT', `/repos/${REPO}/pulls/${numero}/merge`, { merge_method: 'squash', sha });
        acao = 'mesclado';
        if (pr.head.repo && pr.head.repo.full_name === REPO) {
          const ref = pr.head.ref.split('/').map(encodeURIComponent).join('/');
          await gh('DELETE', `/repos/${REPO}/git/refs/heads/${ref}`, null, { ok404: true });
        }
      } catch (e) {
        await comentar(numero, marcaErro, `fila: merge recusado pelo GitHub (${e.message}). Não mergeou; ver o job.`);
        acao = 'erro';
      }
    }
    console.log(`PR #${numero} cor=${cls.cor} acao=${acao} motivo="${dec.motivo}" (${cls.motivo}) checks=${checks.estado}`);
    return {
      repo: REPO, pr: numero, titulo: titulo12(pr.title), cor: cls.cor, acao,
      idade_h: Math.floor(idadeMs / 3600000), esperando: dec.esperando, motivo: dec.motivo,
    };
  } catch (e) {
    console.error(`PR #${numero} ERRO do robô: ${e.message}`);
    await comentar(numero, marcaErro, `fila: erro do robô, não mergeia. Motivo: ${e.message}`).catch(() => {});
    process.exitCode = 1;
    return { repo: REPO, pr: numero, titulo: titulo12(pr.title), cor: 'vermelho', acao: 'erro', idade_h: null, esperando: 'robô (ver job)', motivo: e.message };
  }
}

async function main() {
  const ev = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const evento = process.env.GITHUB_EVENT_NAME;
  const abertosTodos = await paginar(`/repos/${REPO}/pulls?state=open`);
  const abertos = abertosTodos.filter((p) => !p.draft).length;
  const sweep = evento === 'schedule' || evento === 'workflow_dispatch';
  let numeros;
  let acaoEvento = null;
  if (sweep) {
    numeros = abertosTodos.map((p) => p.number);
  } else if (evento === 'check_suite') {
    numeros = (ev.check_suite.pull_requests || []).map((p) => p.number);
  } else {
    numeros = [ev.pull_request.number];
    acaoEvento = ev.action;
  }
  const registros = [];
  for (const n of numeros) {
    const r = await avaliar(n, { acaoEvento, abertos });
    if (r) registros.push(r);
  }
  if (sweep) {
    const naFila = registros.filter((r) => r.acao !== 'mesclado');
    writeFileSync('fila.json', JSON.stringify({ gerado: new Date().toISOString(), repo: REPO, itens: naFila }, null, 2));
    console.log(`fila.json: ${naFila.length} PR(s) na fila`);
  }
}

main().catch((e) => { console.error('FALHA GERAL:', e.message); process.exit(1); });
