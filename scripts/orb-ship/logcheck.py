# Summarize Orb's UI log since the last app start: failures, errors, stalls, request volume.
import json, sys, collections, glob, os
path = sorted(glob.glob(os.path.expanduser('~/.orb/logs/orb-*.jsonl')))[-1]
rows = []
for line in open(path):
    try: rows.append(json.loads(line))
    except ValueError: pass
start = max((e['at'] for e in rows if e.get('kind') == 'started'), default='')
since = [e for e in rows if e.get('at', '') >= start]
c = collections.Counter()
for e in since:
    if e.get('kind') in ('failed-request', 'error', 'stall'):
        c[(e['kind'], e.get('path', '').split('?')[0][:60], str(e.get('detail') or e.get('message') or e.get('ms'))[:70])] += 1
print('log', path, 'since start', start, 'minutes', round((len(since) and (0)) or 0))
for k, n in c.most_common(20): print(n, *k)
for e in [e for e in since if e.get('kind') == 'summary'][-4:]:
    r = e['requests']
    print(e['at'][11:19], 'hidden' if e.get('hidden') else 'visible', 'req', r['count'], 'failed', r['failed'], 'worst', r.get('worst'), r.get('worstPath', '')[:60], 'stalls', e['stalls']['count'])
