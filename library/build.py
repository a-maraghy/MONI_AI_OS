#!/usr/bin/env python3
"""Rebuild every page of the MINT Library from the manifest.

  python3 library/build.py

Writes /var/www/library/{index.html, assets/, <folder>/index.html, <folder>/<slug>/index.html,
embed/<slug>/index.html}. Media files are left alone (add.py makes them). Safe to run any time.
"""
import hashlib
import html
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mintlib as L  # noqa: E402

ASSETS = {  # published name -> source in the repo
    'player.js': 'library/player/player.js',
    'player.css': 'library/player/player.css',
    'site.css': 'library/site/site.css',
    'site.js': 'library/site/site.js',
    'favicon.svg': 'dashboard/public/brand/m/favicon.svg',
    'favicon.ico': 'dashboard/public/brand/m/favicon.ico',
    'fonts/next-400.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2',
    'fonts/next-600.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-600-normal.woff2',
    'fonts/next-700.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-700-normal.woff2',
    'fonts/next-800.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-800-normal.woff2',
    'fonts/mono-400.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-mono-latin-400-normal.woff2',
    'fonts/OFL-AtkinsonHyperlegibleNext.txt': 'dashboard/public/fonts/OFL-AtkinsonHyperlegibleNext.txt',
    'fonts/OFL-AtkinsonHyperlegibleMono.txt': 'dashboard/public/fonts/OFL-AtkinsonHyperlegibleMono.txt',
}
VER = {}
E = html.escape
MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()


def asset(name):
    return '/assets/%s?v=%s' % (name, VER.get(name, '0'))


def copy_assets():
    dst_root = os.path.join(L.SITE_ROOT, 'assets')
    L.makedirs(os.path.join(dst_root, 'fonts'))
    for name, src in ASSETS.items():
        src = os.path.join(L.REPO, src)
        with open(src, 'rb') as f:
            body = f.read()
        VER[name] = hashlib.sha1(body).hexdigest()[:10]
        dst = os.path.join(dst_root, name)
        tmp = dst + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(body)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dst)
    os.chmod(os.path.join(dst_root, 'fonts'), 0o755)


def fdate(iso):
    y, m, d = iso[:10].split('-')
    return '%d %s %s' % (int(d), MONTHS[int(m) - 1], y)


def fdur(sec):
    s = int(round(sec))
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return '%d:%02d:%02d' % (h, m, s) if h else '%d:%02d' % (m, s)


def fdur_words(sec):
    s = int(round(sec))
    m, s = divmod(s, 60)
    return ('%d min %d s' % (m, s)) if m else '%d s' % s


def fsize(b):
    return '%.0f MB' % (b / 1e6) if b >= 1e7 else '%.1f MB' % (b / 1e6)


def vurl(v, absolute=False):
    p = '/%s/%s/' % (v['folder'], v['slug'])
    return L.BASE_URL + p if absolute else p


def media(v, name, absolute=False):
    return vurl(v, absolute) + name


