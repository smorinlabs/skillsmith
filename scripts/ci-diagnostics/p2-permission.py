#!/usr/bin/env python3
"""One Linux CI observation; no source instrumentation or repair. Candidate, not executed."""
import ctypes
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

HEAD = '82c08f9e88f7b6887f215e185d0dae7c21b3fe02'
TREE = 'af24d78e31dcd898e49e33c81947fb9a398a020f'
PARENTS = ['5a7418593ecf6a8be4b10d8a5f657bb9e4f0e402', '59169deeeaaea2302fb2234bf2dcb67293008bca']
OWNER = 'tests/ergonomics/phase/EWP-P2-TS04.test.ts'
NAME = 'classifies EACCES and EPERM at every declared capability phase without secret leakage'
INPUTS = {
    OWNER: 'd2b40f7c422e6582fb8567921a69f0d44d267b24c391b1d6ad0f48741f565d64',
    'tests/ergonomics/fixtures/p2-ts04/crash-child.ts': 'e59f5bda519a87b757963cd8a4ccceaa7a60aa244e8aee3a25ededb20acea7da',
    'tests/ergonomics/fixtures/p2-ts04/recovery-cases.json': '4325f94c0ae8f1bc1dcce98b35995e9379e06b3019700f37dd48f1091ad07d33',
    'scripts/run-test-files-serial.ts': 'b9a8c6a19c56fddd1b8d36b4670234e2d9d0b392c02f6c6f3085d17a5e65f842',
    'bun.lock': '74d3bc04987f73c874cad501f79ad0f798827b01d14544bfb2d49b7012aee2d1',
}
WORKSPACE = pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()
ROOT = WORKSPACE / 'diagnostic-subject'
OUT = pathlib.Path(os.environ['RUNNER_TEMP']).resolve() / 'p2-permission-evidence'
START = json.loads((OUT / 'start.json').read_text())
DEADLINE = START['monotonic'] + 1080
WORK_END = DEADLINE - 90
LIMIT = 32 * 1024 * 1024
INTERRUPTED = None


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def save(name, value):
    target = OUT / name
    temporary = target.with_suffix(target.suffix + '.partial')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(target)


def proc(pid):
    try:
        raw = pathlib.Path(f'/proc/{pid}/stat').read_text()
        rest = raw[raw.rfind(')') + 2:].split()
        return {'pid': int(pid), 'state': rest[0], 'ppid': int(rest[1]), 'group': int(rest[2]),
                'session': int(rest[3]), 'cpu_ticks': int(rest[11]) + int(rest[12]),
                'start_ticks': int(rest[19]), 'rss_pages': int(rest[21])}
    except (OSError, ValueError, IndexError):
        return None


def descendants(root_pid):
    table = {}
    for entry in pathlib.Path('/proc').iterdir():
        if entry.name.isdecimal():
            row = proc(entry.name)
            if row:
                table[row['pid']] = row
    owned = {root_pid}
    while True:
        added = {pid for pid, row in table.items() if row['ppid'] in owned}
        if added <= owned:
            break
        owned |= added
    return [table[pid] for pid in owned if pid in table and pid != os.getpid()]


def signal_rows(rows, sig):
    for row in rows:
        now = proc(row['pid'])
        if now and now['start_ticks'] == row['start_ticks']:
            try:
                os.kill(row['pid'], sig)
            except ProcessLookupError:
                pass


def stop_owned(child, allowance=15):
    end = min(time.monotonic() + allowance, DEADLINE - 1)
    known = {}
    def census():
        # Both caller processes are dedicated subreapers; all direct/adopted children
        # belong to this controller. Recensus catches forks during shutdown.
        for row in descendants(os.getpid()):
            known[(row['pid'], row['start_ticks'])] = row
        return [now for row in known.values() if (now := proc(row['pid'])) and now['start_ticks'] == row['start_ticks']]
    term_end = min(time.monotonic() + 10, end - 5)
    while time.monotonic() < end:
        rows = census()
        live = [row for row in rows if row['state'] != 'Z']
        if live:
            signal_rows(live, signal.SIGTERM if time.monotonic() < term_end else signal.SIGKILL)
        child.poll()  # Preserve Popen's direct-child result before reaping adopted children.
        for row in census():
            if row['pid'] != child.pid and row['ppid'] == os.getpid() and row['state'] == 'Z':
                try:
                    os.waitpid(row['pid'], os.WNOHANG)
                except ChildProcessError:
                    pass
        if not census():
            break
        time.sleep(.1)
    survivors = census()  # Do not claim complete from an earlier census.
    return {'identified': list(known.values()), 'survivors': survivors, 'complete': not survivors}


