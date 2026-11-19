// Running a skill's scripts (docs/plans/plan-6-studio-skill-scripts.md, src/studio/skillScripts.ts): the
// runner setting, the refusals (nothing runs), direct runs (environment, working directory, missing
// interpreter), the limits (time, output, Stop), and, when Docker or Podman answers, container runs:
// the file a script writes is the person's, no network, no other files, a read-only skill and root, no
// container left behind. The container tests print that they were skipped, and why, without an engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const out = name => require(path.join(__dirname, '../../out/studio', name));
const {
  chooseRunner, detectEngine, parseCall, planCall, runSkillScript, interpreterFor, parseSetting, containerNameFor, describeOutcome, describeRunner, IMAGES, killProcessTree
} = out('skillScripts.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-skill-scripts-'));
const root = fs.realpathSync((() => { const dir = path.join(base, 'repo'); fs.mkdirSync(dir); return dir; })());
const skillDir = path.join(base, 'skill');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write(path.join(skillDir, 'scripts', 'hello.py'), [
  'import os, sys',
  'os.makedirs("out", exist_ok=True)',
  'open("out/hello.txt", "w").write("hello " + " ".join(sys.argv[1:]) + "\\n")',
  'print("args:", sys.argv[1:])',
  'print("cwd:", os.getcwd())'
].join('\n'));
write(path.join(skillDir, 'scripts', 'env.py'), 'import os\nprint(sorted(os.environ))\nprint("SECRET=" + os.environ.get("RM_TEST_SECRET", "unset"))');
write(path.join(skillDir, 'scripts', 'sleep.py'), 'import time\nprint("started", flush=True)\ntime.sleep(60)\nprint("finished")');
write(path.join(skillDir, 'scripts', 'spawner.py'), [
  'import subprocess, sys, time',
  'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1); open(\'grandchild.txt\', \'w\').write(\'alive\')"])',
  'print("started", flush=True)',
  'time.sleep(60)'
].join('\n'));
write(path.join(skillDir, 'scripts', 'noisy.py'), 'import sys\nfor i in range(40000):\n    sys.stdout.write("line %06d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n" % i)\nprint("LAST LINE")');
write(path.join(skillDir, 'scripts', 'fail.py'), 'import sys\nprint("boom")\nsys.exit(3)');
write(path.join(skillDir, 'scripts', 'network.py'), [
  'import socket',
  'try:',
  '    socket.create_connection(("1.1.1.1", 53), timeout=3)',
  '    print("CONNECTED")',
  'except OSError as error:',
  '    print("NETWORK_FAILED errno=%s" % error.errno)'
].join('\n'));
write(path.join(skillDir, 'scripts', 'peek.py'), [
  'import os, sys',
  'print("SECRET_VISIBLE=%s" % os.path.exists(sys.argv[1]))',
  'for target in ("/skill/scripts/hello.py", "/etc/rm-test"):',
  '    try:',
  '        open(target, "a").write("x")',
  '        print("WROTE " + target)',
  '    except OSError as error:',
  '        print("READONLY " + target + " errno=%s" % error.errno)',
  'open("/tmp/scratch.txt", "w").write("ok")',
  'print("TMP_WRITABLE")'
].join('\n'));
write(path.join(skillDir, 'scripts', 'tool.js'), 'console.log("node", process.argv.slice(2).join(","));');
write(path.join(skillDir, 'scripts', 'run.sh'), 'echo "bash $1"');
write(path.join(skillDir, 'scripts', 'types.ts'), 'console.log(1)');
write(path.join(skillDir, 'scripts', 'sub', 'deep.py'), 'print("deep")');
const skill = { name: 'tools', ref: `github:acme/skills/tools@${'a'.repeat(40)}`, dir: skillDir,
  scripts: ['scripts/hello.py', 'scripts/env.py', 'scripts/sleep.py', 'scripts/spawner.py', 'scripts/noisy.py', 'scripts/fail.py', 'scripts/network.py', 'scripts/peek.py', 'scripts/tool.js', 'scripts/run.sh', 'scripts/types.ts', 'scripts/sub/deep.py'] };