def head(title, desc, url, image=None, video=None, og_type='website', extra=''):
    tags = [
        '<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        '<title>%s</title>' % E(title),
        '<meta name="description" content="%s">' % E(desc),
        '<meta name="robots" content="noindex, nofollow">',
        '<meta name="referrer" content="strict-origin-when-cross-origin">',
        '<meta name="color-scheme" content="light dark">',
        '<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">',
        '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">',
        '<link rel="icon" href="%s" type="image/svg+xml">' % asset('favicon.svg'),
        '<link rel="alternate icon" href="%s" sizes="32x32">' % asset('favicon.ico'),
        '<link rel="preload" href="%s" as="font" type="font/woff2" crossorigin>' % asset('fonts/next-400.woff2'),
        '<meta property="og:site_name" content="MINT Library">',
        '<meta property="og:type" content="%s">' % og_type,
        '<meta property="og:title" content="%s">' % E(title.split(' · ')[0]),
        '<meta property="og:description" content="%s">' % E(desc),
        '<meta property="og:url" content="%s">' % E(url),
    ]
    if image:
        tags += [
            '<meta property="og:image" content="%s">' % E(image['url']),
            '<meta property="og:image:secure_url" content="%s">' % E(image['url']),
            '<meta property="og:image:type" content="image/jpeg">',
            '<meta property="og:image:width" content="%d">' % image['width'],
            '<meta property="og:image:height" content="%d">' % image['height'],
            '<meta property="og:image:alt" content="%s">' % E(image['alt']),
            '<meta name="twitter:card" content="summary_large_image">',
            '<meta name="twitter:image" content="%s">' % E(image['url']),
        ]
    if video:
        tags += [
            '<meta property="og:video" content="%s">' % E(video['url']),
            '<meta property="og:video:secure_url" content="%s">' % E(video['url']),
            '<meta property="og:video:type" content="video/mp4">',
            '<meta property="og:video:width" content="%d">' % video['width'],
            '<meta property="og:video:height" content="%d">' % video['height'],
            '<meta property="video:duration" content="%d">' % int(round(video['duration'])),
        ]
    tags += ['<meta name="twitter:title" content="%s">' % E(title.split(' · ')[0]),
             '<meta name="twitter:description" content="%s">' % E(desc)]
    tags.append(extra)
    tags.append('</head>')
    return '\n'.join(t for t in tags if t)


def topbar():
    return ('<a class="skip-link" href="#main">Skip to the content</a>\n'
            '<header class="topbar"><a class="brand" href="/" aria-label="MINT Library, home">'
            '<span class="wordmark"><span class="wm-mint">MINT</span><span class="wm-sub">Library</span></span></a>'
            '</header>')


def footer():
    return ('<footer class="foot"><p>Anyone with a link can watch. These pages are not listed in search engines.</p>'
            '</footer>')


def card(v, heading='h2'):
    p = v['poster']
    return (
        '<li class="card" data-date="%(date)s" data-added="%(added)s" data-title="%(tkey)s" data-dur="%(dur).3f" '
        'data-text="%(text)s">'
        '<a class="card-media" href="%(url)s" tabindex="-1" aria-hidden="true">'
        '<img src="%(img)s" width="640" height="%(ih)d" alt="" loading="lazy" decoding="async">'
        '<span class="badge"><span class="sr">Length </span>%(fd)s</span></a>'
        '<div class="card-body"><%(h)s class="card-title"><a href="%(url)s">%(title)s</a></%(h)s>'
        '<p class="card-meta"><time datetime="%(date)s">%(fdate)s</time><span aria-hidden="true"> · </span>'
        '<span>%(fdw)s</span></p>'
        '<p class="card-desc">%(desc)s</p></div></li>'
    ) % {
        'date': E(v['date']), 'added': E(v.get('added', '')), 'tkey': E(v['title'].lower()),
        'dur': v['duration'], 'text': E((v['title'] + ' ' + v.get('desc', '')).lower()),
        'url': vurl(v), 'img': media(v, p['small']) + '?v=' + v.get('updated', '')[:19].replace(':', ''),
        'ih': int(round(640 * p['height'] / float(p['width']))),
        'fd': fdur(v['duration']), 'h': heading, 'title': E(v['title']), 'fdate': fdate(v['date']),
        'fdw': fdur_words(v['duration']), 'desc': E(v.get('desc', '')),
    }


def newest(videos):
    return sorted(videos, key=lambda v: (v['date'], v.get('added', '')), reverse=True)


def player_config(v):
    return {
        'id': v['slug'], 'title': v['title'], 'duration': v['duration'],
        'poster': media(v, v['poster']['file']),
        'sources': [{'h': r['height'], 'w': r['width'], 'src': media(v, r['file']), 'bytes': r['bytes']}
                    for r in sorted(v['renditions'], key=lambda r: -r['height'])],
        'thumbs': media(v, v['sprite']['vtt']) if v.get('sprite') else None,
        'captions': [{'src': media(v, c['file']), 'lang': c['lang'], 'label': c['label']}
                     for c in v.get('captions', [])],
    }


