// Testes dos achados da revisão cega (Codex). Cada teste falha sem a correção correspondente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  globToRegex, parseFilaYaml, corDosArquivos, estadoChecks, decidir, tocaGithub, instanteDoEvento,
} from './lib.mjs';

const CFG = parseFilaYaml(`
vermelho:
  - "scripts/**"
  - "infra/**"
verde:
  - "docs/**"
  - "**/*.md"
`);
const H = 3600000;
const ok = (over = {}) => ({ draft: false, mergeable: true, labels: [], cor: 'verde', checks: { estado: 'ok', nomes: [] }, idadeMs: 0, mudancasPedidas: false, aprovado: false, ...over });
const run = (name, over = {}) => ({ id: 1, name, status: 'completed', conclusion: 'success', ...over });

test('checks: ausencia nao e verde (nenhum / sem_obrigatorios)', () => {
  assert.equal(estadoChecks([], []).estado, 'sem_obrigatorios');
  assert.equal(estadoChecks([run('test')], []).estado, 'sem_obrigatorios');
  assert.equal(estadoChecks([], ['validate']).estado, 'pendente');
  assert.equal(estadoChecks([run('validate')], ['validate']).estado, 'ok');
  assert.equal(estadoChecks([run('fila / fila')], ['validate']).nomes[0], 'validate (ausente)');
  for (const estado of ['nenhum', 'sem_obrigatorios']) {
    const d = decidir(ok({ checks: { estado, nomes: [] } }));
    assert.equal(d.acao, 'espera', estado);
    assert.match(d.motivo, /não mergeia sozinho/);
  }
});

test('checks: so o nome EXATO do robo e ignorado', () => {
  const falha = (n) => run(n, { conclusion: 'failure' });
  assert.equal(estadoChecks([falha('fila-lint')], ['x']).estado, 'falha');
  assert.equal(estadoChecks([falha('fila / fila-x')], ['x']).estado, 'falha');
  assert.equal(estadoChecks([falha('fila')], ['x']).estado, 'falha');
  assert.equal(estadoChecks([falha('fila / fila')], ['x']).estado, 'pendente');
  const propria = run('outro-nome', { status: 'in_progress', conclusion: null, details_url: 'https://github.com/o/r/actions/runs/777/job/9' });
  assert.equal(estadoChecks([propria], ['x'], { runId: '777' }).nomes[0], 'x (ausente)');
  assert.equal(estadoChecks([propria], ['x'], { runId: '778' }).nomes[0], 'outro-nome');
});

test('checks: obrigatorio so vale se vier do GitHub Actions (app ausente no mock vale)', () => {
  assert.equal(estadoChecks([run('validate', { app: { slug: 'outro-app' } })], ['validate']).estado, 'pendente');
  assert.equal(estadoChecks([run('validate', { app: { slug: 'github-actions' } })], ['validate']).estado, 'ok');
});

test('(a) rename: previous_filename sensivel torna o PR vermelho', () => {
  const ren = { filename: 'docs/x.md', previous_filename: 'scripts/deploy.py', status: 'renamed' };
  assert.equal(corDosArquivos([ren], CFG).cor, 'vermelho');
  assert.match(corDosArquivos([ren], CFG).motivo, /scripts\/deploy\.py/);
  assert.equal(corDosArquivos([{ filename: 'docs/b.md', previous_filename: 'docs/a.md' }], CFG).cor, 'verde');
  assert.equal(corDosArquivos([{ filename: 'scripts/x.py', previous_filename: 'docs/x.md' }], CFG).cor, 'vermelho');
});

