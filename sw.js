// ================================================================
// sw.js – Service Worker (Parallel Upload)
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

    console.log('[SW] 📤 Syncing ' + queue.length + ' photos (Parallel)...');

    // Parallel compressed uploads
    var compressedPromises = queue.map(function(entry) {
      return uploadPhoto(entry, 'compressed');
    });

    var compressedResults = await Promise.all(compressedPromises);

    // Parallel original uploads for successful compressed ones
    var originalPromises = [];
    var toRemove = [];
    for (var i = 0; i < queue.length; i++) {
      if (compressedResults[i]) {
        originalPromises.push(uploadPhoto(queue[i], 'original'));
      }
    }

    var originalResults = await Promise.all(originalPromises);

    // Remove completed entries
    var idx = 0;
    for (var j = 0; j < queue.length; j++) {
      if (compressedResults[j] && originalResults[idx]) {
        await removeFromQueue(db, queue[j].photoId);
        console.log('[SW] ✅ Both uploaded:', queue[j].fileName);
        idx++;
      }
    }

  } catch (error) {
    console.warn('[SW] Sync error:', error);
    throw error;
  }
}

async function uploadPhoto(entry, type) {
  try {
    var payload = {
      action: type === 'compressed' ? 'upload_compressed' : 'upload_original',
      photoId: entry.photoId,
      image: type === 'compressed' ? entry.compressed : entry.original,
      fileName: type === 'compressed' ? entry.compressedFileName : entry.fileName,
      createdAt: entry.createdAt || new Date().toISOString()
    };

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
      return true;
    } else {
      throw new Error('Upload failed: ' + JSON.stringify(result));
    }
  } catch (err) {
    console.warn('[SW] ⏳ ' + type + ' failed:', entry.fileName, err.message);
    return false;
  }
}

// ---------- IndexedDB ----------
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