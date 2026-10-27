"""Shared bits of the MINT Library tools: where things live, the manifest, slugs, safe writes.

The manifest (the list of folders and videos) is data, not code, so it lives outside the repo:
  MINT_LIBRARY_MANIFEST  default /var/lib/mint-library/library.json
The public site is written to:
  MINT_LIBRARY_ROOT      default /var/www/library
and its links point at:
  MINT_LIBRARY_URL       default https://library.mint-stack.com
"""
import json
import os
import re
import shutil
import tempfile
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SITE_ROOT = os.environ.get('MINT_LIBRARY_ROOT', '/var/www/library')
MANIFEST = os.environ.get('MINT_LIBRARY_MANIFEST', '/var/lib/mint-library/library.json')
BASE_URL = os.environ.get('MINT_LIBRARY_URL', 'https://library.mint-stack.com').rstrip('/')

SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')

DEFAULT_FOLDERS = [
    {'slug': 'pre-read', 'title': 'Pre-read', 'order': 0,
     'desc': 'Short films to watch before a meeting.'},
]


def slugify(text):
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')
    text = re.sub(r'[^a-zA-Z0-9]+', '-', text).strip('-').lower()
    return re.sub(r'-{2,}', '-', text)[:80].strip('-') or 'video'


def folder_title(slug):
    t = slug.replace('-', ' ').strip()
    return t[:1].upper() + t[1:] if t else slug


def load():
    if not os.path.exists(MANIFEST):
        return {'version': 1, 'folders': [dict(f) for f in DEFAULT_FOLDERS], 'videos': []}
    with open(MANIFEST, encoding='utf-8') as f:
        data = json.load(f)
    data.setdefault('folders', [dict(f) for f in DEFAULT_FOLDERS])
    data.setdefault('videos', [])
    return data


def save(data):
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    if os.path.exists(MANIFEST):
        shutil.copy2(MANIFEST, MANIFEST + '.bak')
    write_text(MANIFEST, json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def write_text(path, text):
    """Atomic, world-readable write (nginx runs as www-data)."""
    d = os.path.dirname(path)
    makedirs(d)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.tmp-')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def makedirs(path):
    os.makedirs(path, exist_ok=True)
    # Every directory between the site root and the path must be traversable by nginx.
    p = os.path.abspath(path)
    while True:
        try:
            os.chmod(p, 0o755)
        except PermissionError:
            break
        if p in (os.path.abspath(SITE_ROOT), '/', os.path.dirname(os.path.abspath(MANIFEST))):
            break
        if not p.startswith(os.path.abspath(SITE_ROOT)):
            break
        p = os.path.dirname(p)


def inside_site(path):
    root = os.path.realpath(SITE_ROOT)
    real = os.path.realpath(path)
    return real != root and real.startswith(root + os.sep)


def remove_tree(path):
    """Delete a directory, but only one inside the site root."""
    if not inside_site(path):
        raise SystemExit('refusing to delete outside %s: %s' % (SITE_ROOT, path))
    if os.path.isdir(path):
        shutil.rmtree(path)


def video_dir(v):
    return os.path.join(SITE_ROOT, v['folder'], v['slug'])


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