def player_html(v, embed=False):
    cfg = json.dumps(player_config(v), separators=(',', ':'), ensure_ascii=False)
    first = sorted(v['renditions'], key=lambda r: abs(r['height'] - 720))[0]
    w, h = v['width'], v['height']
    tracks = ''.join('<track kind="captions" src="%s" srclang="%s" label="%s">'
                     % (media(v, c['file']), E(c['lang']), E(c['label'])) for c in v.get('captions', []))
    return ('<div class="mlp%s" data-mlp="%s" style="--mlp-ar:%d/%d;--mlp-r:%.4f">'
            '<video class="mlp-video" controls playsinline preload="metadata" poster="%s" '
            'aria-label="Video: %s" width="%d" height="%d"><source src="%s" type="video/mp4">%s'
            '<a href="%s">Download the video</a></video></div>') % (
        ' mlp-embed' if embed else '', E(cfg, quote=True), w, h, w / float(h), media(v, v['poster']['file']), E(v['title']),
        w, h, media(v, first['file']), tracks, media(v, first['file']))


def og_media(v):
    p = v['poster']
    og_r = sorted(v['renditions'], key=lambda r: abs(r['height'] - 720))[0]
    image = {'url': media(v, p['file'], True), 'width': p['width'], 'height': p['height'],
             'alt': 'Poster of the film %s' % v['title']}
    video = {'url': media(v, og_r['file'], True), 'width': og_r['width'], 'height': og_r['height'],
             'duration': v['duration']}
    return image, video


def css_links(player=False):
    out = '<link rel="stylesheet" href="%s">' % asset('site.css')
    if player:
        out += '\n<link rel="stylesheet" href="%s">' % asset('player.css')
    return out


def page(title, desc, url, body, image=None, video=None, og_type='website', player=False, cls=''):
    return '\n'.join([
        head(title, desc, url, image, video, og_type, css_links(player)),
        '<body class="%s">' % cls, topbar(), '<main id="main" tabindex="-1">', body, '</main>', footer(),
        ('<script src="%s" defer></script>' % asset('player.js')) if player else '',
        '<script src="%s" defer></script>' % asset('site.js'),
        '</body>', '</html>', ''])


def build_home(data):
    folders = sorted(data['folders'], key=lambda f: (f.get('order', 99), f['title']))
    items = []
    for f in folders:
        vids = newest([v for v in data['videos'] if v['folder'] == f['slug']])
        n = len(vids)
        cover = ''
        if vids:
            p = vids[0]['poster']
            cover = '<img src="%s" width="640" height="%d" alt="" loading="lazy" decoding="async">' % (
                media(vids[0], p['small']), int(round(640 * p['height'] / float(p['width']))))
        else:
            cover = '<span class="folder-empty" aria-hidden="true">No videos yet</span>'
        items.append(
            '<li class="folder"><a class="folder-link" href="/%s/"><span class="folder-cover">%s</span>'
            '<span class="folder-body"><span class="folder-title">%s</span>'
            '<span class="folder-count">%s</span>%s</span></a></li>' % (
                f['slug'], cover, E(f['title']), '%d video%s' % (n, '' if n == 1 else 's'),
                ('<span class="folder-desc">%s</span>' % E(f['desc'])) if f.get('desc') else ''))
    body = ('<div class="wrap"><div class="page-head"><h1>Library</h1>'
            '<p class="lead">Shared videos, kept in folders. Open a folder to watch.</p></div>'
            '<h2 class="sr">Folders</h2><ul class="folders" role="list">%s</ul></div>') % ''.join(items)
    n = len(data['videos'])
    desc = 'Shared MINT videos in %d folder%s.' % (len(folders), '' if len(folders) == 1 else 's')
    image = None
    vids = newest(data['videos'])
    if vids:
        image = og_media(vids[0])[0]
    L.write_text(os.path.join(L.SITE_ROOT, 'index.html'),
                 page('MINT Library', desc, L.BASE_URL + '/', body, image=image, cls='home'))
    return n


