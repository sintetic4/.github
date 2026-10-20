// Testes do driver com GitHub simulado: merge, sha, mergeable, base, config da base, idade, eventos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarDriver } from './driver.mjs';

const REPO = 'o/r';
const SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const AGORA = Date.parse('2026-10-20T12:00:00Z');
const H = 3600000;
const YAML = 'vermelho:\n  - "scripts/**"\nverde:\n  - "**/*.md"\nchecks_obrigatorios:\n  - "validate"\n';
const iso = (ms) => new Date(ms).toISOString();

function mundo(over = {}) {
  const w = {
    pr: {
      number: 7, state: 'open', draft: false, mergeable: true, title: 'x', labels: [],
      created_at: iso(AGORA - 100 * H), updated_at: iso(AGORA - 100 * H),
      head: { sha: SHA, ref: 'feat/x', repo: { full_name: REPO } }, base: { ref: 'main', sha: BASE_SHA },
    },
    files: [{ filename: 'docs/a.md', status: 'modified' }],
    yaml: YAML,
    reviews: [],
    checks: [{ id: 1, name: 'validate', status: 'completed', conclusion: 'success' }],
    activity: [{ after: SHA, timestamp: iso(AGORA - 50 * H) }],
    comments: [],
    mergeErro: null,
    abertos: null,
    ...over,
  };
  w.calls = [];
  w.gh = async (method, path, body, opts = {}) => {
    w.calls.push({ method, path, body });
    const m = (re) => path.match(re);
    if (method === 'GET' && m(/^\/repos\/o\/r$/)) return { default_branch: 'main' };
    if (method === 'GET' && m(/^\/repos\/o\/r\/pulls\?state=open/)) return w.abertos || [w.pr];
    if (method === 'GET' && m(/^\/repos\/o\/r\/pulls\/\d+$/)) {
      if (w.sequenciaMergeable && w.sequenciaMergeable.length) w.pr = { ...w.pr, mergeable: w.sequenciaMergeable.shift() };
      return w.pr;
    }
    if (method === 'GET' && m(/\/pulls\/\d+\/files/)) return w.files;
    if (method === 'GET' && m(/\/contents\/\.github\/fila\.yml\?ref=(\w+)/)) {
      w.refConfig = m(/ref=(\w+)/)[1];
      return w.yaml === null ? null : { content: Buffer.from(w.yaml).toString('base64') };
    }
    if (method === 'GET' && m(/\/activity\?/)) return w.activity;
    if (method === 'GET' && m(/\/pulls\/\d+\/reviews/)) return w.reviews;
    if (method === 'GET' && m(/\/check-runs/)) return { total_count: w.checks.length, check_runs: w.checks };
    if (method === 'GET' && m(/\/comments/)) return w.comments;
    if (method === 'POST' && m(/\/comments$/)) { w.comments.push(body); return {}; }
    if (method === 'POST' && m(/\/labels$/)) return {};
    if (method === 'DELETE' && m(/\/labels\//)) return null;
    if (method === 'PUT' && m(/\/merge$/)) { if (w.mergeErro) throw w.mergeErro; return { merged: true }; }
    if (method === 'DELETE' && m(/\/git\/refs\//)) return null;
    throw new Error(`mock: rota inesperada ${method} ${path} ${opts && ''}`);
  };
  return w;
}
const drv = (w) => criarDriver({ gh: w.gh, repo: REPO, runId: '99', agora: () => AGORA, sleep: async () => {}, log: { log() {}, warn() {}, error() {} } });
const merges = (w) => w.calls.filter((c) => c.method === 'PUT');

test('verde com check ok mergeia com squash e o sha avaliado; apaga a branch', async () => {
  const w = mundo();
  const r = await drv(w).avaliar(7);
  assert.equal(r.acao, 'mesclado');
  assert.deepEqual(merges(w)[0].body, { merge_method: 'squash', sha: SHA });
  assert.ok(w.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/git/refs/heads/feat/x')));
});

test('config vem da BASE (sha da base), nao do head', async () => {
  const w = mundo();
  await drv(w).avaliar(7);
  assert.equal(w.refConfig, BASE_SHA);
});

test('sem fila.yml na base: erro do robo, nao mergeia, comenta', async () => {
  const w = mundo({ yaml: null });
  const d = drv(w);
  const r = await d.avaliar(7);
  assert.equal(r.acao, 'erro');
  assert.equal(merges(w).length, 0);
  assert.equal(d.houveErro(), true);
  assert.match(w.comments[0].body, /erro do robô/);
});

test('mergeable false / null (sempre) nao mergeia', async () => {
  for (const mergeable of [false, null]) {
    const w = mundo(); w.pr.mergeable = mergeable;
    const r = await drv(w).avaliar(7);
    assert.equal(r.acao, 'espera', String(mergeable));
    assert.equal(merges(w).length, 0);
  }
});

test('mergeable null resolve apos retentativa e mergeia', async () => {
  const w = mundo(); w.pr.mergeable = null; w.sequenciaMergeable = [null, true];
  const r = await drv(w).avaliar(7);
  assert.equal(r.acao, 'mesclado');
});

test('merge recusado pelo GitHub (ex.: sha mudou, 409): acao=erro, comenta, sem apagar branch', async () => {
  const e = new Error('PUT -> 409: Head branch was modified'); e.status = 409;
  const w = mundo({ mergeErro: e });
  const r = await drv(w).avaliar(7);
  assert.equal(r.acao, 'erro');
  assert.match(w.comments[0].body, /merge recusado/);
  assert.ok(!w.calls.some((c) => c.method === 'DELETE' && c.path.includes('/git/refs/')));
});

test('PR com base fora da branch padrao e ignorado', async () => {
  const w = mundo(); w.pr.base.ref = 'release';
  assert.equal(await drv(w).avaliar(7), null);
  assert.equal(merges(w).length, 0);
});

test('PR fechado e ignorado; rascunho nunca mergeia', async () => {
  const f = mundo(); f.pr.state = 'closed';
  assert.equal(await drv(f).avaliar(7), null);
  const d = mundo(); d.pr.draft = true;
  assert.equal((await drv(d).avaliar(7)).acao, 'espera');
  assert.equal(merges(d).length, 0);
});

test('(a) rename vindo de scripts/ torna vermelho e nao mergeia', async () => {
  const w = mundo({ files: [{ filename: 'docs/a.md', previous_filename: 'scripts/run.py', status: 'renamed' }] });
  const r = await drv(w).avaliar(7);
  assert.equal(r.cor, 'vermelho');
  assert.equal(r.acao, 'espera');
  assert.equal(merges(w).length, 0);
});

test('(c) PR que toca .github/** nao mergeia nem aprovado por socio', async () => {
  const aprov = [{ user: { login: 'l0z4n0-a1' }, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-10-20T00:00:00Z' }];
  const w = mundo({ files: [{ filename: '.github/workflows/fila-caller.yml', status: 'modified' }], reviews: aprov });
  const r = await drv(w).avaliar(7);
  assert.equal(r.cor, 'vermelho');
  assert.equal(r.acao, 'espera');
  assert.match(r.motivo, /merge só manual/);
  assert.equal(merges(w).length, 0);
});

test('vermelho aprovado no commit atual mergeia; aprovacao de commit antigo nao', async () => {
  const f = [{ filename: 'scripts/x.py', status: 'modified' }];
  const rv = (commit_id) => [{ user: { login: 'l0z4n0-a1' }, state: 'APPROVED', commit_id, submitted_at: '2026-10-20T00:00:00Z' }];
  assert.equal((await drv(mundo({ files: f, reviews: rv(SHA) })).avaliar(7)).acao, 'mesclado');
  const w = mundo({ files: f, reviews: rv('c'.repeat(40)) });
  assert.equal((await drv(w).avaliar(7)).acao, 'espera');
  assert.equal(merges(w).length, 0);
});

test('check obrigatorio ausente ou falhando: nao mergeia', async () => {
  for (const checks of [[], [{ id: 1, name: 'validate', status: 'completed', conclusion: 'failure' }], [{ id: 1, name: 'validate', status: 'in_progress' }]]) {
    const w = mundo({ checks });
    assert.equal((await drv(w).avaliar(7)).acao, 'espera');
    assert.equal(merges(w).length, 0);
  }
});

test('fila.yml sem checks_obrigatorios: nao mergeia sozinho (sinaliza)', async () => {
  const w = mundo({ yaml: 'vermelho:\n  - "scripts/**"\nverde:\n  - "**/*.md"\n' });
  const r = await drv(w).avaliar(7);
  assert.equal(r.acao, 'espera');
  assert.match(r.motivo, /sem_obrigatorios/);
});

test('o check do proprio robo ("fila / fila") nao bloqueia; "fila-x" falhando bloqueia', async () => {
  const proprio = { id: 2, name: 'fila / fila', status: 'in_progress' };
  const ok = mundo(); ok.checks.push(proprio);
  assert.equal((await drv(ok).avaliar(7)).acao, 'mesclado');
  const ruim = mundo(); ruim.checks.push({ id: 3, name: 'fila-x', status: 'completed', conclusion: 'failure' });
  assert.equal((await drv(ruim).avaliar(7)).acao, 'espera');
});

test('amarelo: idade vem do push do commit atual, nao do committer.date', async () => {
  const f = [{ filename: 'src/app.ts', status: 'modified' }];
  // push ha 2h (commit pode ter data antiga forjada): espera
  const novo = mundo({ files: f, activity: [{ after: SHA, timestamp: iso(AGORA - 2 * H) }] });
  novo.pr.updated_at = iso(AGORA - 2 * H);
  const r1 = await drv(novo).avaliar(7);
  assert.equal(r1.acao, 'espera');
  assert.equal(r1.idade_h, 2);
  // push ha 30h: mergeia
  const velho = mundo({ files: f, activity: [{ after: SHA, timestamp: iso(AGORA - 30 * H) }] });
  assert.equal((await drv(velho).avaliar(7)).acao, 'mesclado');
});

test('amarelo: sem dado de push usa updated_at (conservador); atividade de outro sha ignorada', async () => {
  const f = [{ filename: 'src/app.ts', status: 'modified' }];
  const w = mundo({ files: f, activity: [{ after: 'd'.repeat(40), timestamp: iso(AGORA - 90 * H) }] });
  w.pr.updated_at = iso(AGORA - 3 * H);
  assert.equal((await drv(w).avaliar(7)).acao, 'espera');
  const falha = mundo({ files: f });
  const base = falha.gh;
  falha.gh = async (m, p, ...r) => { if (p.includes('/activity?')) throw new Error('boom'); return base(m, p, ...r); };
  falha.pr.updated_at = iso(AGORA - 3 * H);
  assert.equal((await drv(falha).avaliar(7)).acao, 'espera');
});

test('rotulo fila:segura congela', async () => {
  const w = mundo(); w.pr.labels = [{ name: 'fila:segura' }];
  assert.equal((await drv(w).avaliar(7)).acao, 'segura');
  assert.equal(merges(w).length, 0);
});

test('lista de arquivos truncada (3000) = vermelho e bloqueio manual', async () => {
  const files = Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md` }));
  const w = mundo({ files });
  const r = await drv(w).avaliar(7);
  assert.equal(r.cor, 'vermelho');
  assert.equal(merges(w).length, 0);
});

test('eventos: pull_request_target, workflow_run (com e sem pull_requests), sweep; evento perigoso recusado', async () => {
  const w = mundo();
  const a = await drv(w).rodar('pull_request_target', { action: 'opened', pull_request: { number: 7 } });
  assert.equal(a.registros[0].acao, 'mesclado');
  const b = await drv(mundo()).rodar('workflow_run', { workflow_run: { pull_requests: [{ number: 7 }], head_sha: SHA } });
  assert.equal(b.registros.length, 1);
  const c = await drv(mundo()).rodar('workflow_run', { workflow_run: { pull_requests: [], head_sha: SHA } });
  assert.equal(c.registros.length, 1);
  const d = await drv(mundo()).rodar('workflow_run', { workflow_run: { pull_requests: [], head_sha: 'e'.repeat(40) } });
  assert.equal(d.registros.length, 0);
  const s = await drv(mundo()).rodar('schedule', {});
  assert.equal(s.sweep, true);
  for (const ev of ['pull_request', 'pull_request_review', 'check_suite', 'push']) {
    await assert.rejects(() => drv(mundo()).rodar(ev, {}), /não suportado/);
  }
});

test('fila cheia: avisa uma vez no PR recem-aberto, sem bloquear', async () => {
  const outros = Array.from({ length: 6 }, (_, i) => ({ number: 100 + i, draft: false, head: { sha: 'z' } }));
  const w = mundo({ abertos: outros });
  w.checks = [];
  await drv(w).rodar('pull_request_target', { action: 'opened', pull_request: { number: 7 } });
  assert.ok(w.comments.some((c) => c.body.includes('fila cheia')));
});
