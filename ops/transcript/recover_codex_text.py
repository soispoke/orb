"""Recover completed Codex commentary without controlling any execution.

Compatibility bridge for a pinned Core that predates native text identities.
Only native records bound to the same mission/thread are eligible. Missing rows
are inserted into vacant sequence slots between timestamped persisted events;
ambiguous/no-gap candidates remain pending. Existing rows are never edited.
A lifetime watch exits when the container owner changes. No model/tool commands,
credentials, process signals, session locks or agent inputs are used.
"""
import argparse
import bisect
import datetime
import fcntl
import hashlib
import json
import pathlib
import re
import sqlite3
import time


def timestamp(value):
    return datetime.datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', value).replace('Z', '+00:00')).timestamp()


def candidates(native, rows, mission):
    known = {r['event_id'] for r in rows if r['event_id']}
    ordered = sorted(rows, key=lambda r: (timestamp(r['timestamp']), r['sequence']))
    times = [timestamp(r['timestamp']) for r in ordered]
    used = {r['sequence'] for r in rows}
    latest = [r for r in rows if r['event_type'] == 'text_delta']
    planned = []
    for item in sorted(native, key=lambda n: (timestamp(n['time']), n['ordinal'])):
        key = 'codex:' + mission + ':' + item['id']
        if key in known or item['phase'] != 'commentary' or not item['text'].strip():
            continue
        # The pinned producer still renders its current mutable snapshot. Leave
        # that exact receipt alone until the producer advances to another item.
        if any(r['content'] == item['text'] and abs(timestamp(r['timestamp']) - timestamp(item['time'])) < 5 for r in latest):
            continue
        index = bisect.bisect_left(times, timestamp(item['time']))
        if index == 0 or index == len(rows):
            continue
        left, right = ordered[index - 1], ordered[index]
        if left['sequence'] >= right['sequence']:
            continue
        sequence = next((s for s in range(left['sequence'] + 1, right['sequence']) if s not in used), None)
        if sequence is None:
            continue
        used.add(sequence)
        known.add(key)
        planned.append(dict(item, sequence=sequence, event_id=key))
    return planned


def read_native(path, thread, state):
    stat = path.stat()
    identity = (stat.st_dev, stat.st_ino)
    if state.get('identity') != identity or stat.st_size < state.get('offset', 0):
        state.clear()
        state.update(identity=identity, offset=0, items={})
    with path.open('rb') as stream:
        stream.seek(state['offset'])
        while True:
            start = stream.tell()
            line = stream.readline()
            if not line or not line.endswith(b'\n'):
                state['offset'] = start
                break
            state['offset'] = stream.tell()
            row = json.loads(line)
            payload = row.get('payload', {})
            item = payload.get('item', {})
            if payload.get('type') != 'item_completed' or payload.get('thread_id') != thread or item.get('type') != 'AgentMessage':
                continue
            blocks = item.get('content', [])
            if any(block.get('type') != 'Text' for block in blocks):
                continue
            content = ''.join(block['text'] for block in blocks)
            record = {'id': item['id'], 'thread': thread, 'turn': payload['turn_id'], 'time': row['timestamp'], 'ordinal': row['ordinal'], 'text': content, 'phase': item.get('phase')}
            old = state['items'].get(item['id'])
            if old and old != record:
                raise ValueError('Conflicting native completion identity')
            state['items'][item['id']] = record
    return list(state['items'].values())


def recover(conn, root, states, apply, audit):
    count = 0
    for mission in conn.execute("SELECT id, session_id FROM missions WHERE backend='codex'").fetchall():
        mid, session = mission['id'], mission['session_id']
        binding = root / 'codex-sessions' / (mid + '.json')
        if not binding.exists() or not session or not session.startswith('codex-thread:'):
            continue
        bound = json.loads(binding.read_text())
        thread = bound['thread_id']
        if session != 'codex-thread:' + thread:
            continue
        home = pathlib.Path(bound['identity']['codex_home'])
        logs = list(home.glob('sessions/**/*' + thread + '.jsonl'))
        if len(logs) != 1:
            continue
        state = states.setdefault(mid, {})
        size = logs[0].stat().st_size
        if size == state.get('offset') and time.monotonic() - state.get('checked', 0) < 30:
            continue
        native = read_native(logs[0], thread, state)
        state['checked'] = time.monotonic()
        # A short transaction prevents sequence races with the async logger.
        # Busy means defer, never contend with execution or hold a long lock.
        try:
            conn.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
            rows = conn.execute("SELECT id,sequence,event_id,event_type,timestamp,CASE WHEN event_type IN ('text_delta','assistant_message','assistant_message_canonical') THEN content ELSE NULL END AS content FROM mission_events WHERE mission_id=? ORDER BY sequence", (mid,)).fetchall()
            plan = candidates(native, rows, mid)
            if apply:
                for item in plan:
                    metadata = {'bubble_id': item['event_id'], 'revision': 1, 'canonical_from': 'native_completion_recovery', 'native_thread': thread, 'native_turn': item['turn'], 'native_item': item['id'], 'native_ordinal': item['ordinal']}
                    conn.execute("INSERT INTO mission_events (mission_id,sequence,event_type,timestamp,event_id,content,metadata) VALUES (?,?,'assistant_message_canonical',?,?,?,?)", (mid,item['sequence'],item['time'],item['event_id'],item['text'],json.dumps(metadata)))
            conn.commit()
        except sqlite3.OperationalError as error:
            conn.rollback()
            if 'locked' in str(error):
                continue
            raise
        if plan:
            receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mission': mid, 'applied': apply, 'rows': [{'sequence': item['sequence'], 'event_id': item['event_id'], 'sha256': hashlib.sha256(item['text'].encode()).hexdigest()} for item in plan]}
            with audit.open('a') as output:
                output.write(json.dumps(receipt) + '\n')
            print(json.dumps({'mission': mid, 'recovered' if apply else 'recoverable': len(plan)}), flush=True)
        count += len(plan)
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, required=True)
    parser.add_argument('--db', type=pathlib.Path, required=True)
    parser.add_argument('--audit', type=pathlib.Path, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--watch', action='store_true')
    args = parser.parse_args()
    if args.watch and not args.apply:
        parser.error('--watch requires --apply')
    lock = args.audit.with_suffix('.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    conn = sqlite3.connect(str(args.db) if args.apply else 'file:' + str(args.db) + '?mode=ro', uri=not args.apply, timeout=.2)
    conn.row_factory = sqlite3.Row
    states = {}
    owner = pathlib.Path('/proc/1/stat').read_text().split()[21] if args.watch else None
    while True:
        recover(conn, args.root, states, args.apply, args.audit)
        if not args.watch or pathlib.Path('/proc/1/stat').read_text().split()[21] != owner:
            break
        time.sleep(5)


if __name__ == '__main__':
    main()
