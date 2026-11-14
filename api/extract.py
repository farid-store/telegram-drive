"""
api/extract.py — Ekstraktor berbasis yt-dlp (open source, 1000+ situs), Vercel Python function.
Dipanggil INTERNAL oleh /api/get (tidak dipanggil langsung oleh browser).

GET /api/extract?url=<video url>[&playlist=1]
  -> 200 {title, thumbnail, source, author, medias:[{url,type,extension,quality,size,ref}]}
     (type: video | audio | image | subtitle)
  -> 200 (playlist=1) {playlist:true, title, source, entries:[{title,url,thumbnail,duration}]}
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
import shutil
import time
import uuid
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


def bili_cookie_file():
    """Bilibili menolak (HTTP 412) permintaan tanpa cookie perangkat. Pakai cookies akun bila ada
    (BILI_COOKIES_B64), kalau tidak buat cookie perangkat anonim seperti yang dibuat browser."""
    text = ""
    b64 = os.environ.get("BILI_COOKIES_B64", "").strip()
    if b64:
        try:
            text = base64.b64decode(b64).decode("utf-8", "ignore")
        except Exception:
            text = ""
    if not text.strip():
        row = lambda n, v: "\t".join([".bilibili.com", "TRUE", "/", "FALSE", "2147483647", n, v])
        text = "# Netscape HTTP Cookie File\n" + row("buvid3", f"{uuid.uuid4()}infoc") + "\n" + row("b_nut", str(int(time.time()))) + "\n"
    path = "/tmp/bili_cookies.txt"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def js_runtime_opts():
    """YouTube kini butuh JS runtime (yt-dlp EJS) untuk membuka daftar format. Pakai binary QuickJS-ng
    di bin/qjs (ikut ter-deploy), disalin ke /tmp agar bisa dieksekusi."""
    here = os.path.dirname(os.path.abspath(__file__))
    src = next((p for p in (os.path.join(here, "..", "bin", "qjs"), "/var/task/bin/qjs") if os.path.isfile(p)), None)
    if not src:
        return {}
    dst = "/tmp/qjs"
    try:
        if not os.path.isfile(dst) or os.path.getsize(dst) != os.path.getsize(src):
            shutil.copyfile(src, dst)
        os.chmod(dst, 0o755)
    except Exception:
        return {}
    return {"js_runtimes": {"quickjs": {"path": dst}}}


def cookie_report():
    """Diagnosa singkat: apakah cookies terbaca & memuat tanda login (tanpa membocorkan nilainya)."""
    try:
        p = cookie_file()
        if not p:
            return "cookies: TIDAK terbaca — YTDLP_COOKIES_B64 kosong/belum aktif (pastikan sudah Redeploy dan variabelnya ada di environment Production)"
        names = set()
        for ln in open(p, encoding="utf-8", errors="ignore").read().splitlines():
            raw = ln[len("#HttpOnly_"):] if ln.startswith("#HttpOnly_") else ln
            if not raw.strip() or raw.startswith("#"):
                continue
            parts = raw.split("\t")
            if len(parts) >= 7:
                names.add(parts[5])
        login = names & {"SAPISID", "__Secure-3PSID", "__Secure-1PSID", "SID", "LOGIN_INFO"}
        state = "ada" if login else "TIDAK ADA (belum login saat ekspor?)"
        js = "quickjs siap" if js_runtime_opts() else "TIDAK ADA (file bin/qjs belum ter-deploy)"
        return f"cookies: {len(names)} terbaca, tanda login: {state}; JS runtime: {js}"
    except Exception as e:
        return f"cookies: gagal diperiksa ({str(e)[:60]})"


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


LANG_PREF = ["id", "en"]
SUB_EXT_PREF = ["srt", "vtt", "ttml"]


def pick_sub(fmts):
    by = {(f.get("ext") or "").lower(): f for f in fmts if f.get("url")}
    for e in SUB_EXT_PREF:
        if e in by:
            return by[e]
    return next(iter(by.values()), None)


def subtitle_medias(info):
    """Subtitle manual (maks 6 bahasa, id & en lebih dulu) + auto-caption hanya id/en."""
    out = []
    subs = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat" and v}
    auto = {k: v for k, v in (info.get("automatic_captions") or {}).items() if v}

    def order(k):
        base = k.split("-")[0].lower()
        return (0 if base in LANG_PREF else 1, LANG_PREF.index(base) if base in LANG_PREF else 99, k)

    for lang in sorted(subs, key=order)[:6]:
        f = pick_sub(subs[lang])
        if f:
            out.append({"url": f["url"], "type": "subtitle", "extension": (f.get("ext") or "vtt").lower(),
                        "quality": lang.upper(), "size": f.get("name"), "ref": ref_of(f)})
    for lang in LANG_PREF:
        if lang in subs:
            continue
        cand = auto.get(lang) or auto.get(lang + "-orig")
        f = pick_sub(cand) if cand else None
        if f:
            out.append({"url": f["url"], "type": "subtitle", "extension": (f.get("ext") or "vtt").lower(),
                        "quality": lang.upper() + " (auto)", "size": None, "ref": ref_of(f)})
    return out


def thumbnail_media(info):
    """Thumbnail resolusi tertinggi (utamakan jpg/png agar mudah dibuka)."""
    thumbs = [t for t in (info.get("thumbnails") or []) if t.get("url")]
    if not thumbs:
        return None

    def score(t):
        url = t["url"].lower().split("?")[0]
        fmt = 1 if url.endswith((".jpg", ".jpeg", ".png")) else 0
        return (fmt, (t.get("width") or 0) * (t.get("height") or 0), t.get("preference") or 0)

    best = max(thumbs, key=score)
    ext = best["url"].lower().split("?")[0].rsplit(".", 1)[-1]
    if ext not in IMG_EXT:
        ext = "jpg"
    w, h = best.get("width"), best.get("height")
    return {"url": best["url"], "type": "image", "extension": ext,
            "quality": "Thumbnail HD" + (f" {w}x{h}" if w and h else ""), "size": None, "ref": None}


def playlist_info(url):
    opts = {
        "quiet": True, "no_warnings": True, "skip_download": True,
        "extract_flat": "in_playlist", "playlistend": 25,
        "socket_timeout": 20, "cachedir": "/tmp/yt-dlp-cache", "retries": 2,
    }
    ck = cookie_file()
    if ck:
        opts["cookiefile"] = ck
    if os.environ.get("YTDLP_PROXY"):
        opts["proxy"] = os.environ["YTDLP_PROXY"]
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    entries = []
    for e in (info or {}).get("entries") or []:
        if not e:
            continue
        link = e.get("webpage_url") or e.get("url") or ""
        if not link.startswith("http"):
            if (e.get("ie_key") or "").lower() == "youtube" and e.get("id"):
                link = "https://www.youtube.com/watch?v=" + e["id"]
            else:
                continue
        thumbs = e.get("thumbnails") or []
        entries.append({"title": (e.get("title") or "Video")[:120], "url": link,
                        "thumbnail": e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else None),
                        "duration": e.get("duration")})
    if not entries:
        raise ValueError("playlist kosong / tidak didukung")
    return {"playlist": True, "title": (info.get("title") or "Playlist")[:150],
            "source": info.get("extractor_key") or info.get("extractor"), "entries": entries}


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
    opts.update(js_runtime_opts())
    has_cookies = False
    host = (urlparse(url).hostname or "").lower()
    is_bili = host == "b23.tv" or host.endswith(("bilibili.com", "bilibili.tv"))
    ck = bili_cookie_file() if is_bili else cookie_file()
    if ck:
        opts["cookiefile"] = ck
        has_cookies = True
    if os.environ.get("YTDLP_PROXY"):
        opts["proxy"] = os.environ["YTDLP_PROXY"]

    def run(o):
        with yt_dlp.YoutubeDL(o) as ydl:
            return ydl.extract_info(url, download=False)

    started = time.time()
    try:
        info = run(opts)
    except Exception as e:
        if not is_bot_check(e):
            raise
        # Bot-check YouTube sering hanya mengenai satu "klien". Coba klien lain pada IP yang sama.
        # (android_vr tidak mendukung cookies, jadi dipakai hanya saat tidak ada cookies.)
        alts = [["tv"], ["mweb"]] if has_cookies else [["android_vr", "tv"]]
        info = None
        for pc in alts:
            if time.time() - started > 25:
                break
            try:
                alt = dict(opts)
                alt["retries"] = 1
                alt["extractor_args"] = {"youtube": {"player_client": pc}}
                info = run(alt)
                break
            except Exception:
                continue
        if info is None:
            raise e

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

    if not info.get("entries"):
        has_av = any(m["type"] in ("video", "audio") for m in medias)
        if has_av:
            th = thumbnail_media(info)
            if th:
                medias.append(th)
            medias.extend(subtitle_medias(info))
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
    if "requested format is not available" in low or "only images are available" in low:
        return "no_formats", "YouTube tidak memberi daftar format video (bukan video privat). Biasanya karena yt-dlp belum punya JS runtime atau YouTube meminta PO token."
    if "412" in low and ("precondition" in low or "bilibili" in low):
        return "blocked", "Bilibili menolak IP server (HTTP 412). Isi BILI_COOKIES_B64 (cookies bilibili.com akun login) atau YTDLP_PROXY."
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
            if (qs.get("playlist") or [""])[0] == "1":
                return self._send(200, playlist_info(url))
            return self._send(200, extract(url))
        except Exception as e:  # yt_dlp.utils.DownloadError, ValueError, dll
            kind, msg = explain(e)
            if kind in ("bot_check", "login_required", "no_formats"):
                msg += " [" + cookie_report() + "]"
            elif kind == "blocked":
                msg += " [cookies Bilibili: " + ("akun login" if os.environ.get("BILI_COOKIES_B64") else "anonim") + "; proxy: " + ("ya" if os.environ.get("YTDLP_PROXY") else "tidak") + "]"
            return self._send(502, {"error": msg, "kind": kind})
