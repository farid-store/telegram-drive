# VaultDL — Video Downloader Multi-Platform

Web downloader untuk video, audio, gambar, dan subtitle dari **1000+ situs**.
Berjalan penuh di **Vercel** (Node.js + Python), tanpa API pihak ketiga berbayar.
Mesin utama: **yt-dlp** (open source). Ada sistem iklan yang bisa dihidupkan/dimatikan dari panel admin tersembunyi.

> Dokumen ini berisi: fitur → arsitektur → struktur folder → **cara setup** → env var → panel admin & iklan → troubleshooting → batasan.

---

## 1. Fitur

### Download
- **Satu Link:** tempel URL → pilih format → download. Tab hasil: 🎬 Video, 🎵 Audio, 🖼 Gambar, 📝 Subtitle.
- **Multi Link & Playlist:** tempel hingga 15 link sekaligus (satu per baris). Link playlist (YouTube, SoundCloud, Bilibili, Vimeo showcase/album, Dailymotion, profil TikTok) otomatis diuraikan menjadi daftar video (maks. 30 item). Pilih preset kualitas (terbaik / 720p / 480p / audio saja), ganti per item, lalu **Download Semua**.
- **Subtitle & Thumbnail HD:** subtitle manual (maks. 6 bahasa, Indonesia & Inggris diutamakan) + auto-caption id/en; thumbnail resolusi tertinggi (jpg/png diutamakan).
- **Progress download:** file ≤ 150 MB di-stream dengan persen langsung di tombol (klik lagi untuk batal). File lebih besar: Chrome/Edge desktop menulis langsung ke disk; browser lain memakai download bawaan browser.
- **Pra-cek link:** sebelum download, server mengecek link valid; jika gagal tampil alasan jelas + saran cadangan (buka link asli, salin ke IDM).
- **Pemutar inline** (▶) untuk preview video/audio, dan tombol **salin link** untuk IDM/1DM.
- **Format cerdas:** video+audio ditampilkan dulu; resolusi tinggi tanpa suara (mis. YouTube 1080p/4K) diberi label *tanpa audio*; HLS/m3u8 hanya sebagai cadangan (disalin untuk VLC/yt-dlp).
- **Jalur khusus:** Terabox, Doodstream (termasuk embed), TikTok tanpa watermark (HD), Twitter/X, link share Facebook (`/share/…`, `fb.watch`) di-resolve otomatis.

### Stabilitas & keamanan
- **Rate limit per IP:** 40 request/menit (semua) dan 15 ekstraksi baru/menit per IP. Terlalu banyak → HTTP 429 + hitung mundur; Multi Link menunggu dan mengulang otomatis.
- **Cache hasil 8 menit** per URL (kunci = hash URL). "Coba Lagi" melewati cache.
- **Link download bertanda tangan** (`SIGN_SECRET`): `/api/dl` dan `/api/extract` tidak bisa dipakai orang luar sebagai proxy/ekstraktor gratis.
- **Proteksi SSRF** di proxy: localhost, IP privat, port non-standar, dan redirect berbahaya diblok.
- **Daftar blokir domain** (`BLOCKED_HOSTS`) untuk permintaan takedown → HTTP 451.
- **Pencatatan error:** log terstruktur di Vercel + statistik harian, hitungan per platform, dan 40 error terbaru di panel admin (tanpa menyimpan IP).

### Monetisasi
- **Slot iklan:** sidebar kiri & kanan (portrait), tengah (di bawah hasil), dan **pop-up** saat tombol Cari/Download ditekan (ada tombol tutup).
- **Admin tersembunyi** dengan password: saklar utama, per-slot (aktif, ukuran, mode, kode iklan), pengaturan pop-up, tombol tes, dan statistik.
- Dirancang tidak mengganggu — lihat bagian 6.

### Pengalaman pengguna
- **PWA:** bisa dipasang seperti aplikasi; di Android, menu **Bagikan** dari aplikasi lain langsung membuka VaultDL dan mencari link-nya.
- **Halaman kebijakan:** Syarat Penggunaan, Kebijakan Privasi, DMCA/Takedown.
- Riwayat pencarian (disimpan hanya di browser), drag & drop URL, paste otomatis.

---

## 2. Arsitektur

```
Browser ──► /api/get ──┬─► (Terabox / Doodstream / TikTok / Twitter khusus)
                       ├─► /api/extract  (Python + yt-dlp)   ← mesin utama
                       └─► Cobalt (opsional, COBALT_API_URL)
        ──► /api/dl       proxy streaming file (Edge Runtime, region sin1)
        ──► /api/analyze  metadata ringan (judul/thumbnail via oEmbed)
        ──► /api/config   konfigurasi iklan (publik, cache CDN 15 dtk)
        ──► /api/admin    login + simpan pengaturan + statistik (password di server)
                       
Upstash Redis (opsional tapi disarankan): rate limit, cache, pengaturan iklan, statistik
```

