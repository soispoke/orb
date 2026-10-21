# Follow Orb's UI log; print one line the first time each kind of failure appears,
# and again when a kind repeats unusually often (a new loop).
import json, os, re, sys, time, glob, collections

def current():
    return sorted(glob.glob(os.path.expanduser('~/.orb/logs/orb-*.jsonl')))[-1]

def kind(e):
    k = e.get('kind')
    if k == 'failed-request':
        path = re.sub(r'[0-9a-f]{8}-[0-9a-f-]{27,}', ':id', e.get('path', '').split('?')[0])
        detail = re.sub(r'[0-9a-f]{8}-[0-9a-f-]{27,}', ':id', str(e.get('detail', '')))[:80]
        return f'failed {path} {detail}'
    if k == 'error': return 'error ' + str(e.get('message', ''))[:100]
    if k == 'stall' and e.get('ms', 0) >= 1000: return 'long stall'
    if k == 'started': return 'app started'
    return None

seen, window = set(sys.argv[1:]), collections.defaultdict(list)
path = current(); f = open(path); f.seek(0, 2)
while True:
    line = f.readline()
    if not line:
        time.sleep(1)
        if current() != path: path = current(); f = open(path)
        continue
    try: e = json.loads(line)
    except ValueError: continue
    k = kind(e)
    if not k: continue
    now = time.time(); w = window[k]; w.append(now)
    while w and now - w[0] > 300: w.pop(0)
    if k not in seen:
        seen.add(k); print('NEW', e.get('at', '')[11:19], k, flush=True)
    elif len(w) == 20:
        print('LOOP', e.get('at', '')[11:19], k, '20 in 5 min', flush=True)
