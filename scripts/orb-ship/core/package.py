# Package a Core build as an image and health-check it in isolation. Runs ON THE SERVER:
#   ssh host 'python3 - <rev>' < scripts/orb-ship/core/package.py
# Refuses unless the build succeeded and every library test passed (or failed only in
# the allow-list ALLOWED_FAILURES, which must stay empty unless a failure is understood).
import datetime, hashlib, json, pathlib, re, secrets, shutil, subprocess, sys, time

ALLOWED_FAILURES: set[str] = set()
rev = sys.argv[1]
build = pathlib.Path(f'/home/thomas/orb-build-{rev}'); stage = pathlib.Path(f'/home/thomas/orb-stage-{rev}')
def out(args): return subprocess.check_output(args, text=True).strip()

state = json.loads(out(['docker', 'inspect', f'orb-core-builder-{rev}']))[0]['State']
assert state['Status'] == 'exited' and state['ExitCode'] in (0, 101), f'Builder not finished cleanly: {state}'
log = (build / 'tests.log').read_text()
assert re.search(r'test result: (ok|FAILED)\. \d+ passed', log), 'No test summary'
failed = set(re.findall(r'^    ([a-z0-9_:]+)$', log, re.M))
assert failed <= ALLOWED_FAILURES, f'Unexpected test failures: {sorted(failed - ALLOWED_FAILURES)}'
passed = sum(int(n) for n in re.findall(r'test result: \w+\. (\d+) passed', log))

base = out(['docker', 'inspect', 'orb-sandboxed-sh-1', '--format', '{{.Config.Image}}'])
image = f'orb-sandboxed-sh-local:{rev}'
stage.mkdir(exist_ok=False)
for name in ['sandboxed-sh', 'build.log', 'tests.log', 'SOURCE_COMMIT']:
    shutil.copy2(build / name, stage / name)
(stage / 'Dockerfile').write_text(f'FROM {base}\nCOPY sandboxed-sh /usr/local/bin/sandboxed-sh\n')
subprocess.run(['docker', 'build', '--network', 'none', '-t', image, str(stage)], check=True, stdout=subprocess.DEVNULL)
name = f'orb-health-{rev}'
out(['docker', 'run', '-d', '--rm', '--name', name, '--network', 'none', '--memory', '768m', '--cpus', '1',
     '--entrypoint', '/usr/local/bin/sandboxed-sh', '-e', 'HOST=127.0.0.1', '-e', 'PORT=3000',
     '-e', 'DASHBOARD_PASSWORD=' + secrets.token_hex(16), '-e', 'JWT_SECRET=' + secrets.token_hex(32), image])
try:
    for _ in range(60):
        probe = ['docker', 'exec', name, 'python3', '-c',
                 'import urllib.request;assert urllib.request.urlopen("http://127.0.0.1:3000/api/health",timeout=2).status==200']
        if subprocess.run(probe, capture_output=True).returncode == 0: break
        time.sleep(1)
    else:
        raise RuntimeError('Isolated health check failed')
    v = {'image': image, 'previous_image': base, 'image_id': out(['docker', 'image', 'inspect', image, '--format', '{{.Id}}']),
         'sha256': hashlib.sha256((stage / 'sandboxed-sh').read_bytes()).hexdigest(), 'source_commit': rev,
         'tests_passed': passed, 'tests_failed': sorted(failed), 'isolated_health': True,
         'state': 'verified, not deployed', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (stage / 'VERIFIED.json').write_text(json.dumps(v, indent=2)); print(json.dumps(v))
finally:
    subprocess.run(['docker', 'stop', name], check=False, stdout=subprocess.DEVNULL)
