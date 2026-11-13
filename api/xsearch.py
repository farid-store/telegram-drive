# api/xsearch.py — pencarian SoundCloud (yt-dlp scsearch) & Bilibili (API pencarian publik).
# Dipanggil HANYA oleh /api/search (server → server) dengan header x-internal-key = SIGN_SECRET.
# Pakai requirements.txt yang sama dengan extract.py (yt-dlp). Env opsional: YTDLP_PROXY.
import json, os, re, html, uuid
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode

PER_PAGE = 20
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'


def fmt_dur(s):
    try:
        s = int(float(s))
    except (TypeError, ValueError):
        return ''
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f'{h}:{m:02d}:{sec:02d}' if h else f'{m}:{sec:02d}'


def fmt_views(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ''
    return f'{n:,}'.replace(',', '.') + ' x'


def soundcloud(q, page):
    import yt_dlp
    opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True, 'skip_download': True, 'socket_timeout': 12}
    if os.environ.get('YTDLP_PROXY'):
        opts['proxy'] = os.environ['YTDLP_PROXY']
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f'scsearch{PER_PAGE * page}:{q}', download=False)
    items = []
    for e in (info.get('entries') or [])[PER_PAGE * (page - 1):]:
        if not e:
            continue
        url = e.get('webpage_url') or e.get('url') or ''
        if not url.startswith('http'):
            continue
        th = e.get('thumbnail') or ((e.get('thumbnails') or [{}])[-1].get('url') or '')
        items.append({'id': str(e.get('id') or url), 'url': url, 'title': e.get('title') or url,
                      'channel': e.get('uploader') or '', 'dur': fmt_dur(e.get('duration')),
                      'views': fmt_views(e.get('view_count')), 'thumb': th})
    return items


def bilibili(q, page):
    import urllib.request
    qs = urlencode({'search_type': 'video', 'keyword': q, 'page': page, 'highlight': 0})
    req = urllib.request.Request('https://api.bilibili.com/x/web-interface/search/type?' + qs, headers={
        'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Cookie': f'buvid3={uuid.uuid4()}infoc'})
    with urllib.request.urlopen(req, timeout=12) as r:
        d = json.loads(r.read().decode('utf-8', 'replace'))
    items = []
    for v in ((d.get('data') or {}).get('result') or []):
        bv = v.get('bvid')
        url = f'https://www.bilibili.com/video/{bv}' if bv else (v.get('arcurl') or '')
        if not url:
            continue
        pic = v.get('pic') or ''
        if pic.startswith('//'):
            pic = 'https:' + pic
        items.append({'id': str(bv or v.get('aid') or url), 'url': url,
                      'title': html.unescape(re.sub(r'<[^>]+>', '', v.get('title') or '')) or url,
                      'channel': v.get('author') or '', 'dur': str(v.get('duration') or ''),
                      'views': fmt_views(v.get('play')), 'thumb': pic})
    return items


def run(path, headers):
    secret = os.environ.get('SIGN_SECRET', '')
    if secret and headers.get('x-internal-key') != secret:
        return 403, {'error': 'forbidden'}
    qs = parse_qs(urlparse(path).query)
    q = (qs.get('q', [''])[0] or '').strip()[:120]
    p = qs.get('p', [''])[0]
    try:
        page = min(3, max(1, int(qs.get('page', ['1'])[0])))
    except ValueError:
        page = 1
    if not q or p not in ('sc', 'bili'):
        return 400, {'error': 'parameter q/p tidak valid'}
    try:
        return 200, {'items': (soundcloud if p == 'sc' else bilibili)(q, page)}
    except Exception as e:  # jaringan diblokir, situs berubah, dll.
        return 502, {'error': str(e)[:200]}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code, obj = run(self.path, {k.lower(): v for k, v in self.headers.items()})
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('cache-control', 'no-store')
        self.end_headers()
        self.wfile.write(body)