def interrupted(sig, _frame):
    global INTERRUPTED
    INTERRUPTED = sig


for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, interrupted)


def clean_env():
    # Match the serial runner's Git routing scrub. Do not inject OPTIONAL_LOCKS into Bun.
    return {k: v for k, v in os.environ.items() if not k.startswith('GIT_') and k not in {'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN'}}


def observe(argv):
    env = clean_env()
    env['GIT_OPTIONAL_LOCKS'] = '0'
    remaining = min(5, DEADLINE - 16 - time.monotonic())
    if remaining <= 0:
        raise RuntimeError('observation budget exhausted')
    p = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True, timeout=remaining)
    if p.returncode:
        raise RuntimeError(f'observer failed: {argv!r}; exit={p.returncode}')
    return p.stdout.decode().strip()


def git(*args):
    return observe(['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false', *args])


def snapshot(label):
    gitdir = pathlib.Path(git('rev-parse', '--absolute-git-dir'))
    index = gitdir / 'index'
    config = gitdir / 'config'
    raw = index.read_bytes()
    (OUT / f'{label}.index').write_bytes(raw)
    symbolic = subprocess.run(['/usr/bin/git', '-c', 'core.fsmonitor=false', 'symbolic-ref', '--quiet', 'HEAD'], cwd=ROOT,
        env={**clean_env(), 'GIT_OPTIONAL_LOCKS': '0'}, capture_output=True, timeout=5)
    if symbolic.returncode not in (0, 1) or (symbolic.returncode == 1 and (symbolic.stdout or symbolic.stderr)):
        raise RuntimeError('invalid symbolic-ref observation')
    result = {'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
        'parents': git('show', '-s', '--format=%P', 'HEAD').split(),
        'root': git('rev-parse', '--show-toplevel'), 'ref': symbolic.stdout.decode().strip() if symbolic.returncode == 0 else None,
        'index_path': str(index), 'index_sha256': hashlib.sha256(raw).hexdigest(),
        'config_sha256': digest(config), 'worktree_config_sha256': digest(gitdir / 'config.worktree'),
        'index_lock_sha256': digest(gitdir / 'index.lock'), 'index_lock_exists': (gitdir / 'index.lock').exists(),
        'status': git('status', '--porcelain=v1', '--untracked-files=all'),
        'input_sha256': {name: digest(ROOT / name) for name in INPUTS}}
    save(f'{label}.json', result)
    return result


def run_command(label, argv, env, seconds, admission):
    if WORK_END - time.monotonic() < admission:
        record = {'status': 'not_run_due_to_global_budget', 'remaining_work_seconds': WORK_END - time.monotonic(), 'required_seconds': admission, 'command': argv}
        save(f'{label}.json', record)
        raise RuntimeError(label + ': not_run_due_to_global_budget')
    cap = min(seconds, WORK_END - time.monotonic() - 15)
    record = {'command': argv, 'cwd': str(ROOT), 'started_unix': time.time(), 'cap_seconds': cap, 'child_exit': None}
    start = time.monotonic()
    with (OUT / f'{label}.stdout').open('xb') as out, (OUT / f'{label}.stderr').open('xb') as err:
        child = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=out, stderr=err)
        record['pid'] = child.pid
        save(f'{label}.active.json', {'pid': child.pid, 'monotonic': start})
        reason = None
        next_sample = start
        with (OUT / f'{label}.process.jsonl').open('x') as trace:
            while child.poll() is None:
                now = time.monotonic()
                if now >= next_sample:
                    rows = descendants(child.pid)
                    fs = os.statvfs(env['TMPDIR'])
                    trace.write(json.dumps({'elapsed_seconds': now - start, 'owned_processes': rows, 'tmp_free_bytes': fs.f_bavail * fs.f_frsize,
                        'owned_row_root_count': sum(1 for _ in pathlib.Path(env['TMPDIR']).iterdir())}) + '\n')
                    trace.flush()
                    next_sample = now + 2
                if INTERRUPTED or now - start >= cap or out.tell() + err.tell() >= LIMIT:
                    reason = 'signal' if INTERRUPTED else 'external_deadline' if now - start >= cap else 'output_cap'
                    break
                time.sleep(.1)
        if out.tell() + err.tell() >= LIMIT:
            reason = reason or 'output_cap'
        record['primary_exit_before_cleanup'] = child.poll()
        # Cleanup is required even if the root exits while its owned children remain.
        record['cleanup'] = stop_owned(child)
        record['child_exit'] = child.returncode
        record['supervisor_reason'] = reason
    record['elapsed_seconds'] = time.monotonic() - start
    save(f'{label}.json', record)
    if reason or record['child_exit'] != 0 or not record['cleanup']['complete']:
        raise RuntimeError(label + ': command or owned cleanup failed')
    return record