Browser **hanya** bicara ke domain-mu sendiri (tanpa CORS proxy publik).

---

## 3. Struktur folder

```
.
├── api/
│   ├── get.js          Orkestrator ekstraksi: rate limit, cache, provider, statistik
│   ├── extract.py      yt-dlp (video/audio/gambar/subtitle/thumbnail/playlist)
│   ├── dl.js           Proxy download streaming (Edge)
│   ├── analyze.js      Metadata ringan (oEmbed)
│   ├── config.js       Konfigurasi iklan publik
│   └── admin.js        Panel admin (login, simpan, statistik)
├── lib/
│   └── store.js        Redis REST (Upstash) + fallback memori
├── public/
│   ├── index.html      Seluruh antarmuka
│   ├── manifest.webmanifest   PWA + share target
│   ├── sw.js           Service worker
│   ├── icons/          icon-192, icon-512, maskable-512, apple-touch-icon
│   ├── terms.html  privacy.html  dmca.html
├── requirements.txt    yt-dlp
├── vercel.json         Region sin1 + durasi fungsi + header
├── .gitignore
└── README.md
```

> **Penting:** folder `api/` dan `lib/` harus di **root** project (sejajar `public/`), **bukan** di dalam `public/`. Folder `icons/` ada **di dalam** `public/`.

---

## 4. Setup (urutan yang disarankan)

### 4.1 Push ke GitHub
1. Ekstrak ZIP ini, masukkan semuanya ke repo (root repo = isi folder ini).
2. Commit & push. Pastikan `api/extract.py`, `requirements.txt`, `lib/`, dan `public/icons/` ikut ter-commit.

### 4.2 Hubungkan ke Vercel
1. Vercel → **Add New → Project** → pilih repo.
2. Framework Preset: **Other**. Tidak perlu Build Command / Output Directory (Vercel otomatis menyajikan `public/` dan menjalankan `api/`).
3. Deploy pertama boleh dilakukan dulu; env diisi setelahnya.

### 4.3 Buat Upstash Redis (untuk rate limit, cache, dan pengaturan iklan permanen)
1. Vercel → **Storage → Create → Upstash Redis**.
2. **Primary Region:** Singapore (fungsi berjalan di `sin1`). **Read Regions:** kosongkan. **Eviction:** biarkan mati. **Plan:** Free (500.000 perintah/bulan) cukup untuk mulai.
3. **Connect to Project:** pilih project-mu, centang **Production** (dan Preview bila dipakai), isi **Custom Prefix = `KV`**.
4. Hasil: env `KV_REST_API_URL` dan `KV_REST_API_TOKEN` otomatis ditambahkan. (Kode juga membaca `UPSTASH_REDIS_REST_*` dan prefix lain berakhiran `_REST_API_URL`/`_REST_API_TOKEN`.)

> Perkiraan pemakaian: ±5 perintah per pencarian yang kena cache dan ±10 untuk ekstraksi baru, jadi Free kira-kira cukup untuk 40–60 ribu pencarian/bulan (perkiraan kasar). Jika batas habis, rate limit & cache berhenti bekerja tetapi pencarian **tetap jalan**.

### 4.4 Isi Environment Variables
Vercel → Settings → **Environment Variables** (lihat tabel bagian 5). Minimal:

| Wajib/Disarankan | Nama | Isi |
|---|---|---|
| **Disarankan kuat** | `SIGN_SECRET` | String acak ≥ 32 karakter |
| **Disarankan kuat** | `ADMIN_PASSWORD` | Password admin panjang (bawaan `011204` terlalu lemah) |

### 4.5 Ganti email kontak
Ganti `kontak@domainmu.com` di `public/terms.html`, `public/privacy.html`, `public/dmca.html` dengan emailmu.

### 4.6 Redeploy
Env baru **hanya berlaku untuk deployment baru** → **Deployments → … → Redeploy** (Production).

### 4.7 Verifikasi
| Cek | Cara | Hasil yang benar |
|---|---|---|
| Situs hidup | Buka domain → coba satu link | Format muncul |
| Python aktif | Vercel → Deployment → tab **Functions** | `api/extract.py` terdaftar |
| `SIGN_SECRET` aktif | Buka `/api/dl?url=https://example.com/a.mp4&name=a.mp4` | `Signature tidak valid` |
| Redis terhubung | Buka panel admin | Tidak ada peringatan "Penyimpanan belum terhubung" |
| PWA | Buka `/icons/icon-192.png` dan `/manifest.webmanifest` | Gambar / JSON tampil |

