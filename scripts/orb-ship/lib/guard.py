"""Process and bundle checks shared by the Orb install scripts.

Extracted from the 2026-10-18 worker-upgrade guard. Read-only except for the
worker RPC, which only issues diagnostic commands (e.g. "status").
"""
import hashlib, json, pathlib, socket, struct, subprocess

HOME = pathlib.Path.home()
ROOT = HOME / '.orb/runtime'
APP = HOME / 'Applications/Orb.app'


class Blocked(Exception):
    pass


def require(ok, why):
    if not ok:
        raise Blocked(why)


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def rpc(method, args=None, path=None):
    """Ask the execution worker (pinned in ~/.orb/runtime) a diagnostic question."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect(str(path or ROOT / 'owner.sock'))

        def read(n):
            b = b''
            while len(b) < n:
                q = s.recv(n - len(b))
                require(bool(q), 'Worker reply ended early')
                b += q
            return b

        def frame():
            n = struct.unpack('>I', read(4))[0]
            require(n <= 64 * 1024 * 1024, 'Invalid worker frame')
            return json.loads(read(n))

        require(frame().get('protocol') == 1, 'Unknown worker protocol')
        body = json.dumps({'method': method, 'args': args or {}}).encode()
        s.sendall(struct.pack('>I', len(body)) + body)
        reply = frame()
        require('error' not in reply, 'Worker refused diagnostic command')
        return reply['result']


def processes():
    rows = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,lstart=,stat=,comm='], text=True).splitlines():
        a = line.strip().split(None, 8)
        if len(a) == 9:
            rows[int(a[0])] = {'ppid': int(a[1]), 'start': ' '.join(a[2:7]), 'state': a[7], 'exe': a[8]}
    return rows


def descendants(rows, pid):
    ids = {pid}
    while True:
        more = {p for p, r in rows.items() if r['ppid'] in ids} - ids
        if not more:
            return ids - {pid}
        ids |= more


def children_clear(rows, pid):
    return all(rows[p]['state'].startswith('Z') for p in descendants(rows, pid))


def verify_bundle(app):
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
