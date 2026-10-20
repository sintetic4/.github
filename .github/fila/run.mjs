// Entrada da fila automática: fetch real da API do GitHub + driver.mjs (lógica testada com mocks).
// Erro do próprio robô = não mergeia, comenta o motivo no PR e falha o job.
import { readFileSync, writeFileSync } from 'node:fs';
import { criarDriver } from './driver.mjs';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const API = 'https://api.github.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const ev = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const driver = criarDriver({ gh, repo: REPO, runId: process.env.GITHUB_RUN_ID || null });
  const { sweep, registros } = await driver.rodar(process.env.GITHUB_EVENT_NAME, ev);
  if (driver.houveErro()) process.exitCode = 1;
  if (sweep) {
    const naFila = registros.filter((r) => r.acao !== 'mesclado');
    writeFileSync('fila.json', JSON.stringify({ gerado: new Date().toISOString(), repo: REPO, itens: naFila }, null, 2));
    console.log(`fila.json: ${naFila.length} PR(s) na fila`);
  }
}

main().catch((e) => { console.error('FALHA GERAL:', e.message); process.exit(1); });