---

## 5. Environment Variables (semua)

| Nama | Wajib? | Fungsi |
|---|---|---|
| `SIGN_SECRET` | Disarankan | Menandatangani link `/api/dl` & mengunci `/api/extract`. Bebas, string acak panjang. Mengganti nilainya membuat link lama tidak valid. |
| `ADMIN_PASSWORD` | Disarankan | Password panel admin. Jika kosong dipakai `011204` (panel akan menampilkan peringatan). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Disarankan | Kredensial Upstash Redis (terisi otomatis saat connect storage). |
| `RATE_LIMIT_PER_MIN` | Opsional | Batas semua request `/api/get` per IP per menit (default 40). |
| `RATE_LIMIT_MISS_PER_MIN` | Opsional | Batas ekstraksi baru per IP per menit (default 15). |
| `CACHE_TTL` | Opsional | Lama cache detik (default 480). Jangan terlalu lama: link media kedaluwarsa. |
| `BLOCKED_HOSTS` | Opsional | Domain diblok, pisah koma. Mis. `situs-a.com,situs-b.net`. Membalas 451. |
| `YTDLP_COOKIES_B64` | Opsional | `cookies.txt` (format Netscape) di-base64, untuk YouTube/Instagram yang minta login. Gunakan **akun cadangan**, bukan akun utama. |
| `YTDLP_COOKIES` | Opsional | Alternatif cookies mentah (rawan masalah baris baru). |
| `YTDLP_PROXY` | Opsional | Proxy (mis. residential) untuk yt-dlp: `http://user:pass@host:port`. |
| `COBALT_API_URL` / `COBALT_API_KEY` | Opsional | Instance Cobalt (open source) sebagai cadangan terakhir. |
| `TERABOX_API` | Opsional | Override endpoint worker Terabox. |

---

## 6. Iklan & Panel Admin

### Membuka admin
- **Klik logo 3 kali cepat**, atau tekan **Alt+Shift+A**.
- Password diverifikasi di server (`/api/admin`), tidak ada di kode frontend. Terkunci setelah 5 kali salah per 15 menit per IP (dan batas global per jam).
- Password hanya disimpan di memori tab selama sesi; "Keluar" menghapusnya.

### Menambah iklan
1. Daftarkan situs ke jaringan iklan pilihanmu, buat *ad unit* banner, salin kode HTML/JS-nya. **Catat ukurannya.**
2. Admin → tempel kode di slot yang sesuai:

| Slot | Ukuran yang cocok | Catatan |
|---|---|---|
| Sidebar kiri / kanan | 160×600 (juga 120×600, 300×600) | Tampil hanya di layar lebar |
| Tengah | 728×90 (juga 468×60, 320×100, 320×50, 300×250, 336×280) | Di bawah hasil; untuk HP pilih 320×100 / 300×250 |
| Pop-up | 300×250 (juga 336×280, 320×480, 300×600, 728×90, 250×250) | Muncul saat Cari/Download |

3. Pilih **Ukuran** yang sama dengan unit di jaringan iklan, pilih **Mode**, pastikan kotak slot dicentang, klik **💾 Simpan**. Pengunjung melihat perubahan dalam ±15 detik.
4. Gunakan **▶ Tes tampilan** untuk melihat pop-up.

### Mode iklan
- **Aman (iframe terisolasi)** — bawaan. Kode iklan berjalan di iframe ber-sandbox tanpa akses ke halaman ini dan tanpa hak menavigasi halaman utama. Cocok untuk kebanyakan jaringan banner.
- **Langsung** — kode dijalankan di halaman. Diperlukan oleh AdSense dan jaringan yang melarang iframe. Pakai hanya untuk jaringan tepercaya.

### Perilaku (agar tidak mengganggu)
- Sidebar hanya dimuat bila layar cukup lebar (kira-kira ≥ 1160 px lebar dan ≥ 710 px tinggi untuk unit 160×600) — tidak ada iklan tersembunyi yang tetap termuat.
- Slot tanpa kode iklan **tidak tampil** ke pengunjung. Kotak placeholder hanya terlihat olehmu selama panel admin terbuka.
- Pop-up **tidak pernah menunda** pencarian/download (berjalan paralel), punya jeda antar tampil (bawaan 90 detik), dan tombol tutup aktif setelah beberapa detik (bawaan 3; bisa 0). Dapat dibatasi hanya untuk Cari atau hanya Download.
- Saklar utama "Iklan aktif" mematikan seluruh iklan seketika.