test('(a) delecao de arquivo sensivel = vermelho; arquivo sem nome = vermelho', () => {
  assert.equal(corDosArquivos([{ filename: 'scripts/x.md', status: 'removed' }], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos([{ filename: 'docs/x.md', status: 'removed' }], CFG).cor, 'verde');
  assert.equal(corDosArquivos([{ status: 'modified' }], CFG).cor, 'vermelho');
});

test('(b) glob: metacaracteres de regex sao literais', () => {
  assert.ok(!globToRegex('**/*.md').test('infra/deploy-md'));
  assert.ok(globToRegex('**/*.md').test('infra/deploy.md'));
  assert.ok(!globToRegex('a.b').test('axb'));
  assert.ok(globToRegex('a+b(c)[d]{e}$^|.md').test('a+b(c)[d]{e}$^|.md'));
  assert.ok(!globToRegex('a+b').test('aab'));
  assert.ok(!globToRegex('src/*').test('src/a/b'));
  assert.ok(globToRegex('docs/**').test('docs/a\nb.md'));
  assert.equal(corDosArquivos(['infra/deploy-md'], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos(['outro/deploy-md'], CFG).cor, 'amarelo');
});

test('(b) caixa e barras: vermelho ignora caixa e "\\"; verde nao', () => {
  assert.equal(corDosArquivos(['Scripts/Run.py'], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos(['.GITHUB/Workflows/a.yml'], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos(['scripts\\x.txt'], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos(['./scripts/x.txt'], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos(['DOCS/a.txt'], CFG).cor, 'amarelo');
  assert.equal(corDosArquivos(['docs/a.txt'], CFG).cor, 'verde');
});

test('(c) .github/** e vermelho mesmo fora do fila.yml; tocaGithub pega rename e delecao', () => {
  const vazio = parseFilaYaml('vermelho:\n  - "x/**"\nverde:\n  - "**"\n');
  assert.equal(corDosArquivos(['.github/workflows/a.yml'], vazio).cor, 'vermelho');
  assert.equal(corDosArquivos(['.github/fila.yml'], vazio).cor, 'vermelho');
  assert.ok(tocaGithub(['.github/a']));
  assert.ok(tocaGithub([{ filename: 'docs/a.md', previous_filename: '.github/a.md' }]));
  assert.ok(tocaGithub([{ filename: '.GitHub/a', status: 'removed' }]));
  assert.ok(!tocaGithub(['docs/.github-x.md', 'a.md']));
});

test('(c) decidir: bloqueioGithub nunca mergeia (verde, amarelo velho, vermelho aprovado)', () => {
  for (const cor of ['verde', 'amarelo', 'vermelho']) {
    const d = decidir(ok({ cor, aprovado: true, idadeMs: 900 * H, bloqueioGithub: true }));
    assert.equal(d.acao, 'espera', cor);
    assert.match(d.motivo, /merge só manual/);
  }
});

test('idade do amarelo: push do commit atual, nao committer.date; sem push usa updated_at', () => {
  const t = Date.parse;
  assert.equal(instanteDoEvento({ pushIso: '2026-10-19T12:00:00Z', updatedIso: '2026-10-19T20:00:00Z', createdIso: '2026-10-01T00:00:00Z' }), t('2026-10-19T12:00:00Z'));
  assert.equal(instanteDoEvento({ pushIso: null, updatedIso: '2026-10-19T20:00:00Z', createdIso: '2026-10-01T00:00:00Z' }), t('2026-10-19T20:00:00Z'));
  assert.equal(instanteDoEvento({ pushIso: '2026-10-01T00:00:00Z', updatedIso: null, createdIso: '2026-10-19T00:00:00Z' }), t('2026-10-19T00:00:00Z'));
  assert.equal(instanteDoEvento({}), null);
});

test('nomesProprios: env configura; vazio usa o padrao', async () => {
  const { nomesProprios, NOMES_PROPRIOS } = await import('./lib.mjs');
  assert.deepEqual(nomesProprios('a / b, c'), ['a / b', 'c']);
  assert.deepEqual(nomesProprios(''), NOMES_PROPRIOS);
  assert.deepEqual(nomesProprios(undefined), NOMES_PROPRIOS);
});

test('check_suite da run atual e ignorado e listado em ignorados', () => {
  const runs = [run('qualquer', { check_suite: { id: 5 }, status: 'in_progress', conclusion: null }), run('validate')];
  const e = estadoChecks(runs, ['validate'], { checkSuiteId: 5 });
  assert.equal(e.estado, 'ok');
  assert.deepEqual(e.ignorados, ['qualquer']);
  assert.equal(estadoChecks(runs, ['validate'], { checkSuiteId: 6 }).estado, 'pendente');
});
