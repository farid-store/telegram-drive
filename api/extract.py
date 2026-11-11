"""
api/extract.py — Ekstraktor berbasis yt-dlp (open source, 1000+ situs), Vercel Python function.
Dipanggil INTERNAL oleh /api/get (tidak dipanggil langsung oleh browser).

GET /api/extract?url=<video url>
  -> 200 {title, thumbnail, source, author, medias:[{url,type,extension,quality,size,ref}]}
  -> 4xx/5xx {error, kind}

ENV (semua opsional):
  SIGN_SECRET        bila di-set, request harus membawa header x-internal-key yang sama
  YTDLP_COOKIES_B64  isi cookies.txt (format Netscape) di-encode base64 — untuk YouTube/Instagram yang minta login
  YTDLP_COOKIES      alternatif: isi cookies.txt mentah (hati-hati newline)
  YTDLP_PROXY        mis. http://user:pass@host:port — proxy residential bila IP Vercel diblok
"""
import base64
import json
import os
import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import yt_dlp

SECRET = os.environ.get("SIGN_SECRET", "")
IMG_EXT = {"jpg", "jpeg", "png", "webp", "gif"}
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def cookie_file():
    text = ""
    b64 = os.environ.get("YTDLP_COOKIES_B64", "").strip()
    if b64:
        try:
            text = base64.b64decode(b64).decode("utf-8", "ignore")
        except Exception:
            text = ""
    if not text:
        text = os.environ.get("YTDLP_COOKIES", "")
        if "\\n" in text and "\n" not in text:
            text = text.replace("\\n", "\n")
    if not text.strip():
        return None
    path = "/tmp/yt_cookies.txt"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def human(n):
    if not n:
        return ""
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return ""


def classify(f):
    """-> 'image' | 'prog' | 'vonly' | 'aonly' | 'hls' | None"""
    url = f.get("url")
    if not url:
        return None
    proto = (f.get("protocol") or "").lower()
    ext = (f.get("ext") or "").lower()
    if proto.startswith("m3u8"):
        return "hls"
    if proto not in ("https", "http", ""):
        return None  # dash fragments / rtmp / ism dst. — tidak bisa jadi satu file
    vc, ac = f.get("vcodec"), f.get("acodec")
    if ext in IMG_EXT and vc in (None, "none") and ac in (None, "none"):
        return "image"
    has_v = vc != "none"
    has_a = ac != "none"
    if has_v and has_a:
        return "prog"
    if has_v:
        return "vonly"
    if has_a:
        return "aonly"
    return None


def ref_of(f):
    h = f.get("http_headers") or {}
    return h.get("Referer") or h.get("referer")


def media(f, mtype, quality, size_note=""):
    size = human(f.get("filesize") or f.get("filesize_approx"))
    note = " · ".join(x for x in (size_note, size) if x)
    return {
        "url": f["url"],
        "type": mtype,
        "extension": (f.get("ext") or "").lower() or ("mp3" if mtype == "audio" else "mp4"),
        "quality": quality,
        "size": note or None,
        "ref": ref_of(f),
    }


def height_label(f):
    h = f.get("height")
    if h:
        fps = f.get("fps")
        return f"{h}p{int(fps)}" if fps and fps > 30 else f"{h}p"
    return f.get("format_note") or f.get("resolution") or "best"


def medias_from(info, tag=""):
    fmts = info.get("formats") or []
    if not fmts and info.get("url"):
        fmts = [info]
    groups = {"image": [], "prog": [], "vonly": [], "aonly": [], "hls": []}
    for f in fmts:
        c = classify(f)
        if c:
            groups[c].append(f)

    out = []
    sfx = f" {tag}" if tag else ""

    # Video + audio (siap pakai) — satu terbaik per resolusi/ext
    best = {}
    for f in groups["prog"]:
        key = (f.get("height") or 0, (f.get("ext") or "").lower())
        if key not in best or (f.get("tbr") or 0) > (best[key].get("tbr") or 0):
            best[key] = f
    prog = sorted(best.values(), key=lambda f: (f.get("height") or 0, f.get("tbr") or 0), reverse=True)[:6]
    for f in prog:
        out.append(media(f, "video", height_label(f) + sfx))
    top_prog_h = max([f.get("height") or 0 for f in prog], default=0)

    # Video-only resolusi lebih tinggi dari yang ada audionya (tanpa suara — diberi catatan)
    vbest = {}
    for f in groups["vonly"]:
        h = f.get("height") or 0
        if h <= top_prog_h:
            continue
        cur = vbest.get(h)
        better = (str(f.get("ext")) == "mp4", f.get("tbr") or 0) > (str(cur.get("ext")) == "mp4", cur.get("tbr") or 0) if cur else True
        if better:
            vbest[h] = f
    for h in sorted(vbest, reverse=True)[:3]:
        out.append(media(vbest[h], "video", height_label(vbest[h]) + sfx, "tanpa audio"))

    # Audio-only: m4a terbaik + format lain terbaik
    abest = {}
    for f in groups["aonly"]:
        ext = (f.get("ext") or "").lower()
        if ext not in abest or (f.get("abr") or f.get("tbr") or 0) > (abest[ext].get("abr") or abest[ext].get("tbr") or 0):
            abest[ext] = f
    for ext in sorted(abest, key=lambda e: e != "m4a")[:2]:
        f = abest[ext]
        abr = f.get("abr") or f.get("tbr")
        out.append(media(f, "audio", (f"{int(abr)}kbps" if abr else "audio") + sfx))

    for f in groups["image"][:1] if tag else groups["image"][:10]:
        out.append(media(f, "image", "Foto" + (sfx or "")))

    # Fallback: playlist HLS (hanya bila tidak ada format langsung)
    if not out and groups["hls"]:
        for f in sorted(groups["hls"], key=lambda f: f.get("height") or 0, reverse=True)[:3]:
            m = media(f, "video", height_label(f) + sfx)
            m["extension"] = "m3u8"
            out.append(m)
    return out


