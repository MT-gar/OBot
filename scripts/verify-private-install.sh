#!/usr/bin/env bash
# Fully offline contract tests: every Docker call goes to a fail-closed fake.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bash -n "$project_root/scripts/private-install.sh"
node --input-type=module - "$project_root" <<'JS'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = process.argv[2];
const temp = mkdtempSync(path.join(tmpdir(), 'private-install-fake-'));
const bin = path.join(temp, 'bin'); mkdirSync(bin);
const log = path.join(temp, 'commands.jsonl');
const database = path.join(temp, 'fake-docker.json');
const script = path.join(temp, 'fake-docker.mjs');
const image = digit => 'sha256:' + digit.repeat(64);
writeFileSync(database, JSON.stringify({ tags: { 'fixture:base-v1': image('1'), 'fixture:acp-v1': image('2'), 'fixture:base-v2': image('3'), 'fixture:acp-v2': image('4') }, projects: {}, volumes: {} }));
writeFileSync(script, `
import {appendFileSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
const a=process.argv.slice(2), e=process.env;
appendFileSync(e.FAKE_LOG,JSON.stringify({args:a,project:e.COMPOSE_PROJECT_NAME,base:e.BOT_IMAGE,acp:e.BOT_ACP_IMAGE,enabled:e.MODEL_ENABLED})+'\\n');
const d=JSON.parse(readFileSync(e.FAKE_DB,'utf8'));
const out=x=>console.log(typeof x==='string'?x:JSON.stringify(x));
const save=()=>writeFileSync(e.FAKE_DB,JSON.stringify(d));
const serviceNames=['computer','desktop','egress'];
const ids={computer:'a'.repeat(64),desktop:'b'.repeat(64),egress:'c'.repeat(64)};
const project=e.COMPOSE_PROJECT_NAME;
const selected=id=>d.projects[id]||{};
const imageId=ref=>d.tags[ref]||(/^sha256:[1-4]{64}$/.test(ref)?ref:null);
function config() {
  const env={APP_ROLE:'control',MODEL_ENABLED:e.MODEL_ENABLED,MODEL_EXECUTOR:'dsh-acp',MODEL_NAME:e.MODEL_NAME,MODEL_EFFORT:e.MODEL_EFFORT,MODEL_BASE_URL:e.MODEL_BASE_URL,DSH_ACP_NODE:'/opt/private-node/node_modules/node/bin/node',DSH_ACP_ENTRY:'/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',DSH_ACP_WORK_ROOT:'/run/private-computer/acp',OWNER_PASSWORD_FILE:'/run/private-computer/owner-password',MODEL_API_KEY_FILE:'/run/private-computer/model-key'};
  return {name:project,services:{computer:{image:e.BOT_ACP_IMAGE,environment:env,secrets:['owner-password','runner-token','model-key'],ports:[{host_ip:'127.0.0.1',target:3180,published:e.BOT_PORT}],volumes:[{source:'computer-home',target:'/workspace',volume:{subpath:'Workspace'}},{source:'control-state',target:'/var/lib/private-computer'}]},desktop:{image:e.BOT_IMAGE,environment:{APP_ROLE:'desktop'},secrets:['runner-token']},egress:{image:e.BOT_IMAGE,environment:{APP_ROLE:'egress'},secrets:[]}},networks:{'desktop-net':{internal:true}},secrets:Object.fromEntries(['owner-password','runner-token','model-key'].map(n=>[n,{file:path.join(e.BOT_SECRET_DIR,n)}]))};
}
function inspect(id) {
  for(const [p,rows] of Object.entries(d.projects)) for(const [role,c] of Object.entries(rows)) if(c.Id===id) return c;
  process.exit(1);
}
if(a[0]==='context'&&a[1]==='inspect') out(e.FAKE_REMOTE_CONTEXT?'ssh://remote.invalid':'unix:///var/run/docker.sock');
else if(a[0]==='info') out(e.FAKE_OLD_ENGINE?'28.0.0 linux x86_64':'29.1.3 linux x86_64');
else if(a[0]==='image'&&a[1]==='inspect') {
  const ref=a[2], id=imageId(ref); if(!id||e.FAKE_MISSING_IMAGE===ref) process.exit(1);
  out(a.includes('{{.Id}} {{.Os}} {{.Architecture}}')?id+' linux '+(e.FAKE_ARM_IMAGE?'arm64':'amd64'):a.includes('--format')?id:[{Id:id,Os:'linux',Architecture:'amd64'}]);
}
else if(a[0]==='compose') {
  if(a[1]==='version') out('2.40.3');
  else {
    const idx=a.indexOf('-f'), command=a[idx+2];
    if(command==='config') out(config());
    else if(command==='up') {
      if(e.FAKE_UP_FAIL) process.exit(42);
      const cfg=config(); d.projects[project]={};
      for(const role of serviceNames) {
        const s=cfg.services[role]; d.projects[project][role]={Id:ids[role],State:{Running:true,Health:{Status:e.FAKE_UNHEALTHY?'unhealthy':'healthy'}},Image:s.image,Config:{Image:s.image,Labels:{'com.docker.compose.project':project,'com.docker.compose.service':role},Env:Object.entries(s.environment).map(([k,v])=>k+'='+v)},Mounts:s.secrets.map(n=>({Destination:'/run/secrets/'+n})),HostConfig:{PortBindings:role==='computer'?{'3180/tcp':[{HostIp:'127.0.0.1',HostPort:e.BOT_PORT}]}:{}}};
      }
      for(const suffix of ['computer-home','control-state']) d.volumes[project+'_'+suffix]={project}; save();
    } else if(command==='ps') { const role=a.at(-1); if(selected(project)[role]) out(ids[role]); }
    else if(command==='exec') out({node:'v24.22.3',dsh:'0.2.2-rc.3',policy:true});
    else if(command==='down') {delete d.projects[project];save();}
    else throw Error('Unexpected fake compose operation '+command);
  }
}
else if(a[0]==='volume'&&a[1]==='ls') {
  for(const name of Object.keys(d.volumes)) if(name===project+'_computer-home'||name===project+'_control-state') out(name+' ');
}
else if(a[0]==='volume'&&a[1]==='inspect') {
  const v=a.includes('--format')?a.at(-1):a[2]; if(!d.volumes[v]) process.exit(1);
  const f=a[a.indexOf('--format')+1];
  if(a.includes('--format')) out(f==='{{.Mountpoint}}'?path.join(e.FAKE_TEMP,'volumes',v):e.FAKE_FOREIGN_VOLUME?'other-project':d.volumes[v].project||'<no value>'); else out([d.volumes[v]]);
}
else if(a[0]==='volume'&&a[1]==='create') { d.volumes[a.at(-1)]={project};save();out(a.at(-1)); }
else if(a[0]==='ps') {
  const filters=a.filter((x,i)=>a[i-1]==='--filter');
  const p=filters.find(x=>x.startsWith('label=com.docker.compose.project='))?.split('=').at(-1);
  if(p) for(const c of Object.values(selected(p))) out(c.Id);
  else if(filters.some(x=>x.startsWith('volume='))) {
    const v=filters.find(x=>x.startsWith('volume=')).slice(7);
    if(d.volumes[v]) for(const [p,rows] of Object.entries(d.projects)) if(v.startsWith(p+'_')) for(const c of Object.values(rows)) if((a.includes('-aq')||c.State.Running)&&(!filters.includes('status=running')||c.State.Running)) out(c.Id);
  }
}
else if(a[0]==='inspect') {
  const c=inspect(a.at(-1));
  if(!a.includes('--format')) out([c]);
  else {const f=a[a.indexOf('--format')+1];out(f==='{{.State.Health.Status}}'?c.State.Health.Status:f.includes('com.docker.compose.service')?c.Config.Labels['com.docker.compose.service']:c.Config.Labels['com.docker.compose.project']);}
}
else if(a[0]==='stop') { for(const rows of Object.values(d.projects)) for(const c of Object.values(rows)) if(a.includes(c.Id)) c.State.Running=false;save(); }
else if(a[0]==='run') {
  if(a.includes('/backup.mjs')) {
    const op=a[a.indexOf('/backup.mjs')+1];
    if(e.FAKE_BACKUP_FAIL&&op===e.FAKE_BACKUP_FAIL) process.exit(43);
    const mount=a.find(x=>x.startsWith('type=bind,src=')&&x.endsWith('dst=/backups'));
    if(op==='create') {
      const root=mount.slice('type=bind,src='.length).split(',dst=')[0]; const name=a[a.indexOf('--destination')+1].slice('/backups/'.length); mkdirSync(path.join(root,name));
    }
    out({ok:true,fake:true,operation:op});
  } else if(a.includes('--input-type=module')) out({node:'v24.22.3',dsh:'0.2.2-rc.3',policy:true});
  else if(!a.some(x=>x.startsWith('type=volume,'))) throw Error('Unexpected fake helper');
}
else throw Error('Unexpected fake Docker command: '+a.join(' '));
`);
writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexec "$FAKE_NODE" "$FAKE_SCRIPT" "$@"\n', { mode: 0o700 });
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_NODE: process.execPath, FAKE_SCRIPT: script, FAKE_DB: database, FAKE_LOG: log, FAKE_TEMP: temp, DOCKER_HOST: 'unix:///var/run/docker.sock' };
const project = 'fixture-private-install';
const state = path.join(temp, 'private');
const backup = path.join(temp, 'backups'); mkdirSync(backup, { mode: 0o700 });
const common = ['--project', project, '--state-dir', state];
let checks = 0;
function run(action, flags = [], options = {}) {
  writeFileSync(log, '');
  const child = spawnSync('bash', [path.join(root, 'scripts/private-install.sh'), action, ...common, ...flags], { env: { ...env, ...options.env }, encoding: 'utf8', timeout: 30000 });
  assert(!child.error, child.error?.message);
  const output = child.stdout + child.stderr;
  const commands = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (options.fail) assert.notEqual(child.status, 0, 'Expected command to fail: ' + action);
  else assert.equal(child.status, 0, 'Command failed: ' + action + '\n' + output + '\ncommands=' + JSON.stringify(commands));
  assert(!output.includes('fixture-secret-do-not-print'), 'Secret leaked into diagnostics');
  for (const { args } of commands) {
    assert(!['pull', 'build', 'push', 'prune'].includes(args[0]), 'Unexpected image/data mutation');
    assert(!(args[0] === 'volume' && args[1] === 'rm'), 'Volumes must never be deleted');
    assert(!(args[0] === 'compose' && args.includes('--volumes')), 'Compose must retain volumes');
    if (args[0] === 'compose' && !args.includes('version')) assert.equal(args[args.indexOf('--project-name') + 1], project);
  }
  checks++;
  return { output, commands };
}
const install = ['--base-image', 'fixture:base-v1', '--acp-image', 'fixture:acp-v1', '--source-version', 'fixture-v1'];
const upgrade = ['--base-image', 'fixture:base-v2', '--acp-image', 'fixture:acp-v2', '--source-version', 'fixture-v2'];
const bundle = name => ['--backup-root', backup, '--backup-name', name];
const manifest = () => JSON.parse(readFileSync(path.join(state, 'deployment.json'), 'utf8'));
function assertNoServiceMutation(result, allowBackupStop = false) { assert(!result.commands.some(({ args }) => (!allowBackupStop && args[0] === 'stop') || (args[0] === 'compose' && (args.includes('up') || args.includes('down'))))); }
try {
  run('install', [...install, '--project', 'private-computer-p0'], { fail: true });
  run('install', install, { fail: true, env: { DOCKER_HOST: 'tcp://remote.invalid:2375' } });
  run('install', install, { fail: true, env: { FAKE_REMOTE_CONTEXT: '1' } });
  run('install', install, { fail: true, env: { FAKE_OLD_ENGINE: '1' } });
  run('install', install, { fail: true, env: { FAKE_ARM_IMAGE: '1' } });
  assertNoServiceMutation(run('install', [...install, '--model-enabled', '1'], { fail: true }));
  assert(!existsSync(path.join(state, 'pending.json')));
  const result = run('install', install);
  assert.equal(manifest().baseImageId, image('1')); assert.equal(manifest().acpImageId, image('2')); assert.equal(manifest().modelEnabled, '0');
  assert(result.commands.some(({ args, enabled }) => args[0] === 'compose' && args.includes('up') && args.includes('--no-build') && args.includes('never') && enabled === '0'));
  const secret = path.join(state, 'secrets/model-key'); writeFileSync(secret, 'fixture-secret-do-not-print\n', { mode: 0o600 });
  const beforeSecrets = ['owner-password', 'runner-token', 'model-key'].map(n => readFileSync(path.join(state, 'secrets', n), 'utf8'));
  run('health');
  assertNoServiceMutation(run('upgrade', [...upgrade, ...bundle('backup-create-failed')], { fail: true, env: { FAKE_BACKUP_FAIL: 'create' } }), true);
  assert.equal(manifest().sourceVersion, 'fixture-v1'); assert(!existsSync(path.join(state, 'rollback.json')));
  assertNoServiceMutation(run('uninstall', bundle('backup-verify-failed'), { fail: true, env: { FAKE_BACKUP_FAIL: 'verify' } }), true);
  assert.equal(manifest().sourceVersion, 'fixture-v1');
  const transition = run('upgrade', [...upgrade, ...bundle('upgrade-v2')]);
  const verifyIndex = transition.commands.findIndex(({ args }) => args.includes('/backup.mjs') && args[args.indexOf('/backup.mjs') + 1] === 'verify');
  const recreateIndex = transition.commands.findIndex(({ args }) => args[0] === 'compose' && args.includes('--force-recreate'));
  assert(verifyIndex >= 0 && recreateIndex > verifyIndex, 'Upgrade must verify backup before recreating services');
  assert.equal(manifest().baseImageId, image('3')); assert.equal(manifest().acpImageId, image('4'));
  assert.equal(JSON.parse(readFileSync(path.join(state, 'rollback.json'))).acpImageId, image('2'));
  const db = JSON.parse(readFileSync(database)); db.tags['fixture:base-v1'] = image('3'); db.tags['fixture:acp-v1'] = image('4'); writeFileSync(database, JSON.stringify(db));
  assertNoServiceMutation(run('rollback', bundle('rollback-without-ack'), { fail: true }));
  run('rollback', [...bundle('rollback-v1'), '--ack-current-data']);
  assert.equal(manifest().baseImageId, image('1')); assert.equal(manifest().acpImageId, image('2'), 'Rollback must ignore moved mutable tags');
  run('upgrade', [...upgrade, ...bundle('upgrade-failed')], { fail: true, env: { FAKE_UP_FAIL: '1' } });
  assert.equal(manifest().sourceVersion, 'fixture-v1'); assert(existsSync(path.join(state, 'pending.json')));
  assertNoServiceMutation(run('start', [], { fail: true }));
  run('rollback', [...bundle('recover-v1'), '--ack-current-data']);
  assert(!existsSync(path.join(state, 'pending.json'))); run('health');
  const unhealthy = run('upgrade', [...upgrade, ...bundle('upgrade-unhealthy')], { fail: true, env: { FAKE_UNHEALTHY: '1' } });
  assert.match(unhealthy.output, /A selected service is not healthy/);
  assert.equal(manifest().sourceVersion, 'fixture-v1'); assert(existsSync(path.join(state, 'pending.json')));
  assertNoServiceMutation(run('start', [], { fail: true }));
  run('rollback', [...bundle('recover-unhealthy-v1'), '--ack-current-data']);
  run('health');
  assertNoServiceMutation(run('uninstall', bundle('foreign-volume'), { fail: true, env: { FAKE_FOREIGN_VOLUME: '1' } }));
  assertNoServiceMutation(run('upgrade', [...upgrade, ...bundle('missing-image')], { fail: true, env: { FAKE_MISSING_IMAGE: 'fixture:acp-v2' } }));
  run('backup', bundle('manual-backup')); // Backup intentionally leaves the selected project stopped.
  run('start');
  run('uninstall', bundle('uninstall'));
  const retained = JSON.parse(readFileSync(database));
  assert(!retained.projects[project]); assert(retained.volumes[project + '_computer-home']); assert(retained.volumes[project + '_control-state']);
  assert.deepEqual(['owner-password', 'runner-token', 'model-key'].map(n => readFileSync(path.join(state, 'secrets', n), 'utf8')), beforeSecrets);
  run('start'); run('health');
  chmodSync(secret, 0o644); assertNoServiceMutation(run('start', [], { fail: true })); chmodSync(secret, 0o600);
  const saved = readFileSync(path.join(state, 'deployment.json'), 'utf8');
  const drift = JSON.parse(saved); drift.composeSha256 = '0'.repeat(64); writeFileSync(path.join(state, 'deployment.json'), JSON.stringify(drift));
  assertNoServiceMutation(run('start', [], { fail: true })); writeFileSync(path.join(state, 'deployment.json'), saved);
  const link = path.join(temp, 'state-link'); symlinkSync(state, link); run('start', ['--state-dir', link], { fail: true });
  mkdirSync(path.join(state, '.operation.lock')); assertNoServiceMutation(run('start', [], { fail: true })); rmSync(path.join(state, '.operation.lock'), { recursive: true });
  console.log(JSON.stringify({ ok: true, check: 'private-install-fake-docker', commandChecks: checks, realDockerCalls: 0, modelRequests: 0, coverage: ['fresh-install', 'offline-default', 'pinned-images', 'health', 'backup-before-upgrade', 'backup-failure', 'rollback-moved-tags', 'failed-upgrade-recovery', 'foreign-volume-refusal', 'retained-data-uninstall', 'credential-preservation', 'remote-refusal', 'state-lock', 'symlink-and-mode-refusal', 'manifest-drift'] }));
} finally {
  assert(path.dirname(temp) === tmpdir() && path.basename(temp).startsWith('private-install-fake-'));
  rmSync(temp, { recursive: true, force: true });
}
JS