const plan = (script, args = []) => planCall([skill], { skill: 'tools', script, args });
const direct = { mode: 'direct' };
const cancelSource = () => {
  const listeners = [];
  return { cancel() { this.token.isCancellationRequested = true; listeners.forEach(listener => listener()); },
    token: { isCancellationRequested: false, onCancellationRequested(listener) { listeners.push(listener); return { dispose() {} }; } } };
};
const leftovers = engine => spawnSync(engine, ['ps', '-a', '--filter', 'name=repository-manager-', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim();

/** Whether a container can run the pinned Python image here (pulling it if missing); a registry that refuses skips the container tests. */
async function pythonImageReady(engine) {
  try {
    await runSkillScript(plan('scripts/fail.py'), { root, runner: { mode: 'container', engine }, containerName: containerNameFor('t', 0) });
    return true;
  } catch (error) {
    if (/^Could not pull /.test(error.message)) { return false; }
    throw error;
  }
}

async function main() {
  // ---- The setting and the runner it gives (Decision 5).
  assert.deepEqual(['container', 'direct', 'off', 'auto', 'nonsense', undefined].map(parseSetting), ['container', 'direct', 'off', 'auto', 'auto', 'auto']);
  const docker = async () => 'docker';
  const none = async () => undefined;
  assert.deepEqual(await chooseRunner('auto', docker), { mode: 'container', engine: 'docker' });
  assert.deepEqual(await chooseRunner('auto', none), { mode: 'direct' });
  assert.deepEqual(await chooseRunner('container', none), { mode: 'container' }, 'container never falls back to direct');
  assert.deepEqual(await chooseRunner('direct', docker), { mode: 'direct' });
  assert.deepEqual(await chooseRunner('off', docker), { mode: 'off' });
  assert.match(describeRunner(direct), /directly on this machine, not isolated: as you, with your files and network/);
  assert.match(describeRunner({ mode: 'container', engine: 'podman' }), /^in a container \(podman\)/);
  assert.deepEqual([interpreterFor('a/b.py').command, interpreterFor('x.mjs').command, interpreterFor('x.cjs').command, interpreterFor('x.js').command, interpreterFor('x.sh').command, interpreterFor('x.ts')], ['python3', 'node', 'node', 'node', 'bash', undefined]);
  assert.match(IMAGES.python, /^python:3\.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df$/);
  assert.match(IMAGES.node, /^node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee$/);
  assert.match(IMAGES.shell, /^debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc$/);
  assert.equal(containerNameFor('run/1:x y', 2), 'repository-manager-run-1-x-y-2');

  // ---- Refusals: the reason, nothing run.
  const refused = (input, pattern) => assert.throws(() => planCall([skill], parseCall(input)), pattern);
  refused({ skill: 'nope', script: 'scripts/hello.py' }, /No skill named "nope" with scripts in this step \(skills with scripts: tools\)/);
  refused({ skill: 'tools', script: 'scripts/missing.py' }, /scripts\/missing\.py is not one of the scripts of tools/);
  refused({ skill: 'tools', script: '../escape.py' }, /may not leave the skill's folder/);
  refused({ skill: 'tools', script: 'scripts/../../escape.py' }, /may not leave the skill's folder/);
  refused({ skill: 'tools', script: '/etc/passwd' }, /relative to the skill's folder/);
  refused({ skill: 'tools', script: 'C:\\x\\a.py' }, /relative to the skill's folder/);
  refused({ skill: 'tools', script: 'scripts/types.ts' }, /"\.ts" are not run \(only \.py, \.js, \.mjs, \.cjs and \.sh\)/);
  refused({ skill: 'tools', script: 'scripts/hello.py', args: 'x' }, /args must be a list of text arguments/);
  refused({ skill: 'tools', script: 'scripts/hello.py', args: [1] }, /args must be a list of text arguments/);
  refused({ skill: 'tools', script: 'scripts/hello.py', args: Array.from({ length: 65 }, () => 'a') }, /At most 64 arguments/);
  refused({ skill: 'tools', script: 'scripts/hello.py', args: ['x'.repeat(4001)] }, /at most 4000 characters/);
  refused({ skill: '', script: 'scripts/hello.py' }, /skill is required/);
  assert.throws(() => planCall([skill, { ...skill, scripts: [] }], { skill: 'tools', script: 'scripts/hello.py', args: [] }), /More than one skill/);
  assert.equal(plan('./scripts/hello.py').script, 'scripts/hello.py', 'a leading ./ is dropped');
  assert.equal(plan('scripts/sub/deep.py').script, 'scripts/sub/deep.py', 'sub-folders are allowed');
  assert.equal(fs.existsSync(path.join(root, 'out')), false, 'a refusal ran nothing');
  // Runner refusals: off, and a container with no engine.
  await assert.rejects(runSkillScript(plan('scripts/hello.py'), { root, runner: { mode: 'off' }, containerName: 'x' }), /turned off in the settings/);
  await assert.rejects(runSkillScript(plan('scripts/hello.py'), { root, runner: { mode: 'container' }, containerName: 'x' }), /No container engine \(Docker or Podman\) answers, and the setting is "container"/);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);

  // ---- Direct runs: the interpreter runs the cached file from the repository root, with the arguments.
  const hello = await runSkillScript(plan('scripts/hello.py', ['a b', '$HOME', '; echo no']), { root, runner: direct, containerName: 'x' });
  assert.equal(hello.exitCode, 0);
  assert.equal(hello.runner, 'direct');
  assert.match(hello.output, /args: \['a b', '\$HOME', '; echo no'\]/, 'arguments are passed as they are: no shell');
  assert.ok(hello.output.includes(`cwd: ${root}`), 'the working directory is the repository root');
  assert.equal(fs.readFileSync(path.join(root, 'out', 'hello.txt'), 'utf8'), 'hello a b $HOME ; echo no\n');
  assert.equal(hello.command, 'python3 scripts/hello.py "a b" "$HOME" "; echo no"');
  assert.match(describeOutcome(hello, ['out/hello.txt']), /^exit code 0 \(.* s, directly on this machine\)\nOutput:\n[\s\S]*Files changed in the repository: out\/hello\.txt$/);
  fs.rmSync(path.join(root, 'out'), { recursive: true });
  const failed = await runSkillScript(plan('scripts/fail.py'), { root, runner: direct, containerName: 'x' });
  assert.deepEqual([failed.exitCode, failed.output.trim()], [3, 'boom']);
  // Other interpreters, when installed.
  const has = command => spawnSync(command, ['--version']).status === 0;
  if (has('node')) { assert.equal((await runSkillScript(plan('scripts/tool.js', ['a', 'b']), { root, runner: direct, containerName: 'x' })).output.trim(), 'node a,b'); }
  if (has('bash')) { assert.equal((await runSkillScript(plan('scripts/run.sh', ['q']), { root, runner: direct, containerName: 'x' })).output.trim(), 'bash q'); }
  assert.equal((await runSkillScript(plan('scripts/sub/deep.py'), { root, runner: direct, containerName: 'x' })).output.trim(), 'deep');

  // The environment is reduced: a credential in a variable is not passed (Decision 6).
  process.env.RM_TEST_SECRET = 'hunter2';
  try {
    const env = await runSkillScript(plan('scripts/env.py'), { root, runner: direct, containerName: 'x' });
    assert.match(env.output, /SECRET=unset/);
    assert.ok(!env.output.includes('hunter2'));
    const names = JSON.parse(env.output.split('\n')[0].replace(/'/g, '"'));
    assert.ok(names.every(name => ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'SystemRoot', 'TEMP', 'TMP', 'LC_CTYPE'].includes(name)), `unexpected variables: ${names}`);
  } finally { delete process.env.RM_TEST_SECRET; }

  // A missing interpreter ends the call with the reason (simulated by a PATH without it).
  const pathBefore = process.env.PATH;
  const empty = path.join(base, 'empty-path');
  fs.mkdirSync(empty);
  process.env.PATH = empty;
  try {
    await assert.rejects(runSkillScript(plan('scripts/hello.py'), { root, runner: direct, containerName: 'x' }), /python3 is not installed or not on PATH/);
  } finally { process.env.PATH = pathBefore; }
  assert.equal(fs.existsSync(path.join(root, 'out')), false);

  // ---- Limits: time, output, Stop.
  const slow = await runSkillScript(plan('scripts/sleep.py'), { root, runner: direct, containerName: 'x', timeoutMs: 700 });
  assert.equal(slow.stopped, 'timeout');
  assert.ok(slow.durationMs < 20_000, `killed at the limit, not after the script: ${slow.durationMs} ms`);
  assert.match(slow.output, /started/);
  assert.match(describeOutcome(slow, []), /^stopped: it ran past its time limit/);
  // A process the script started is stopped with it: the grandchild never writes its file, and the call returns promptly.
  if (process.platform !== 'win32') {
    const tree = await runSkillScript(plan('scripts/spawner.py'), { root, runner: direct, containerName: 'x', timeoutMs: 300 });
    assert.equal(tree.stopped, 'timeout');
    assert.ok(tree.durationMs < 5_000, `returned at the limit: ${tree.durationMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(fs.existsSync(path.join(root, 'grandchild.txt')), false, 'the script\'s own child was killed with it');
  }
  // The kill strategy per platform: Windows kills the whole tree with taskkill (no shell) and waits for it; elsewhere the process group.
  {
    const spawned = [];
    const fakeSpawn = (command, args, options) => {
      spawned.push([command, args, options.shell]);
      const handlers = {};
      setTimeout(() => handlers.close && handlers.close(0), 20);
      const fake = { on(event, handler) { handlers[event] = handler; return fake; } };
      return fake;
    };
    const killed = [];
    const fakeKill = (pid, signal) => { killed.push([pid, signal]); };
    const started = Date.now();
    assert.equal(await killProcessTree(4242, { platform: 'win32', spawn: fakeSpawn, kill: fakeKill }), 'taskkill');
    assert.ok(Date.now() - started >= 15, 'it waited for taskkill to finish');
    assert.deepEqual(spawned, [['taskkill', ['/pid', '4242', '/T', '/F'], false]]);
    assert.deepEqual(killed, []);
    assert.equal(await killProcessTree(4242, { platform: 'linux', spawn: fakeSpawn, kill: fakeKill }), 'group');
    assert.deepEqual(killed, [[-4242, 'SIGKILL']]);
    assert.equal(spawned.length, 1, 'no taskkill on POSIX');
    // taskkill that cannot start: the caller is told, so it can kill the one process it has.
    const broken = () => { const fake = { on(event, handler) { if (event === 'error') { setTimeout(() => handler(new Error('ENOENT')), 5); } return fake; } }; return fake; };
    assert.equal(await killProcessTree(7, { platform: 'win32', spawn: broken, kill: fakeKill }), 'failed');
  }
  const noisy = await runSkillScript(plan('scripts/noisy.py'), { root, runner: direct, containerName: 'x' });
  assert.equal(noisy.exitCode, 0);
  assert.equal(noisy.cut, true);
  assert.ok(Buffer.byteLength(noisy.output) <= 64 * 1024, `kept ${Buffer.byteLength(noisy.output)} bytes`);
  assert.ok(Buffer.byteLength(noisy.output) > 60 * 1024, 'the last 64 KB, not less');
  assert.match(noisy.output, /LAST LINE\n$/);
  assert.ok(!noisy.output.includes('line 000000'), 'the start was dropped');
  assert.match(describeOutcome(noisy, []), /Output \(only the last 64 KB; earlier output was cut\):/);
  const quiet = cancelSource();
  const stopping = runSkillScript(plan('scripts/sleep.py'), { root, runner: direct, containerName: 'x', token: quiet.token });
  setTimeout(() => quiet.cancel(), 600);
  const stopped = await stopping;
  assert.equal(stopped.stopped, 'cancelled');
  assert.ok(stopped.durationMs < 20_000);
  const before = cancelSource();
  before.cancel();
  assert.equal((await runSkillScript(plan('scripts/sleep.py'), { root, runner: direct, containerName: 'x', token: before.token })).stopped, 'cancelled', 'Stop before the call starts it never lets it run on');

  // ---- Containers, when an engine answers.
  const engine = await detectEngine();
  if (!engine) {
    console.log('Container tests SKIPPED: neither "docker version" nor "podman version" answered within 5 s on this machine.');
  } else if (!(await pythonImageReady(engine))) {
    console.log('Container tests SKIPPED: the pinned Python image could not be pulled here (a registry rate limit, or no network).');
  } else {
    const runner = { mode: 'container', engine };
    // A secret outside the repository and the skill folder: a container cannot see it.
    const secretFile = path.join(base, 'host-secret.txt');
    fs.writeFileSync(secretFile, 'secret');
    const hosted = await runSkillScript(plan('scripts/hello.py', ['in', 'container']), { root, runner, containerName: containerNameFor('t', 1) });
    assert.equal(hosted.exitCode, 0, hosted.output);
    assert.equal(hosted.runner, 'container');
    assert.match(hosted.output, /args: \['in', 'container'\]/);
    assert.match(hosted.output, /cwd: \/work/);
    assert.equal(fs.readFileSync(path.join(root, 'out', 'hello.txt'), 'utf8'), 'hello in container\n', 'the container wrote into the repository');
    if (process.platform !== 'win32') {
      const stat = fs.statSync(path.join(root, 'out', 'hello.txt'));
      assert.equal(stat.uid, process.getuid(), 'the file belongs to the person, not root');
      assert.equal(stat.gid, process.getgid());
    }
    fs.rmSync(path.join(root, 'out'), { recursive: true });
    const net = await runSkillScript(plan('scripts/network.py'), { root, runner, containerName: containerNameFor('t', 2) });
    assert.match(net.output, /NETWORK_FAILED errno=\d+/, 'a connection fails: no network');
    assert.ok(!net.output.includes('CONNECTED'));
    const peek = await runSkillScript(plan('scripts/peek.py', [secretFile]), { root, runner, containerName: containerNameFor('t', 3) });
    assert.equal(peek.exitCode, 0, peek.output);
    assert.match(peek.output, /SECRET_VISIBLE=False/, 'a file outside the repository and the skill folder cannot be seen');
    assert.match(peek.output, /READONLY \/skill\/scripts\/hello\.py errno=30/, 'the skill folder is read-only');
    assert.match(peek.output, /READONLY \/etc\/rm-test errno=30/, 'the root file system is read-only');
    assert.match(peek.output, /TMP_WRITABLE/);
    // The node and bash images are pulled on first use; a registry that refuses (rate limit, offline) skips them, said.
    for (const [script, arg, expected, image] of [['scripts/tool.js', 'x', 'node x', IMAGES.node], ['scripts/run.sh', 'y', 'bash y', IMAGES.shell]]) {
      try {
        const result = await runSkillScript(plan(script, [arg]), { root, runner, containerName: containerNameFor('t', 4) });
        assert.equal(result.output.trim(), expected);
      } catch (error) {
        if (!/^Could not pull /.test(error.message)) { throw error; }
        console.log(`Container test for ${script} SKIPPED: ${image.split('@')[0]} could not be pulled here (${error.message.slice(0, 160)}).`);
      }
    }
    assert.equal(leftovers(engine), '', 'no container is left after the calls');
    // The limits in a container: a timeout and Stop remove it by name.
    const slowContainer = await runSkillScript(plan('scripts/sleep.py'), { root, runner, containerName: containerNameFor('t', 6), timeoutMs: 3000 });
    assert.equal(slowContainer.stopped, 'timeout');
    assert.equal(leftovers(engine), '', 'a timed-out container is removed');
    const cancel = cancelSource();
    const stoppingContainer = runSkillScript(plan('scripts/sleep.py'), { root, runner, containerName: containerNameFor('t', 7), token: cancel.token });
    const startedAt = Date.now();
    for (;;) {
      if (spawnSync(engine, ['ps', '--filter', 'name=repository-manager-t-7', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim()) { break; }
      assert.ok(Date.now() - startedAt < 60_000, 'the container started');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    cancel.cancel();
    assert.equal((await stoppingContainer).stopped, 'cancelled');
    assert.equal(leftovers(engine), '', 'Stop removes the running container');
    const big = await runSkillScript(plan('scripts/noisy.py'), { root, runner, containerName: containerNameFor('t', 8) });
    assert.deepEqual([big.cut, Buffer.byteLength(big.output) <= 64 * 1024, /LAST LINE\n$/.test(big.output)], [true, true, true]);
    assert.equal(fs.existsSync(path.join(root, 'out')), false);

    // A failed pull ends the call with the engine's message; a pull is announced (a fake engine on PATH).
    if (process.platform !== 'win32') {
      const fake = path.join(base, 'fake-bin');
      fs.mkdirSync(fake);
      fs.writeFileSync(path.join(fake, 'docker'), '#!/bin/sh\ncase "$1" in\n  image) exit 1;;\n  pull) echo "Error response from daemon: pull access denied" >&2; exit 1;;\n  rm) exit 0;;\n  *) echo "run called" >&2; exit 9;;\nesac\n', { mode: 0o755 });
      process.env.PATH = `${fake}${path.delimiter}${pathBefore}`;
      const pulled = [];
      try {
        await assert.rejects(runSkillScript(plan('scripts/hello.py'), { root, runner: { mode: 'container', engine: 'docker' }, containerName: 'x', onPull: image => pulled.push(image) }),
          /Could not pull python:3\.12-slim-bookworm: Error response from daemon: pull access denied/);
      } finally { process.env.PATH = pathBefore; }
      assert.deepEqual(pulled, [IMAGES.python]);
    }
    console.log(`Container tests RAN with ${engine} (${execFileSync(engine, ['--version'], { encoding: 'utf8' }).trim()}).`);
  }
  console.log('Studio skill scripts smoke passed');
}

main().catch(error => { console.error(error); process.exit(1); }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