def is_bot_check(e):
    low = ANSI.sub("", str(e)).lower()
    return "confirm you" in low and "bot" in low


def extract(url):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "cachedir": "/tmp/yt-dlp-cache",
        "retries": 2,
    }
    has_cookies = False
    ck = cookie_file()
    if ck:
        opts["cookiefile"] = ck
        has_cookies = True
    if os.environ.get("YTDLP_PROXY"):
        opts["proxy"] = os.environ["YTDLP_PROXY"]

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        # YouTube bot check dari IP datacenter: coba sekali lagi dengan client alternatif
        # (android_vr kadang lolos tanpa login). Tidak ada jaminan — tergantung kebijakan YouTube saat ini.
        if not is_bot_check(e) or has_cookies:
            raise
        retry = dict(opts)
        retry["extractor_args"] = {"youtube": {"player_client": ["android_vr", "tv"]}}
        with yt_dlp.YoutubeDL(retry) as ydl:
            info = ydl.extract_info(url, download=False)

    if not info:
        raise ValueError("yt-dlp tidak mengembalikan data")

    medias = []
    if info.get("entries"):  # carousel / playlist (mis. postingan Instagram multi-slide)
        for i, e in enumerate([x for x in info["entries"] if x][:10], 1):
            medias.extend(medias_from(e, f"#{i}"))
    else:
        medias = medias_from(info)

    if not medias:
        raise ValueError("tidak ada format yang bisa diunduh langsung")

    first = info if not info.get("entries") else next((x for x in info["entries"] if x), {})
    return {
        "title": (info.get("title") or first.get("title") or "Video")[:150],
        "thumbnail": info.get("thumbnail") or first.get("thumbnail"),
        "source": info.get("extractor_key") or info.get("extractor"),
        "author": info.get("uploader") or info.get("channel") or first.get("uploader"),
        "duration": info.get("duration"),
        "medias": medias,
    }


def explain(msg):
    m = ANSI.sub("", str(msg)).replace("ERROR: ", "").strip()
    low = m.lower()
    if "confirm you" in low and "bot" in low:
        return "bot_check", "YouTube memblokir IP server (bot check). Perlu cookies (YTDLP_COOKIES_B64), proxy (YTDLP_PROXY), atau Cobalt."
    if "login" in low or "empty media response" in low or "rate-limit" in low or "cookies" in low:
        return "login_required", "Platform meminta login / membatasi IP server. Isi YTDLP_COOKIES_B64 (cookies akun) atau gunakan proxy."
    if "private" in low or "unavailable" in low or "not available" in low or "removed" in low:
        return "unavailable", "Video privat / dihapus / dibatasi wilayah. " + m[:160]
    if "unsupported url" in low:
        return "unsupported", "URL ini tidak didukung yt-dlp."
    return "error", m[:300]


class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if SECRET and self.headers.get("x-internal-key", "") != SECRET:
            return self._send(403, {"error": "forbidden", "kind": "forbidden"})
        qs = parse_qs(urlparse(self.path).query)
        url = (qs.get("url") or [""])[0]
        if not re.match(r"^https?://", url or ""):
            return self._send(400, {"error": "URL tidak valid", "kind": "bad_request"})
        try:
            return self._send(200, extract(url))
        except Exception as e:  # yt_dlp.utils.DownloadError, ValueError, dll
            kind, msg = explain(e)
            return self._send(502, {"error": msg, "kind": kind})