def build_folder(data, f):
    vids = newest([v for v in data['videos'] if v['folder'] == f['slug']])
    n = len(vids)
    controls = (
        '<div class="toolbar" role="search">'
        '<div class="field field-search"><label for="q">Search</label>'
        '<input id="q" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Title or words">'
        '</div>'
        '<div class="field"><label for="sort">Sort</label><select id="sort" name="sort">'
        '<option value="newest">Newest first</option><option value="oldest">Oldest first</option>'
        '<option value="title">Title A–Z</option><option value="longest">Longest</option></select></div>'
        '</div>')
    empty_folder = ('<div class="empty"><span class="empty-shape" aria-hidden="true">○</span>'
                    '<h2>No videos in %s yet</h2><p>Videos shared here will be listed newest first.</p>'
                    '<p><a href="/">Back to the library</a></p></div>') % E(f['title'])
    no_match = ('<div class="empty" id="nomatch" hidden><span class="empty-shape" aria-hidden="true">○</span>'
                '<h2>Nothing matches <span id="nomatch-q"></span></h2>'
                '<p>Try other words, or show every video.</p>'
                '<p><button type="button" class="btn" id="clear-q">Clear the search</button></p></div>')
    body = (
        '<div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Library</a></li>'
        '<li aria-current="page">%(title)s</li></ol></nav>'
        '<div class="page-head"><h1>%(title)s</h1>%(desc)s</div>'
        '%(controls)s<p class="count" id="count" aria-live="polite">%(count)s</p>'
        '<ul class="grid" id="grid" role="list">%(cards)s</ul>%(empty)s</div>'
    ) % {
        'title': E(f['title']),
        'desc': ('<p class="lead">%s</p>' % E(f['desc'])) if f.get('desc') else '',
        'controls': controls if n else '',
        'count': ('%d video%s' % (n, '' if n == 1 else 's')) if n else '',
        'cards': ''.join(card(v) for v in vids),
        'empty': no_match if n else empty_folder,
    }
    desc = f.get('desc') or ('%d video%s in %s.' % (n, '' if n == 1 else 's', f['title']))
    image = og_media(vids[0])[0] if vids else None
    L.write_text(os.path.join(L.SITE_ROOT, f['slug'], 'index.html'),
                 page('%s · MINT Library' % f['title'], desc, '%s/%s/' % (L.BASE_URL, f['slug']), body,
                      image=image, cls='folder-page'))


def embed_code(v):
    return ('<iframe src="%s/embed/%s/" width="960" height="540" title="%s" '
            'allow="fullscreen; picture-in-picture; autoplay; encrypted-media" allowfullscreen '
            'style="border:0;max-width:100%%;aspect-ratio:%d/%d;height:auto"></iframe>') % (
        L.BASE_URL, v['slug'], E(v['title']), v['width'], v['height'])


