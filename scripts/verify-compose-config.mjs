#!/usr/bin/env node
// Resolve Compose privately: never print raw config, inspect output or credentials.
// --self-test uses only local fixtures/fake Docker; --running also checks containers.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(root, 'deploy/compose/compose.yaml');
const acpNode = '/opt/private-node/node_modules/node/bin/node';
const acpEntry = '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const serviceNames = ['computer', 'desktop', 'egress'];
const restricted = /^(?:MODEL_|DSH_|OWNER_|XINGCHI_|OPENAI_|ANTHROPIC_|PRIVATE_COMPUTER_POLICY_)/;
function requireThat(value, message) { if (!value) throw new Error(message); }
function settings(env = process.env) {
  return {
    baseImage: env.BOT_IMAGE || 'private-computer:mvp',
    acpImage: env.BOT_ACP_IMAGE || 'private-computer:acp',
    project: env.COMPOSE_PROJECT_NAME || 'private-computer-p0',
    enabled: env.MODEL_ENABLED || '1',
    model: env.MODEL_NAME || 'gpt-6.1-sol',
    effort: env.MODEL_EFFORT || 'max',
    baseUrl: env.MODEL_BASE_URL || 'https://api.xingchiapi.com',
    port: env.BOT_PORT || '3180',
    secretDir: env.BOT_SECRET_DIR || path.join(env.XDG_STATE_HOME || path.join(homedir(), '.local/state'), 'private-computer-p0'),
  };
}
function environment(value) {
  if (!Array.isArray(value)) return value || {};
  return Object.fromEntries(value.map(row => { const split = row.indexOf('='); return [row.slice(0, split), row.slice(split + 1)]; }));
}
function secretNames(service) { return (service.secrets || []).map(secret => typeof secret === 'string' ? secret : secret.source).sort(); }
function equalList(actual, expected) { return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()); }
function checkEnvironment(env, service, expected) {
  const control = service === 'computer';
  requireThat(env.APP_ROLE === (control ? 'control' : service), 'A service has the wrong application role.');
  if (control) {
    requireThat(env.MODEL_EXECUTOR === 'dsh-acp', 'Control must explicitly select dsh-acp; Responses is not a fallback.');
    requireThat(env.MODEL_ENABLED === expected.enabled && ['0', '1'].includes(expected.enabled), 'MODEL_ENABLED must consistently select ACP or the explicit offline demo.');
    requireThat(env.MODEL_NAME === expected.model && env.MODEL_EFFORT === expected.effort, 'Control model or reasoning effort differs from the selected configuration.');
    requireThat(env.MODEL_BASE_URL === expected.baseUrl, 'Control provider differs from the selected configuration.');
    let endpoint; try { endpoint = new URL(env.MODEL_BASE_URL); } catch { throw new Error('The provider URL is invalid.'); }
    requireThat(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'The provider must use a credential-free HTTPS URL.');
    requireThat(env.DSH_ACP_NODE === acpNode && env.DSH_ACP_ENTRY === acpEntry && env.DSH_ACP_WORK_ROOT === '/run/private-computer/acp', 'Control must select the pinned ACP runtime paths.');
    requireThat(env.OWNER_PASSWORD_FILE === '/run/private-computer/owner-password' && env.MODEL_API_KEY_FILE === '/run/private-computer/model-key', 'Control credentials must be injected through private files.');
  } else {
    requireThat(!Object.keys(env).some(name => restricted.test(name)), 'Desktop/egress must not inherit owner, model or ACP configuration.');
  }
  requireThat(!Object.keys(env).some(name => /(?:API_KEY|PASSWORD|TOKEN)$/.test(name)), 'Credentials must not be passed in environment values.');
}
export function validateCompose(config, expected = settings()) {
  requireThat(expected.baseImage !== expected.acpImage, 'Base and ACP control must use distinct image tags.');
  requireThat(config.name === expected.project, 'The resolved Compose project differs from the selected project.');
  requireThat(equalList(Object.keys(config.services || {}), serviceNames), 'Compose must contain exactly the three split services.');
  for (const name of serviceNames) {
    const service = config.services[name];
    requireThat(service.image === (name === 'computer' ? expected.acpImage : expected.baseImage), 'A resolved service image differs from the selected build image.');
    checkEnvironment(environment(service.environment), name, expected);
    const secrets = name === 'computer' ? ['owner-password', 'runner-token', 'model-key'] : name === 'desktop' ? ['runner-token'] : [];
    requireThat(equalList(secretNames(service), secrets), 'A service has an unexpected credential mount.');
    requireThat(!(service.volumes || []).some(volume => JSON.stringify(volume).includes('docker.sock')), 'No service may mount a Docker socket.');
    if (name === 'computer') {
      const ports = service.ports || [];
      requireThat(ports.length === 1 && ports[0].host_ip === '127.0.0.1' && Number(ports[0].target) === 3180 && String(ports[0].published) === expected.port, 'Only the local owner application port may be published.');
      requireThat((service.volumes || []).some(volume => volume.source === 'computer-home' && volume.target === '/workspace' && volume.volume?.subpath === 'Workspace'), 'Control must mount only the workspace subdirectory from the home volume.');
      requireThat((service.volumes || []).some(volume => volume.source === 'control-state' && volume.target === '/var/lib/private-computer'), 'Control state must retain its named volume.');
    } else requireThat(!(service.ports || []).length, 'Desktop/egress must not publish ports.');
  }
  requireThat(config.networks?.['desktop-net']?.internal === true, 'The desktop network must remain internal.');
  for (const name of ['owner-password', 'runner-token', 'model-key']) {
    requireThat(config.secrets?.[name]?.file === path.resolve(expected.secretDir, name), 'Secrets must resolve to the selected external private state directory.');
  }
  return {
    project: expected.project,
    images: { computer: expected.acpImage, desktop: expected.baseImage, egress: expected.baseImage },
    executor: 'dsh-acp', modelEnabled: expected.enabled === '1',
    model: expected.model, reasoningEffort: expected.effort,
    providerOrigin: new URL(expected.baseUrl).origin,
    modelAndOwnerSecretsOnlyInControl: true,
    publishedApplicationPortOnly: true,
  };
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, ...options });
  requireThat(!result.error && result.status === 0, 'Local Docker/Compose verification failed; raw diagnostics were withheld because they can include private configuration.');
  return result.stdout;
}
function parseJson(text) { try { return JSON.parse(text); } catch { throw new Error('Local Docker/Compose did not return valid JSON.'); } }
function composeArgs(expected) { return ['compose', '--project-directory', root, '--project-name', expected.project, '-f', composeFile]; }
const runtimeProbe = `import { readFile, access } from 'node:fs/promises'; const dsh=JSON.parse(await readFile('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json','utf8')).version; await access('${acpEntry}'); await access('/opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'); const policy=Boolean((await readFile('/opt/private-computer/runtime/acp/budget.mjs','utf8')).trim()); console.log(JSON.stringify({node:process.version,dsh,policy}));`;
function checkRuntime(versions) {
  requireThat(versions.node === 'v24.22.3' && versions.dsh === '0.2.2-rc.3' && versions.policy, 'The selected control image does not contain the pinned ACP runtime and policy.');
  return versions;
}
function verifyImages(config) {
  const images = {};
  for (const name of serviceNames) images[name] = { image: config.services[name].image, imageId: run('docker', ['image', 'inspect', config.services[name].image, '--format', '{{.Id}}']).trim() };
  const runtime = checkRuntime(parseJson(run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--user', 'desktop', '--entrypoint', acpNode, config.services.computer.image, '--input-type=module', '-e', runtimeProbe])));
  return { localImages: images, runtime };
}
async function verifyRunning(config, expected) {
  const result = {};
  for (const name of serviceNames) {
    const ids = run('docker', [...composeArgs(expected), 'ps', '--all', '-q', name]).trim().split(/\s+/);
    requireThat(ids.length === 1 && /^[a-f0-9]{12,64}$/.test(ids[0]), 'Expected one existing container for each split service.');
    const [container] = parseJson(run('docker', ['inspect', ids[0]]));
    requireThat(container?.State?.Running === true, 'An expected service container is not running.');
    requireThat(container.Config?.Labels?.['com.docker.compose.project'] === expected.project && container.Config?.Labels?.['com.docker.compose.service'] === name, 'Container identity differs from the selected Compose project.');
    requireThat(container.Config.Image === config.services[name].image, 'A running service uses an unexpected image tag.');
    const image = run('docker', ['image', 'inspect', config.services[name].image, '--format', '{{.Id}}']).trim();
    requireThat(container.Image === image, 'A running service predates the currently selected image; recreate it.');
    checkEnvironment(environment(container.Config.Env), name, expected);
    const expectedSecrets = secretNames(config.services[name]);
    const mountedSecrets = (container.Mounts || []).filter(mount => mount.Destination?.startsWith('/run/secrets/')).map(mount => mount.Destination.slice('/run/secrets/'.length));
    requireThat(equalList(mountedSecrets, expectedSecrets), 'A running service has unexpected credential mounts.');
    const bindings = container.HostConfig?.PortBindings || {};
    if (name === 'computer') requireThat(Object.keys(bindings).length === 1 && bindings['3180/tcp']?.length === 1 && bindings['3180/tcp'][0].HostIp === '127.0.0.1' && bindings['3180/tcp'][0].HostPort === expected.port, 'The running owner application port is not localhost-only.');
    else requireThat(Object.keys(bindings).length === 0, 'A running desktop/egress publishes a port.');
    result[name] = { image: container.Config.Image, imageId: container.Image, running: true };
  }
  // Read pinned local files inside control; never launch DSH or a model request.
  const versions = checkRuntime(parseJson(run('docker', [...composeArgs(expected), 'exec', '-T', '--user', 'desktop', 'computer', acpNode, '--input-type=module', '-e', runtimeProbe])));
  return { containers: result, runtime: versions };
}
function fixture(expected) {
  return {
    name: expected.project,
    services: {
      computer: { image: expected.acpImage, environment: { APP_ROLE: 'control', MODEL_ENABLED: expected.enabled, MODEL_EXECUTOR: 'dsh-acp', MODEL_NAME: expected.model, MODEL_EFFORT: expected.effort, MODEL_BASE_URL: expected.baseUrl, DSH_ACP_NODE: acpNode, DSH_ACP_ENTRY: acpEntry, DSH_ACP_WORK_ROOT: '/run/private-computer/acp', OWNER_PASSWORD_FILE: '/run/private-computer/owner-password', MODEL_API_KEY_FILE: '/run/private-computer/model-key' }, secrets: ['owner-password', 'runner-token', 'model-key'], ports: [{ host_ip: '127.0.0.1', target: 3180, published: expected.port }], volumes: [{ source: 'computer-home', target: '/workspace', volume: { subpath: 'Workspace' } }, { source: 'control-state', target: '/var/lib/private-computer' }] },
      desktop: { image: expected.baseImage, environment: { APP_ROLE: 'desktop' }, secrets: ['runner-token'] },
      egress: { image: expected.baseImage, environment: { APP_ROLE: 'egress' } },
    },
    networks: { 'desktop-net': { internal: true } },
    secrets: Object.fromEntries(['owner-password', 'runner-token', 'model-key'].map(name => [name, { file: path.resolve(expected.secretDir, name) }])),
  };
}
async function selfTest() {
  let checks = 0;
  const expected = settings({ BOT_SECRET_DIR: path.join(tmpdir(), 'compose-fixture-private'), BOT_IMAGE: 'fixture:base', BOT_ACP_IMAGE: 'fixture:acp', COMPOSE_PROJECT_NAME: 'fixture-project' });
  validateCompose(fixture(expected), expected); checks++;
  const failures = [
    config => { config.services.computer.image = expected.baseImage; },
    config => { config.services.desktop.image = expected.acpImage; },
    config => { delete config.services.computer.environment.MODEL_EXECUTOR; },
    config => { config.services.computer.environment.MODEL_EXECUTOR = 'responses'; },
    config => { config.services.desktop.secrets.push('model-key'); },
    config => { config.services.egress.environment.MODEL_NAME = 'unexpected'; },
    config => { config.services.computer.environment.MODEL_API_KEY = 'fixture-credential-never-printed'; },
    config => { config.services.computer.environment.MODEL_BASE_URL = 'https://user:fixture-credential@provider.invalid'; },
    config => { config.services.computer.ports[0].host_ip = '0.0.0.0'; },
    config => { config.services.computer.volumes[0].volume.subpath = ''; },
    config => { config.secrets['model-key'].file = '/unexpected/model-key'; },
  ];
  for (const change of failures) { const config = fixture(expected); change(config); let failed = false; try { validateCompose(config, expected); } catch { failed = true; } requireThat(failed, 'A deliberately unsafe Compose fixture was accepted.'); checks++; }
  const offline = { ...expected, enabled: '0' }; validateCompose(fixture(offline), offline); checks++;
  let startupChecks = 0; let restoreChecks = 0;
  if (process.platform !== 'win32') {
    const directory = await mkdtemp(path.join(tmpdir(), 'compose-startup-test-'));
    try {
      const bin = path.join(directory, 'bin'); const privateDir = path.join(directory, 'private'); const log = path.join(directory, 'commands.jsonl');
      await mkdir(bin); await mkdir(privateDir);
      for (const name of ['owner-password', 'runner-token', 'model-key']) await writeFile(path.join(privateDir, name), 'fixture-credential-never-printed\n', { mode: 0o600 });
      const fake = path.join(directory, 'docker.mjs');
      const restoreHome = path.join(directory, 'restore-home'); const restoreControl = path.join(directory, 'restore-control');
      await mkdir(restoreHome); await mkdir(restoreControl);
      await writeFile(fake, `import {appendFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2); const env=process.env;
appendFileSync(env.VERIFY_DOCKER_LOG,JSON.stringify({args,base:env.BOT_IMAGE,acp:env.BOT_ACP_IMAGE,project:env.COMPOSE_PROJECT_NAME})+'\\n');
if(args[0]==='volume' && args[1]==='ls') {
  const mode=env.VERIFY_RESTORE_LABELS || 'none';
  if(mode==='error') process.exit(1);
  if(mode!=='none') {
    console.log(env.COMPOSE_PROJECT_NAME+'_computer-home '+(mode==='normal'?'':'restore-fixture'));
    if(mode!=='missing-control') console.log(env.COMPOSE_PROJECT_NAME+'_control-state '+(mode==='normal'||mode==='one-label'?'':mode==='mismatch'?'restore-other':'restore-fixture'));
  }
  process.exit(0);
}
if(args.includes('/restore/home') && args.includes('/restore/control')) {
  const script=args[args.indexOf('-e')+1];
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,env.VERIFY_RESTORE_HOME,env.VERIFY_RESTORE_CONTROL],{stdio:'inherit'});
  process.exit(child.status ?? 1);
}
if(env.VERIFY_FAIL_ACP && args.includes('--input-type=module')) process.exit(Number(env.VERIFY_FAIL_ACP));`);
      await writeFile(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexec "$VERIFY_NODE" "$VERIFY_DOCKER_SCRIPT" "$@"\n', { mode: 0o700 });
      const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, BOT_SECRET_DIR: privateDir, BOT_IMAGE: expected.baseImage, BOT_ACP_IMAGE: expected.acpImage, COMPOSE_PROJECT_NAME: expected.project, MODEL_ENABLED: '1', VERIFY_NODE: process.execPath, VERIFY_DOCKER_SCRIPT: fake, VERIFY_DOCKER_LOG: log, VERIFY_RESTORE_HOME: restoreHome, VERIFY_RESTORE_CONTROL: restoreControl };
      for (const command of ['build', 'up', 'serve', 'recreate']) {
        await writeFile(log, '');
        const child = spawnSync('bash', [path.join(root, 'scripts/dev.sh'), command], { env, encoding: 'utf8', timeout: 30000 });
        requireThat(child.status === 0, 'A fake-Docker startup command failed.');
        requireThat(!(child.stdout + child.stderr).includes('fixture-credential-never-printed'), 'A startup command printed credential content.');
        const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
        requireThat(rows.every(row => row.base === expected.baseImage && row.acp === expected.acpImage && row.project === expected.project), 'A startup command lost the selected image or project configuration.');
        if (command === 'build') {
          requireThat(rows.length === 2 && rows.every(row => row.args[0] === 'build'), 'Build must create both split images.');
          requireThat(rows[0].args[rows[0].args.indexOf('-t') + 1] === expected.baseImage && rows[1].args[rows[1].args.indexOf('-t') + 1] === expected.acpImage && rows[1].args.includes('FOUNDATION_IMAGE=' + expected.baseImage), 'ACP build must derive from the selected foundation.');
        } else {
          const up = rows.find(row => row.args[0] === 'compose' && row.args.includes('up'));
          requireThat(up?.args.includes(composeFile) && up.args.includes('--no-build') && up.args.includes('never'), 'Startup must use the selected manifest and existing local images.');
          requireThat(rows.some(row => row.args[0] === 'volume' && row.args.includes(expected.project + '_computer-home')), 'Volume preparation must use the selected project.');
          requireThat(rows.some(row => row.args[0] === 'run' && row.args.includes(acpNode) && row.args.includes('none') && !row.args.includes('--mount')), 'ACP preflight must have no network or credential mounts.');
          requireThat(rows.filter(row => row.args[0] === 'volume' && row.args[1] === 'ls').length === 1 && !rows.some(row => row.args.includes('/restore/home')), 'Ordinary startup must query restore labels once without reading receipt files.');
          if (command === 'recreate') requireThat(up.args.includes('--force-recreate'), 'Recreate must replace existing service containers.');
        }
        startupChecks++;
      }
      await writeFile(path.join(privateDir, 'model-key'), '');
      let child = spawnSync('bash', [path.join(root, 'scripts/dev.sh'), 'up'], { env, encoding: 'utf8', timeout: 30000 });
      requireThat(child.status !== 0 && child.stderr.includes('ACP model credential is missing'), 'Online startup must identify a missing model credential.'); startupChecks++;
      child = spawnSync('bash', [path.join(root, 'scripts/dev.sh'), 'up'], { env: { ...env, MODEL_ENABLED: '0' }, encoding: 'utf8', timeout: 30000 });
      requireThat(child.status === 0, 'The explicit offline fixed demo must start without a model credential.'); startupChecks++;
      for (const [code, diagnostic] of [[30, 'Node 24.22.3'], [31, 'DSH 0.2.2-rc.3'], [32, 'ACP policy plugin is missing'], [127, 'ACP runtime could not be checked']]) {
        child = spawnSync('bash', [path.join(root, 'scripts/dev.sh'), 'up'], { env: { ...env, MODEL_ENABLED: '0', VERIFY_FAIL_ACP: String(code) }, encoding: 'utf8', timeout: 30000 });
        requireThat(child.status !== 0 && child.stderr.includes(diagnostic), 'Startup must identify the specific ACP runtime or policy configuration failure.'); startupChecks++;
      }
      child = spawnSync('bash', [path.join(root, 'scripts/dev.sh'), 'build'], { env: { ...env, BOT_ACP_IMAGE: expected.baseImage }, encoding: 'utf8', timeout: 30000 });
      requireThat(child.status !== 0 && child.stderr.includes('different tags'), 'Build must reject an image tag shared by base and ACP.'); startupChecks++;
      const receipt = { format: 'private-computer-volume-restore', version: 1, transaction: '39027f44-96ad-49d3-8d1f-37ca6a16e88f', manifestSha256: 'a'.repeat(64), completedAt: '2026-01-01T00:00:00.000Z', authentication: 'relogin-required', resumedOperations: false };
      const homeMarker = path.join(restoreHome, '.restore-complete.json'); const controlMarker = path.join(restoreControl, '.restore-complete.json');
      const writeReceipts = async (home = receipt, control = home) => {
        await writeFile(homeMarker, typeof home === 'string' ? home : JSON.stringify(home));
        await writeFile(controlMarker, typeof control === 'string' ? control : JSON.stringify(control));
      };
      async function restoredStart(command, mode, accepted, diagnostic) {
        await writeFile(log, '');
        const child = spawnSync('bash', [path.join(root, 'scripts/dev.sh'), command], { env: { ...env, MODEL_ENABLED: '0', VERIFY_RESTORE_LABELS: mode }, encoding: 'utf8', timeout: 30000 });
        const rows = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
        requireThat(!(child.stdout + child.stderr).includes('fixture-credential-never-printed'), 'A restore check printed credential content.');
        requireThat(accepted ? child.status === 0 : child.status !== 0 && child.stderr.includes(diagnostic), 'Restore startup did not enforce its expected completion contract.');
        const helper = rows.find(row => row.args.includes('/restore/home'));
        if (helper) {
          const mounts = helper.args.filter((value, index) => helper.args[index - 1] === '--mount');
          requireThat(helper.args.includes('--read-only') && helper.args.includes('none') && helper.args.includes('--pull') && helper.args.includes('never') && helper.args.includes('--user') && helper.args.includes('desktop') && helper.args.includes('--cap-drop') && helper.args.includes('ALL'), 'The restore receipt helper must be read-only, local and unprivileged.');
          requireThat(equalList(mounts, ['type=volume,src=' + expected.project + '_computer-home,dst=/restore/home,readonly', 'type=volume,src=' + expected.project + '_control-state,dst=/restore/control,readonly']), 'The restore receipt helper may mount only the two project volumes read-only.');
        }
        if (!accepted) requireThat(!rows.some(row => row.args[0] === 'compose' && row.args.includes('up') || row.args[0] === 'volume' && row.args[1] === 'create' || row.args.includes('/bin/sh')), 'An incomplete restore reached volume preparation or service startup.');
        else if (mode === 'normal') requireThat(!helper, 'Unlabelled existing volumes must not require restore receipt files.');
        else requireThat(helper && rows.indexOf(helper) < rows.findIndex(row => row.args[0] === 'volume' && row.args[1] === 'create'), 'Restore receipts must be checked before volume preparation.');
        restoreChecks++;
        return rows;
      }
      await writeReceipts();
      await restoredStart('up', 'normal', true);
      for (const command of ['up', 'serve', 'recreate']) await restoredStart(command, 'complete', true);
      for (const [mode, command] of [['missing-control', 'up'], ['one-label', 'serve'], ['mismatch', 'recreate'], ['error', 'up']]) {
        const rows = await restoredStart(command, mode, false, mode === 'error' ? 'Cannot check local restore volume labels' : 'matching restore labels');
        requireThat(!rows.some(row => row.args.includes('/restore/home')), 'Invalid restore labels must fail before mounting either volume.');
      }
      const badReceipt = 'matching valid completion receipts';
      await rm(controlMarker);
      await restoredStart('up', 'complete', false, badReceipt);
      await writeReceipts(receipt, { ...receipt, transaction: '493a0c79-e05e-4cda-b0d0-cf992648e406' });
      await restoredStart('up', 'complete', false, badReceipt);
      for (const change of [
        { format: 'private-computer-restore' }, { version: 2 }, { transaction: 'invalid' }, { manifestSha256: 'z'.repeat(64) },
        { completedAt: 'invalid' }, { authentication: 'ready' }, { resumedOperations: true },
      ]) {
        await writeReceipts({ ...receipt, ...change });
        await restoredStart('up', 'complete', false, badReceipt);
      }
      for (const contents of ['invalid-json', ' '.repeat(4097)]) {
        await writeReceipts(contents);
        await restoredStart('up', 'complete', false, badReceipt);
      }
      await writeReceipts();
      await rm(homeMarker); await symlink(controlMarker, homeMarker);
      await restoredStart('up', 'complete', false, badReceipt);
      await rm(homeMarker); await mkdir(homeMarker);
      await restoredStart('up', 'complete', false, badReceipt);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { ok: true, check: 'compose-offline-fixtures', configChecks: checks, startupChecks, restoreChecks, startupChecksSkipped: process.platform === 'win32' ? 'Run in Linux/WSL to exercise bash startup.' : undefined, modelRequests: 0 };
}
async function main() {
  const flags = process.argv.slice(2);
  requireThat(flags.every(flag => ['--self-test', '--images', '--running'].includes(flag)) && !(flags.includes('--self-test') && flags.length > 1), 'Usage: node scripts/verify-compose-config.mjs [--self-test | --images | --running]');
  if (flags.includes('--self-test')) return selfTest();
  const expected = settings();
  const config = parseJson(run('docker', [...composeArgs(expected), 'config', '--format', 'json'], { env: { ...process.env, BOT_SECRET_DIR: expected.secretDir } }));
  const summary = validateCompose(config, expected);
  return { ok: true, check: 'resolved-compose-selection', ...summary, ...(flags.includes('--images') ? verifyImages(config) : {}), ...(flags.includes('--running') ? await verifyRunning(config, expected) : {}), modelRequests: 0 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.error(JSON.stringify({ ok: false, check: 'compose-selection', error: error.message })); process.exitCode = 1; }
}
