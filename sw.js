// ================================================================
// sw.js – Service Worker
// ================================================================

// ═══════════════════════════════════════════════════════════════
// ⚠️⚠️⚠️ CHANGE HERE: Apps Script URL (उही) ⚠️⚠️⚠️
// ═══════════════════════════════════════════════════════════════
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxnaLHwDYVVIcQmGZklgLLnI2VETzhI89RRfwPhJPNzmE5pQRuh3s1U72V0YDIuqj9TLw/exec';

self.addEventListener('install', function(event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('sync', function(event) {
  if (event.tag === 'photo-sync') {
    event.waitUntil(handleSync());
  }
});

async function handleSync() {
  try {
    if (!GAS_URL || GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE') {
      console.error('[SW] ❌ GAS_URL not set');
      return;
    }

    var db = await openDB();
    var queue = await getAllPending(db);

    if (queue.length === 0) return;

    console.log('[SW] 📤 Syncing ' + queue.length + ' photos...');

    for (var i = 0; i < queue.length; i++) {
      var entry = queue[i];
      try {
        var payload = {
          action: 'upload',
          photoId: entry.photoId,
          image: entry.image,
          mimeType: entry.mimeType || 'image/png',
          fileName: entry.fileName,
          createdAt: entry.createdAt || new Date().toISOString()
        };

        // ✅ CORS Fix: Use text/plain to avoid preflight
        var resp = await fetch(GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }

        var result = await resp.json();
        if (result.success) {
          await removeFromQueue(db, entry.photoId);
          console.log('[SW] ✅ Uploaded:', entry.fileName);
        } else {
          throw new Error('Upload failed: ' + JSON.stringify(result));
        }
      } catch (err) {
        console.warn('[SW] ⏳ Retry later:', entry.fileName, err.message);
        throw err;
      }
    }
  } catch (error) {
    console.warn('[SW] Sync error:', error);
    throw error;
  }
}

// ---------- IndexedDB (Version 2) ----------
function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('PhotoQueueDB', 2);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (db.objectStoreNames.contains('queue')) {
        db.deleteObjectStore('queue');
      }
      db.createObjectStore('queue', { keyPath: 'photoId' });
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}

function getAllPending(db) {
  return new Promise(function(resolve, reject) {
    var tx = db.transaction('queue', 'readonly');
    var store = tx.objectStore('queue');
    var all = store.getAll();
    all.onsuccess = function() { resolve(all.result); };
    all.onerror = function() { reject(all.error); };
  });
}

function removeFromQueue(db, photoId) {
  return new Promise(function(resolve, reject) {
    var tx = db.transaction('queue', 'readwrite');
    var store = tx.objectStore('queue');
    store.delete(photoId);
    tx.oncomplete = function() { resolve(); };
    tx.onerror = function() { reject(tx.error); };
  });
}