def build_video(data, f, v):
    others = [o for o in newest(data['videos']) if o['folder'] == v['folder'] and o['slug'] != v['slug']][:6]
    image, video = og_media(v)
    downloads = ''.join(
        '<li><a href="%s" download="%s" role="menuitem">%dp <span class="dl-size">%s · MP4</span></a></li>' % (
            media(v, r['file']), E('%s %dp.mp4' % (v['title'], r['height'])), r['height'], fsize(r['bytes']))
        for r in sorted(v['renditions'], key=lambda r: -r['height']))
    more = ('<ul class="grid grid-more" role="list">%s</ul>' % ''.join(card(o, 'h3') for o in others)) if others else (
        '<p class="muted">No other videos in %s yet. <a href="/%s/">See the folder</a></p>' % (
            E(f['title']), f['slug']))
    body = (
        '<div class="wrap wrap-video"><nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Library</a>'
        '</li><li><a href="/%(fslug)s/">%(ftitle)s</a></li><li aria-current="page">%(title)s</li></ol></nav>'
        '<div class="stage">%(player)s</div>'
        '<div class="video-info"><h1>%(title)s</h1>'
        '<p class="video-meta"><time datetime="%(date)s">%(fdate)s</time><span aria-hidden="true"> · </span>'
        '<span>%(fdw)s</span><span aria-hidden="true"> · </span><span>%(qual)s</span></p>'
        '<p class="video-desc">%(desc)s</p>'
        '<div class="actions">'
        '<button type="button" class="btn btn-primary" data-copy="%(url)s" data-copy-label="Link copied">'
        '<span class="btn-label">Copy link</span></button>'
        '<button type="button" class="btn" data-copy="%(embed)s" data-copy-label="Embed code copied">'
        '<span class="btn-label">Copy embed code</span></button>'
        '<div class="menu-wrap" data-menu><button type="button" class="btn" aria-haspopup="menu" aria-expanded="false"'
        ' aria-controls="dl-menu">Download <span aria-hidden="true" class="caret">▾</span></button>'
        '<ul class="menu" id="dl-menu" role="menu" hidden>%(downloads)s</ul></div>'
        '</div><p class="status" id="copy-status" role="status" aria-live="polite"></p></div>'
        '<section class="more" aria-labelledby="more-h"><h2 id="more-h">More in %(ftitle)s</h2>%(more)s</section>'
        '</div>'
    ) % {
        'fslug': f['slug'], 'ftitle': E(f['title']), 'title': E(v['title']), 'player': player_html(v),
        'date': E(v['date']), 'fdate': fdate(v['date']), 'fdw': fdur_words(v['duration']),
        'qual': 'up to %dp' % v['height'], 'desc': E(v.get('desc', '')), 'url': E(vurl(v, True)),
        'embed': E(embed_code(v)), 'downloads': downloads, 'more': more,
    }
    L.write_text(os.path.join(L.video_dir(v), 'index.html'),
                 page('%s · %s · MINT Library' % (v['title'], f['title']), v.get('desc') or v['title'],
                      vurl(v, True), body, image=image, video=video, og_type='video.other', player=True,
                      cls='video-page'))
    # The embed: the player alone, filling its frame.
    emb = '\n'.join([
        head('%s · MINT Library' % v['title'], v.get('desc') or v['title'], vurl(v, True), image, video,
             'video.other', css_links(True)),
        '<body class="embed">', '<main>', player_html(v, embed=True),
        '<h1 class="sr">%s</h1>' % E(v['title']), '</main>',
        '<script src="%s" defer></script>' % asset('player.js'), '</body>', '</html>', ''])
    L.write_text(os.path.join(L.SITE_ROOT, 'embed', v['slug'], 'index.html'), emb)


def build_all(data=None):
    os.umask(0o022)
    data = data or L.load()
    L.makedirs(L.SITE_ROOT)
    copy_assets()
    folders = {f['slug']: f for f in data['folders']}
    for v in data['videos']:
        if v['folder'] not in folders:
            folders[v['folder']] = {'slug': v['folder'], 'title': L.folder_title(v['folder']), 'order': 99}
            data['folders'].append(folders[v['folder']])
    build_home(data)
    for f in folders.values():
        build_folder(data, f)
    for v in data['videos']:
        build_video(data, folders[v['folder']], v)
    # Embeds of videos that are gone.
    emb_root = os.path.join(L.SITE_ROOT, 'embed')
    if os.path.isdir(emb_root):
        live = {v['slug'] for v in data['videos']}
        for name in os.listdir(emb_root):
            if name not in live and os.path.isdir(os.path.join(emb_root, name)):
                L.remove_tree(os.path.join(emb_root, name))
    print('built %d page(s) for %d video(s) in %d folder(s) -> %s' % (
        1 + len(folders) + 2 * len(data['videos']), len(data['videos']), len(folders), L.SITE_ROOT))


if __name__ == '__main__':
    build_all()
