import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegex, parseFilaYaml, corDosArquivos, estadoChecks, aprovacaoEMudancas, decidir } from './lib.mjs';

const CFG = parseFilaYaml(`
vermelho:
  - ".github/**"   # robô e CI
  - "src/**/billing*"
  - "scripts/**"
verde:
  - "docs/**"
  - "**/*.md"
  - "**/*.css"
`);
const H = 3600000;
const ok = (over = {}) => ({ draft: false, mergeable: true, labels: [], cor: 'verde', checks: { estado: 'ok', nomes: [] }, idadeMs: 0, mudancasPedidas: false, aprovado: false, ...over });
const rev = (login, state, sha = 'abc', t = '2026-10-19T10:00:00Z') => ({ user: { login }, state, commit_id: sha, submitted_at: t });

test('glob: ** e * e zero pastas', () => {
  assert.ok(globToRegex('**/*.md').test('README.md'));
  assert.ok(globToRegex('**/*.md').test('docs/a/b.md'));
  assert.ok(!globToRegex('**/*.md').test('a.mdx'));
  assert.ok(globToRegex('src/**/billing*').test('src/billing.ts'));
  assert.ok(globToRegex('src/**/billing*').test('src/a/b/billing-x.ts'));
  assert.ok(!globToRegex('src/**/billing*').test('src/xbilling.ts'));
  assert.ok(globToRegex('.github/**').test('.github/workflows/fila.yml'));
  assert.ok(!globToRegex('.github/**').test('.githubx/a'));
});

test('yaml: subset do fila.yml e rejeição de linha estranha', () => {
  assert.deepEqual(parseFilaYaml('vermelho:\n  - "a"\nverde:\n  - "b.md"\n').verde, ['b.md']);
  assert.throws(() => parseFilaYaml('vermelho:\n  - a\nverde:\n'), /não reconhecida/);
  assert.throws(() => parseFilaYaml('vermelho:\nverde:\nxpto:\n'), /desconhecida/);
});

test('cor: pior vence; duvida = vermelho', () => {
  assert.equal(corDosArquivos(['README.md', 'docs/x.md'], CFG).cor, 'verde');
  assert.equal(corDosArquivos(['README.md', 'src/app.ts'], CFG).cor, 'amarelo');
  assert.equal(corDosArquivos(['README.md', '.github/workflows/a.yml'], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos(['scripts/x.md'], CFG).cor, 'vermelho');
  assert.equal(corDosArquivos([], CFG).cor, 'vermelho');
});

test('cor: template de PR e CONTRIBUTING sao vermelho em qualquer caminho, mesmo casando com verde', () => {
  for (const f of ['pull_request_template.md', '.github/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md',
    '.github/PULL_REQUEST_TEMPLATE/bug.md', 'CONTRIBUTING.md', 'docs/CONTRIBUTING.md', '.github/contributing.md']) {
    assert.equal(corDosArquivos(['README.md', f], CFG).cor, 'vermelho', f);
  }
  assert.equal(corDosArquivos(['docs/contributing-guide-x.md'], CFG).cor, 'verde');
});

test('revisao: aprovacao so de aprovador, no commit atual, a ultima vence', () => {
  assert.equal(aprovacaoEMudancas([rev('l0z4n0-a1', 'APPROVED', 'abc')], 'abc').aprovado, true);
  assert.equal(aprovacaoEMudancas([rev('l0z4n0-a1', 'APPROVED', 'velho')], 'abc').aprovado, false);
  assert.equal(aprovacaoEMudancas([rev('qualquer', 'APPROVED', 'abc')], 'abc').aprovado, false);
  const depois = [rev('l0z4n0-a1', 'APPROVED', 'abc', '2026-10-19T10:00:00Z'), rev('l0z4n0-a1', 'CHANGES_REQUESTED', 'abc', '2026-10-19T11:00:00Z')];
  const r = aprovacaoEMudancas(depois, 'abc');
  assert.equal(r.aprovado, false);
  assert.equal(r.mudancasPedidas, true);
  const dism = [rev('x', 'CHANGES_REQUESTED'), { ...rev('x', 'DISMISSED'), submitted_at: '2026-10-19T12:00:00Z' }];
  assert.equal(aprovacaoEMudancas(dism, 'abc').mudancasPedidas, false);
});

test('decidir: verde', () => {
  assert.equal(decidir(ok({ cor: 'verde' })).acao, 'merge');
  assert.equal(decidir(ok({ cor: 'verde', draft: true })).acao, 'espera');
  assert.equal(decidir(ok({ cor: 'verde', labels: ['fila:segura'] })).acao, 'segura');
  assert.equal(decidir(ok({ cor: 'verde', mergeable: false })).acao, 'espera');
  assert.equal(decidir(ok({ cor: 'verde', mergeable: null })).acao, 'espera');
  assert.equal(decidir(ok({ cor: 'verde', mudancasPedidas: true })).acao, 'espera');
});

test('decidir: amarelo exige 24h', () => {
  assert.equal(decidir(ok({ cor: 'amarelo', idadeMs: 2 * H })).acao, 'espera');
  assert.equal(decidir(ok({ cor: 'amarelo', idadeMs: 25 * H })).acao, 'merge');
});

test('SABOTAGEM (a): amarelo com check vermelho nunca mergeia, nem depois de 48h', () => {
  const d = decidir(ok({ cor: 'amarelo', idadeMs: 48 * H, checks: { estado: 'falha', nomes: ['test'] } }));
  assert.equal(d.acao, 'espera');
  assert.match(d.motivo, /checks falhando/);
});

test('decidir: amarelo com review pedindo mudanca nao entra', () => {
  assert.equal(decidir(ok({ cor: 'amarelo', idadeMs: 48 * H, mudancasPedidas: true })).acao, 'espera');
});

test('decidir: vermelho exige aprovacao; aprovacao basta sem 24h', () => {
  assert.equal(decidir(ok({ cor: 'vermelho', aprovado: true, idadeMs: 0 })).acao, 'merge');
  assert.equal(decidir(ok({ cor: 'vermelho', aprovado: true, checks: { estado: 'falha', nomes: ['t'] } })).acao, 'espera');
});

test('SABOTAGEM (b): vermelho sem aprovacao nunca mergeia, nem apos 24h', () => {
  for (const idadeMs of [0, 25 * H, 200 * H]) {
    const d = decidir(ok({ cor: 'vermelho', aprovado: false, idadeMs }));
    assert.equal(d.acao, 'espera');
    assert.equal(d.esperando, 'João (aprovar)');
  }
});

test('decidir: cor desconhecida = espera (duvida)', () => {
  assert.equal(decidir(ok({ cor: 'roxo' })).acao, 'espera');
});
