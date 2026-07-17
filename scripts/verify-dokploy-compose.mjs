import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const composeFile = 'docker-compose.dokploy.yml';
const expectedService = 'routerdone';
const text = readFileSync(composeFile, 'utf8');

function fail(message) {
  console.error(`Dokploy compose verify failed: ${message}`);
  process.exit(1);
}

if (text.includes('\\n')) {
  fail(`${composeFile} contains literal \\n sequences; write real newlines instead.`);
}

if (!/^services:\s*$/m.test(text)) {
  fail(`${composeFile} must declare a top-level services: mapping.`);
}

if (!new RegExp(`^  ${expectedService}:\\s*$`, 'm').test(text)) {
  fail(`Dokploy domain is attached to service ${expectedService}; compose must declare services.${expectedService}.`);
}

if (/^  app:\s*$/m.test(text)) {
  fail('Do not name the Dokploy service app; Dokploy is configured for service routerdone.');
}

const env = {
  ...process.env,
  JWT_SECRET: process.env.JWT_SECRET || 'verify-jwt-secret',
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD || 'verify-password',
  BASE_URL: process.env.BASE_URL || 'https://routerdone.example.com',
  NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL || 'https://routerdone.example.com',
  API_KEY_SECRET: process.env.API_KEY_SECRET || 'verify-api-key-secret',
  MACHINE_ID_SALT: process.env.MACHINE_ID_SALT || 'verify-machine-id-salt'
};

const result = spawnSync('docker', ['compose', '-p', 'routerdone-routerdone-ed6gok', '-f', composeFile, 'config'], {
  env,
  encoding: 'utf8',
  shell: process.platform === 'win32'
});

if (result.status !== 0) {
  const detail = (result.stderr || result.stdout || '').trim();
  fail(`docker compose config failed${detail ? `: ${detail}` : '.'}`);
}

const rendered = result.stdout || '';

if (!/^  routerdone:\s*$/m.test(rendered)) {
  fail('docker compose config did not produce services.routerdone.');
}

// Drift guards: these are the values the Dokploy domain router, the exposed
// port and the healthcheck rely on. If any drifts, the public domain keeps
// returning a Traefik 404 while `docker compose config` still parses fine,
// so the parse-only check above is not enough.
// docker compose config renders environment values double-quoted when they
// look numeric or boolean, so allow optional quotes around each value.
const expects = [
  { label: 'PORT pinned to 20128', re: /PORT:\s*"?'?20128"?'?\s*$/m, source: 'rendered compose' },
  { label: 'HOSTNAME pinned to 0.0.0.0', re: /HOSTNAME:\s*"?'?0\.0\.0\.0"?'?\s*$/m, source: 'rendered compose' },
  { label: 'expose 20128', re: /^(\s*-\s*)?"'?20128"?'?\s*$/m, source: 'rendered compose' },
  { label: 'healthcheck probes 127.0.0.1:20128', re: /127\.0\.0\.1:20128\/api\/health/, source: 'rendered compose' },
  { label: 'stop_grace_period: 30s', re: /stop_grace_period:\s*"?30s"?/, source: 'docker-compose.dokploy.yml' },
  { label: 'healthcheck timeout 30s', re: /timeout:\s*"?30s"?/, source: 'rendered compose' }
];

const errors = [];
for (const e of expects) {
  const haystack = e.source === 'docker-compose.dokploy.yml' ? text : rendered;
  if (!e.re.test(haystack)) {
    errors.push(`missing/invariant broken: ${e.label}`);
  }
}

if (errors.length) {
  fail(errors.join('; '));
}

console.log('Dokploy compose verify passed.');
