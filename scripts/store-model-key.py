#!/usr/bin/env python3
"""Read a provider key from stdin; write only to the current Linux user's state.

No key is accepted through argv or printed. Existing nonempty credentials are
preserved unless the operator explicitly passes --replace.
"""
import argparse
import os
from pathlib import Path
import re
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--replace', action='store_true')
args = parser.parse_args()
key = sys.stdin.buffer.read(4097).strip()
if len(key) > 4096 or len(key) < 20 or not re.fullmatch(rb'[A-Za-z0-9_.-]+', key):
    raise SystemExit('Credential format rejected; no value was printed or stored.')
state = Path(os.environ.get('BOT_SECRET_DIR', str(Path.home() / '.local/state/private-computer-p0')))
state.mkdir(mode=0o700, parents=True, exist_ok=True)
if state.is_symlink() or not state.is_dir():
    raise SystemExit('State path must be a real private directory.')
path = state / 'model-key'
if path.is_symlink():
    raise SystemExit('Credential target must not be a symlink.')
if path.exists() and path.stat().st_size and not args.replace:
    raise SystemExit('An existing credential was preserved; use --replace to rotate it.')
flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
flags |= os.O_TRUNC if args.replace or path.exists() else os.O_EXCL
fd = os.open(path, flags, 0o400)
try:
    os.fchmod(fd, 0o400)
    os.write(fd, key + b'\n')
    os.fsync(fd)
finally:
    os.close(fd)
key = b''
print('Provider credential stored in private Linux state; its value was not logged.')