### Peringatan keamanan
- Kode iklan yang kamu simpan dijalankan di halaman **semua pengunjung**. Jika password admin bocor, penyerang bisa menyuntik script. Karena itu: **ganti `ADMIN_PASSWORD`** dengan kata sandi panjang dan gunakan mode **Aman** bila memungkinkan.
- Tanpa Upstash, pengaturan iklan **tidak permanen** dan tidak dibagi antar instance — tombol on/off tidak bisa diandalkan.

### Soal jaringan iklan
Tidak semua jaringan menerima situs downloader dan aturan tiap jaringan berubah. Baca syarat sebelum mendaftar. Untuk AdSense dibutuhkan `public/ads.txt`. Hindari kode popunder/social bar di slot ini — slot dirancang untuk banner.

---

## 7. PWA & Share Target
- Chrome/Edge/Android menampilkan tombol **📲 Pasang** di bar atas setelah memenuhi syarat.
- Setelah terpasang di **Android**, pilih **Bagikan → VaultDL** dari aplikasi mana pun: link diambil dari teks yang dibagikan, parameter pelacak dibuang, pencarian jalan otomatis.
- iOS tidak mendukung share target; PWA tetap bisa ditambahkan ke layar utama.
- `/api/*` tidak pernah di-cache oleh service worker.

---

## 8. Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| "Endpoint /api/get tidak membalas JSON" | Folder `api/` salah tempat / belum deploy | Taruh di root repo, deploy ulang |
| `yt-dlp: HTTP 404 — /api/extract belum ter-deploy` | `requirements.txt`/`extract.py` tidak ikut | Commit keduanya, cek tab Functions |
| YouTube: "bot check" | Vercel diblok YouTube | Isi `YTDLP_COOKIES_B64`, `YTDLP_PROXY`, atau `COBALT_API_URL` |
| Instagram: perlu login | Platform membatasi IP server | `YTDLP_COOKIES_B64` (akun cadangan) |
| Download 403 / "terikat IP" | Link media terikat IP pengambil (umum di YouTube) | Pakai Cobalt; atau buka link asli di tab baru |
| "Signature tidak valid" saat memakai situs | `SIGN_SECRET` baru diganti | Cari ulang videonya |
| HTTP 429 | Rate limit | Tunggu hitung mundur |
| Iklan tidak muncul | Situs belum disetujui, ukuran tidak cocok, adblock, layar sempit (sidebar), atau slot kosong | Cek di incognito tanpa adblock; samakan ukuran |
| "Penyimpanan belum terhubung" di admin | Env Redis tidak terbaca | Cek nama env di Settings, pastikan redeploy Production |
| Fungsi timeout | Platform lambat | Coba lagi; turunkan `maxDuration` di `vercel.json` jika Vercel menolak nilainya untuk plan-mu |

---

## 9. Batasan (jujur)
- **Tidak ada solusi gratis yang menjamin YouTube/Instagram dari IP datacenter.** Platform lain umumnya aman. Cookies, proxy, atau Cobalt adalah jalan keluarnya.
- Link YouTube terikat IP pengambil; ekstraksi bisa berhasil tetapi download via proxy ditolak. Cobalt (mode tunnel) menyelesaikan ini.
- Video 1080p/4K YouTube berupa **video-only** (tanpa suara). Menggabungkannya butuh ffmpeg yang tidak tersedia di Vercel.
- HLS/m3u8 tidak bisa dijadikan satu file lewat proxy.
- Subtitle YouTube kadang gagal karena link terikat IP.
- Semua download lewat proxy → **bandwidth dihitung ke kuota Vercel-mu**. Pantau tab Usage.
- Pemakaian Upstash Free dibatasi 500.000 perintah/bulan.
- Cold start fungsi Python bisa beberapa detik.

---

## 10. Pemeliharaan
- **Redeploy rutin (±bulanan)** agar yt-dlp terbaru terpasang (platform sering berubah). Bisa diotomatisasi dengan Deploy Hook + cron GitHub Actions.
- Pantau **tab Statistik** di admin: platform yang sering gagal menandakan perlu pembaruan/cookies.
- Pantau Usage Vercel (bandwidth/fungsi) dan Upstash (jumlah perintah).

---

## 11. Catatan hukum & privasi
- VaultDL tidak menyimpan file; konten diteruskan dari platform asal. Pengguna bertanggung jawab atas hak cipta konten yang diunduh.
- Halaman `terms.html`, `privacy.html`, `dmca.html` adalah **templat umum, bukan nasihat hukum**. Baca ulang, sesuaikan, dan konsultasikan bila perlu — terutama bila kamu memasang iklan.
- Data yang diproses: URL (hanya untuk mengambil info; cache memakai hash), IP (sementara ±1 menit untuk rate limit), statistik agregat tanpa IP, riwayat di browser pengguna. Layanan pihak ketiga yang dapat menerima URL: FixTweet, TikWM, noembed/oEmbed, dan situs sumber.