def junit():
    path = OUT / 'selected.junit.xml'
    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError('missing JUnit: no diagnostic success')
    root = ET.parse(path).getroot()
    cases = list(root.iter('testcase'))
    active = [x for x in cases if x.find('skipped') is None]
    target = [x for x in active if x.get('name') == NAME and x.get('file') == OWNER]
    result = {'all_cases': [dict(x.attrib, skipped=x.find('skipped') is not None, failure=x.find('failure') is not None, error=x.find('error') is not None) for x in cases],
              'active_count': len(active), 'target_count': len(target), 'root_attributes': root.attrib}
    save('junit-selection.json', result)
    if len(active) != 1 or len(target) != 1 or list(root.iter('failure')) or list(root.iter('error')) or int(target[0].get('assertions', '0')) <= 0:
        raise RuntimeError('JUnit target/selection/result mismatch')
    return result


def worker():
    result = {'status': 'incomplete', 'test_invocations': 0, 'errors': [], 'signal': None}
    before = None
    try:
        assert os.environ['GITHUB_REF'] == 'refs/heads/agent/p19-p17-ci-diagnosis'
        assert os.environ['GITHUB_RUN_ATTEMPT'] == '1'
        assert not os.environ.get('SKILLSMITH_E2E')
        assert not any(k.startswith('P17_') for k in os.environ)
        before = snapshot('before-install')
        assert before['head'] == HEAD and before['tree'] == TREE and before['parents'] == PARENTS
        assert before['root'] == str(ROOT) and before['ref'] is None and before['status'] == '' and not before['index_lock_exists']
        assert before['input_sha256'] == INPUTS
        assert (ROOT / OWNER).read_text().count("'" + NAME + "'") == 1
        bun = shutil.which('bun')
        assert bun and observe([bun, '--version']) == '1.3.14'
        revision = observe([bun, '--revision'])
        assert revision.startswith('1.3.14+0d9b296a')
        env = clean_env()
        owned = pathlib.Path(os.environ['RUNNER_TEMP']) / 'p2-permission-owned'
        owned.mkdir(exist_ok=False)
        for name in ['home', 'tmp', 'config', 'cache', 'data']:
            (owned / name).mkdir()
        env.update(HOME=str(owned / 'home'), TMPDIR=str(owned / 'tmp'), XDG_CONFIG_HOME=str(owned / 'config'), XDG_CACHE_HOME=str(owned / 'cache'), XDG_DATA_HOME=str(owned / 'data'))
        platform = {'uname': tuple(os.uname()), 'cpu_count': os.cpu_count(), 'bun': bun, 'bun_sha256': digest(pathlib.Path(bun)), 'bun_revision': revision,
            'git': observe(['/usr/bin/git', '--version']), 'controller_sha256': digest(pathlib.Path(__file__)),
            'image': {k: os.environ.get(k) for k in ['ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH']},
            'owned_environment': {k: env[k] for k in ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']}}
        for path in ['/proc/meminfo', '/proc/self/cgroup', '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current']:
            try:
                platform[path] = pathlib.Path(path).read_text()[:16384]
            except OSError as error:
                platform[path] = {'unavailable': str(error)}
        save('platform.json', platform)
        run_command('install', [bun, 'install', '--frozen-lockfile', '--ignore-scripts'], env, 180, 195)
        installed = snapshot('before-test')
        assert before == installed, 'setup changed repository identity'
        argv = [bun, 'test', './' + OWNER, '--timeout=60000', '--max-concurrency=1', '--no-orphans', '--retry=0', '--reporter=junit', '--reporter-outfile=' + str(OUT / 'selected.junit.xml'), '--test-name-pattern=' + NAME]
        run_command('selected', argv, env, 330, 360)  # Original300 s test; normal330+15 cleanup, outer345+15 hard fallback.
        junit()
        result['status'] = 'selected_pass_not_reproduced'
    except BaseException as error:
        result['errors'].append(f'{type(error).__name__}: {error}')
    finally:
        result['signal'] = INTERRUPTED
        result['test_invocations'] = int((OUT / 'selected.active.json').is_file())
        if (OUT / 'selected.active.json').is_file() and not (OUT / 'junit-selection.json').is_file():
            try:
                junit()
            except BaseException as error:
                result['errors'].append('JUnit: ' + repr(error))
        try:
            after = snapshot('after')
            result['identity_equal'] = before is not None and before == after
            if not result['identity_equal']:
                result['errors'].append('raw repository identity changed or initial snapshot absent')
        except BaseException as error:
            result['errors'].append('final_snapshot: ' + repr(error))
        if result['errors'] or INTERRUPTED:
            result['status'] = 'failed_or_incomplete'
        selected_path = OUT / 'selected.json'
        selected = json.loads(selected_path.read_text()) if selected_path.is_file() else {}
        stderr_path = OUT / 'selected.stderr'
        diagnostic_stderr = stderr_path.read_text(errors='replace') if stderr_path.is_file() else ''
        if 'this test timed out after 300000ms' in diagnostic_stderr:
            primary = 'selected_test_timeout_300000ms'
        elif selected.get('supervisor_reason'):
            primary = 'selected_supervisor_' + selected['supervisor_reason']
        elif selected.get('primary_exit_before_cleanup') == 0:
            primary = 'selected_process_exit_0'  # Requires separate valid JUnit/guard proof.
        elif selected.get('primary_exit_before_cleanup') is not None:
            primary = 'selected_nonzero_test_or_process_failure'
        elif result['test_invocations'] == 0:
            primary = 'selected_not_launched'
        else:
            primary = 'selected_primary_outcome_incomplete'
        result['primary_outcome'] = primary
        result['primary_exit_before_cleanup'] = selected.get('primary_exit_before_cleanup')
        selection_path = OUT / 'junit-selection.json'
        selection = json.loads(selection_path.read_text()) if selection_path.is_file() else {}
        result['evidence_complete'] = bool(result.get('identity_equal') and selected.get('cleanup', {}).get('complete') and
            selected.get('primary_exit_before_cleanup') is not None and selection.get('active_count') == 1 and selection.get('target_count') == 1 and not INTERRUPTED)
        if result['evidence_complete'] and primary == 'selected_test_timeout_300000ms':
            result['status'] = 'selected_test_timeout_reproduced'
        elif result['evidence_complete'] and primary == 'selected_nonzero_test_or_process_failure':
            result['status'] = 'selected_failure_recorded'
        result['ended_unix'] = time.time()
        save('receipt.json', result)
    return 0 if result['status'] == 'selected_pass_not_reproduced' else 1


def supervise():
    # Linux process-local subreaper; never changes services, CPU quotas or host configuration.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot establish owned orphan reaping')
    child = subprocess.Popen([sys.executable, __file__, '--worker'])  # Remain inside enclosing timeout process group.
    primary = None
    selected_watchdog = False
    while child.poll() is None and not INTERRUPTED and time.monotonic() < DEADLINE - 30:
        active = OUT / 'selected.active.json'
        if active.is_file() and not (OUT / 'selected.json').is_file():
            begun = json.loads(active.read_text())['monotonic']
            if time.monotonic() - begun >= 345:
                selected_watchdog = True
                break
        time.sleep(.2)
    primary = child.poll()
    cleanup = stop_owned(child, 15)
    summary = {'worker_exit_before_cleanup': primary, 'worker_exit': child.returncode, 'signal': INTERRUPTED,
        'global_deadline_reached': time.monotonic() >= DEADLINE - 30, 'selected_watchdog': selected_watchdog, 'cleanup': cleanup,
        'elapsed_since_first_step': time.monotonic() - START['monotonic'], 'terminal_receipt_present': (OUT / 'receipt.json').is_file()}
    save('supervisor.json', summary)
    print(json.dumps(summary), flush=True)
    files = []
    for path in sorted(OUT.iterdir()):
        if path.is_file():
            files.append({'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
    save('artifact-manifest.json', files)
    return 0 if primary == 0 and cleanup['complete'] and not INTERRUPTED and not selected_watchdog and summary['terminal_receipt_present'] else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--worker']:
        # Worker also adopts grandchildren so normal root exit cannot conceal owned children.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise SystemExit('cannot establish worker subreaper')
        raise SystemExit(worker())
    if sys.argv[1:]:
        raise SystemExit('unexpected arguments')
    raise SystemExit(supervise())
