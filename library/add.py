#!/usr/bin/env python3
"""Add a video to the MINT Library (or remove one), then rebuild every page.

  python3 library/add.py --folder pre-read --title "Title" --desc "One paragraph." \
      [--date YYYY-MM-DD] [--captions file.vtt] [--poster img] [--slug my-slug] [--force] video.mp4
  python3 library/add.py --remove <slug>

What it makes in /var/www/library/<folder>/<slug>/:
  1080p.mp4 720p.mp4 480p.mp4  H.264 high + AAC, +faststart, 2 s keyframes (never upscaled;
                               the top one is the source height when that is below 1080)
  poster.jpg poster-640.jpg    from --poster, else a frame at 10 %
  thumbs.jpg thumbs.vtt        seek-preview sprite (<= 100 tiles) and its WebVTT map
  captions.en.vtt              when --captions is given
A repeat run with the same title (slug) updates that entry; the renditions are only re-encoded
when the source file changed or --force is given.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mintlib as L  # noqa: E402
import build  # noqa: E402

LADDER = [  # height, crf, maxrate, bufsize, audio bitrate
    (1080, 21, '6000k', '12000k', '160k'),
    (720, 22, '3500k', '7000k', '128k'),
    (480, 23, '1600k', '3200k', '128k'),
]


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr[-3000:])
        raise SystemExit('command failed: %s' % ' '.join(cmd[:6]))
    return p.stdout


def probe(path):
    out = run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
    info = json.loads(out)
    v = next((s for s in info['streams'] if s.get('codec_type') == 'video'), None)
    if not v:
        raise SystemExit('no video stream in %s' % path)
    a = next((s for s in info['streams'] if s.get('codec_type') == 'audio'), None)
    w, h = int(v['width']), int(v['height'])
    rot = 0
    for sd in v.get('side_data_list', []) or []:
        if 'rotation' in sd:
            rot = abs(int(sd['rotation'])) % 180
    if rot == 90:
        w, h = h, w
    return {'width': w, 'height': h, 'duration': float(info['format']['duration']),
            'bytes': int(info['format']['size']), 'has_audio': a is not None}


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def even(x):
    return int(round(x / 2.0)) * 2


def ladder_for(src_h):
    top = min(1080, src_h)
    rungs = []
    for h, crf, mr, bs, ab in LADDER:
        if h > top:
            continue
        rungs.append((h, crf, mr, bs, ab))
    if not rungs or rungs[0][0] != top:
        # Source below 1080 but not on a rung (e.g. 900): its own height first, with the 1080 settings.
        rungs.insert(0, (even(top),) + LADDER[0][1:])
    seen, out = set(), []
    for r in rungs:
        if r[0] not in seen:
            seen.add(r[0])
            out.append(r)
    return out


def encode(src, dst, h, crf, maxrate, bufsize, abr, has_audio):
    tmp = dst + '.part.mp4'
    cmd = ['ffmpeg', '-v', 'error', '-y', '-i', src, '-map', '0:v:0']
    if has_audio:
        cmd += ['-map', '0:a:0']
    cmd += ['-vf', 'scale=-2:%d:flags=lanczos,format=yuv420p' % h,
            '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', str(crf),
            '-maxrate', maxrate, '-bufsize', bufsize,
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0',
            '-movflags', '+faststart', '-map_metadata', '-1']
    if has_audio:
        cmd += ['-c:a', 'aac', '-b:a', abr, '-ac', '2', '-ar', '48000']
    cmd.append(tmp)
    print('  encoding %dp ...' % h, flush=True)
    run(cmd)
    os.chmod(tmp, 0o644)
    os.replace(tmp, dst)


def make_poster(src_img, video, dur, out_dir):
    big = os.path.join(out_dir, 'poster.jpg')
    small = os.path.join(out_dir, 'poster-640.jpg')
    if src_img:
        inp = ['-i', src_img]
    else:
        inp = ['-ss', '%.2f' % (dur * 0.1), '-i', video]
    run(['ffmpeg', '-v', 'error', '-y'] + inp + ['-frames:v', '1', '-vf', "scale='min(1280,iw)':-2:flags=lanczos",
                                                '-q:v', '3', big])
    run(['ffmpeg', '-v', 'error', '-y', '-i', big, '-vf', 'scale=640:-2:flags=lanczos', '-q:v', '4', small])
    for p in (big, small):
        os.chmod(p, 0o644)
    pi = probe_image(big)
    return {'file': 'poster.jpg', 'small': 'poster-640.jpg', 'width': pi[0], 'height': pi[1]}


def probe_image(path):
    out = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
               '-of', 'csv=p=0', path])
    w, h = out.strip().split(',')[:2]
    return int(w), int(h)


def vtt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return '%02d:%02d:%02d.%03d' % (h, m, s, ms)


def make_sprite(video, dur, w, h, out_dir):
    interval = max(2, int(math.ceil(dur / 100.0)))
    count = max(1, int(math.ceil(dur / interval)))
    tw = 160
    th = even(tw * h / float(w))
    cols = min(10, count)
    rows = int(math.ceil(count / float(cols)))
    jpg = os.path.join(out_dir, 'thumbs.jpg')
    run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-vf',
         'fps=1/%d:round=down,scale=%d:%d:flags=lanczos,tile=%dx%d' % (interval, tw, th, cols, rows),
         '-frames:v', '1', '-q:v', '5', jpg])
    os.chmod(jpg, 0o644)
    lines = ['WEBVTT', '']
    for i in range(count):
        t0, t1 = i * interval, min((i + 1) * interval, dur)
        x, y = (i % cols) * tw, (i // cols) * th
        lines += ['%s --> %s' % (vtt_time(t0), vtt_time(t1)), 'thumbs.jpg#xywh=%d,%d,%d,%d' % (x, y, tw, th), '']
    L.write_text(os.path.join(out_dir, 'thumbs.vtt'), '\n'.join(lines))
    return {'file': 'thumbs.jpg', 'vtt': 'thumbs.vtt', 'interval': interval, 'width': tw, 'height': th}


def add(args):
    src = os.path.abspath(args.video)
    if not os.path.isfile(src):
        raise SystemExit('no such file: %s' % src)
    folder = args.folder
    if not L.SLUG_RE.match(folder):
        raise SystemExit('folder must be a slug like pre-read')
    slug = args.slug or L.slugify(args.title)
    if not L.SLUG_RE.match(slug) or slug == 'embed':
        raise SystemExit('bad slug: %s' % slug)
    if args.date:
        datetime.date.fromisoformat(args.date)
    data = L.load()
    if not any(f['slug'] == folder for f in data['folders']):
        data['folders'].append({'slug': folder, 'title': args.folder_title or L.folder_title(folder),
                                'order': len(data['folders']), 'desc': ''})
    elif args.folder_title:
        next(f for f in data['folders'] if f['slug'] == folder)['title'] = args.folder_title
    old = next((v for v in data['videos'] if v['slug'] == slug), None)
    if old and old['folder'] != folder:
        raise SystemExit('slug %s is already used in folder %s; pass --slug' % (slug, old['folder']))

    info = probe(src)
    digest = sha256(src)
    out_dir = os.path.join(L.SITE_ROOT, folder, slug)
    L.makedirs(out_dir)
    print('%s -> %s (%dx%d, %.1f s)' % (os.path.basename(src), out_dir, info['width'], info['height'],
                                         info['duration']))

    same_source = bool(old and old.get('source', {}).get('sha256') == digest)
    renditions = []
    for h, crf, mr, bs, ab in ladder_for(info['height']):
        dst = os.path.join(out_dir, '%dp.mp4' % h)
        if not (same_source and not args.force and os.path.exists(dst)):
            encode(src, dst, h, crf, mr, bs, ab, info['has_audio'])
        else:
            print('  %dp unchanged' % h)
        ri = probe(dst)
        renditions.append({'height': ri['height'], 'width': ri['width'], 'file': '%dp.mp4' % h,
                           'bytes': os.path.getsize(dst), 'bitrate': int(ri['bytes'] * 8 / ri['duration'])})
    # Renditions of an older, taller source that no longer belong.
    keep = {r['file'] for r in renditions}
    for name in os.listdir(out_dir):
        if name.endswith('p.mp4') and name not in keep:
            os.remove(os.path.join(out_dir, name))

    top = os.path.join(out_dir, renditions[0]['file'])
    duration = probe(top)['duration']
    poster = make_poster(os.path.abspath(args.poster) if args.poster else None, top, duration, out_dir)
    sprite = make_sprite(top, duration, renditions[0]['width'], renditions[0]['height'], out_dir)

    captions = []
    if args.captions:
        with open(args.captions, encoding='utf-8-sig') as f:
            text = f.read()
        if not text.lstrip().startswith('WEBVTT'):
            raise SystemExit('captions must be a WebVTT file')
        name = 'captions.%s.vtt' % args.captions_lang
        L.write_text(os.path.join(out_dir, name), text)
        captions.append({'file': name, 'lang': args.captions_lang, 'label': args.captions_label})
    elif old and not args.drop_captions:
        captions = [c for c in old.get('captions', []) if os.path.exists(os.path.join(out_dir, c['file']))]

    entry = {
        'slug': slug, 'folder': folder, 'title': args.title, 'desc': args.desc or '',
        'date': args.date or (old or {}).get('date') or datetime.date.today().isoformat(),
        'added': (old or {}).get('added') or L.now_iso(), 'updated': L.now_iso(),
        'duration': round(duration, 3), 'width': renditions[0]['width'], 'height': renditions[0]['height'],
        'renditions': renditions, 'poster': poster, 'sprite': sprite, 'captions': captions,
        'source': {'name': os.path.basename(src), 'bytes': info['bytes'], 'sha256': digest},
    }
    data['videos'] = [v for v in data['videos'] if v['slug'] != slug] + [entry]
    L.save(data)
    build.build_all(data)
    print('done: %s/%s/%s/' % (L.BASE_URL, folder, slug))
    for r in renditions:
        print('  %4dp  %dx%d  %.1f MB  %.2f Mbit/s' % (r['height'], r['width'], r['height'], r['bytes'] / 1e6,
                                                     r['bitrate'] / 1e6))


def remove(slug):
    data = L.load()
    v = next((v for v in data['videos'] if v['slug'] == slug), None)
    if not v:
        raise SystemExit('no video with slug %s' % slug)
    L.remove_tree(L.video_dir(v))
    L.remove_tree(os.path.join(L.SITE_ROOT, 'embed', slug))
    data['videos'] = [x for x in data['videos'] if x['slug'] != slug]
    L.save(data)
    build.build_all(data)
    print('removed %s' % slug)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video', nargs='?')
    ap.add_argument('--folder', default='pre-read')
    ap.add_argument('--folder-title')
    ap.add_argument('--title')
    ap.add_argument('--desc', default='')
    ap.add_argument('--date', help='YYYY-MM-DD, the date shown and sorted on (default: today)')
    ap.add_argument('--captions', help='a WebVTT file')
    ap.add_argument('--captions-lang', default='en')
    ap.add_argument('--captions-label', default='English')
    ap.add_argument('--drop-captions', action='store_true', help='on a repeat run, remove existing captions')
    ap.add_argument('--poster')
    ap.add_argument('--slug')
    ap.add_argument('--force', action='store_true', help='re-encode even when the source is unchanged')
    ap.add_argument('--remove', metavar='SLUG')
    args = ap.parse_args()
    os.umask(0o022)
    if args.remove:
        return remove(args.remove)
    if not args.video or not args.title:
        ap.error('a video and --title are required')
    if shutil.which('ffmpeg') is None or shutil.which('ffprobe') is None:
        raise SystemExit('ffmpeg and ffprobe are needed')
    add(args)


if __name__ == '__main__':
    main()
