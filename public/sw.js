// ==========================================
// SERVICE WORKER - MERGED CONFIGURATION
// ==========================================

// Konfigurasi domain pertama
self.options = {
    domain: "5gvci.com",
    zoneId: 12245385
};

self.lary = "";

// Load service worker pertama
importScripts(
    "https://5gvci.com/act/files/service-worker.min.js?r=sw"
);

// Konfigurasi domain kedua
// Catatan: self.options dapat ditimpa oleh script kedua.
importScripts(
    "https://3nbf4.com/act/files/service-worker.min.js?r=sw"
);


// ==========================================
// PWA CACHE CONFIGURATION
// ==========================================

const V = "vdl-v2";

const SHELL = [
    "/",
    "/manifest.webmanifest",
    "/icons/icon-192.png"
];


// ==========================================
// INSTALL
// ==========================================

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(V)
            .then(cache => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});


// ==========================================
// ACTIVATE
// ==========================================

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys =>
                Promise.all(
                    keys
                        .filter(key => key !== V)
                        .map(key => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});


// ==========================================
// FETCH
// ==========================================

self.addEventListener("fetch", event => {

    const request = event.request;

    if (request.method !== "GET") return;

    const url = new URL(request.url);

    // Jangan cache domain eksternal dan API
    if (
        url.origin !== location.origin ||
        url.pathname.startsWith("/api/")
    ) return;


    // NAVIGATION: NETWORK FIRST
    if (request.mode === "navigate") {

        const key = url.origin + url.pathname;

        event.respondWith(
            fetch(request)
                .then(response => {

                    if (response.ok) {
                        const copy = response.clone();

                        caches.open(V).then(cache =>
                            cache.put(key, copy)
                        );
                    }

                    return response;
                })
                .catch(() =>
                    caches.match(key)
                        .then(hit => hit || caches.match("/"))
                )
        );

        return;
    }


    // STATIC ASSETS: CACHE FIRST
    event.respondWith(
        caches.match(request)
            .then(hit =>
                hit || fetch(request).then(response => {

                    if (response.ok) {
                        const copy = response.clone();

                        caches.open(V).then(cache =>
                            cache.put(request, copy)
                        );
                    }

                    return response;
                })
            )
    );

});
