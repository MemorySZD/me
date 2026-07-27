// ================================================================
// app.js – Pro Camera PWA
// यो Apps Script (Code.gs) सँग मिल्ने गरी बनाइएको छ
// ================================================================

(function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // 🔧 CHANGE HERE: आफ्नो Google Apps Script Web App URL राख्नुहोस्
  // ═══════════════════════════════════════════════════════════════
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbxnaLHwDYVVIcQmGZklgLLnI2VETzhI89RRfwPhJPNzmE5pQRuh3s1U72V0YDIuqj9TLw/exec';

  // ---------- DOM Refs ----------
  var permOverlay = document.getElementById('permission-overlay');
  var permError = document.getElementById('perm-error');
  var topBar = document.getElementById('top-bar');
  var camContainer = document.getElementById('camera-container');
  var zoomArea = document.getElementById('zoom-area');
  var bottomBar = document.getElementById('bottom-bar');

  var video = document.getElementById('video');
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d');
  var flyImg = document.getElementById('fly-img');
  var galleryImg = document.getElementById('galleryImg');
  var statusDot = document.getElementById('statusDot');
  var gridOverlay = document.getElementById('grid-overlay');
  var flashOverlay = document.getElementById('flash-overlay');
  var countdownDisplay = document.getElementById('countdown-display');
  var zoomIndicator = document.getElementById('zoom-indicator');
  var zoomSlider = document.getElementById('zoomSlider');
  var zoomValue = document.getElementById('zoom-value');
  var gridBtn = document.getElementById('gridBtn');
  var timerBtn = document.getElementById('timerBtn');
  var flashBtn = document.getElementById('flashBtn');
  var flipBtn = document.getElementById('flipBtn');
  var effectsBtn = document.getElementById('effectsBtn');
  var aspectBtn = document.getElementById('aspectBtn');
  var aspectLabel = document.getElementById('aspectLabel');
  var effectsDropdown = document.getElementById('effectsDropdown');
  var aspectDropdown = document.getElementById('aspectDropdown');
  var captureBtn = document.getElementById('capture-btn');
  var galleryThumb = document.getElementById('gallery-thumb');

  // ---------- State ----------
  var stream = null;
  var facingMode = 'environment';
  var currentEffect = 'none';
  var currentAspect = '16:9';
  var zoomMax = 10;
  var isTorchOn = false;
  var isGridOn = false;
  var timerSeconds = 0;
  var isCountingDown = false;
  var lastPhotoData = null;
  var swRegistration = null;
  var isCameraReady = false;
  var photoQueue = []; // Offline queue

  // ---------- Utility: Generate Unique ID ----------
  function generatePhotoId() {
    return Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }

  // ---------- IndexedDB (Offline Queue) ----------
  function openDB() {
    return new Promise(function(res, rej) {
      var req = indexedDB.open('PhotoQueueDB', 1);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('queue')) {
          db.createObjectStore('queue', { keyPath: 'photoId' });
        }
      };
      req.onsuccess = function() { res(req.result); };
      req.onerror = function() { rej(req.error); };
    });
  }

  function addToQueue(entry) {
    return openDB().then(function(db) {
      return new Promise(function(res, rej) {
        var tx = db.transaction('queue', 'readwrite');
        tx.objectStore('queue').put(entry);
        tx.oncomplete = function() { res(); };
        tx.onerror = function() { rej(tx.error); };
      });
    });
  }

  function getAllPending() {
    return openDB().then(function(db) {
      return new Promise(function(res, rej) {
        var tx = db.transaction('queue', 'readonly');
        var all = tx.objectStore('queue').getAll();
        all.onsuccess = function() { res(all.result); };
        all.onerror = function() { rej(all.error); };
      });
    });
  }

  function removeFromQueue(photoId) {
    return openDB().then(function(db) {
      return new Promise(function(res, rej) {
        var tx = db.transaction('queue', 'readwrite');
        tx.objectStore('queue').delete(photoId);
        tx.oncomplete = function() { res(); };
        tx.onerror = function() { rej(tx.error); };
      });
    });
  }

  // ---------- Service Worker ----------
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(function(reg) {
          swRegistration = reg;
          console.log('[Camera] SW registered');
        })
        .catch(function(err) {
          console.warn('[Camera] SW reg failed:', err);
        });
    }
  }

  function triggerSync() {
    if (swRegistration && 'sync' in swRegistration) {
      swRegistration.sync.register('photo-sync').catch(function(err) {
        console.warn('[Camera] Sync trigger failed:', err);
      });
    }
  }

  // ---------- Upload to Google Apps Script ----------
  async function uploadPhoto(entry) {
    try {
      if (!GAS_URL || GAS_URL === 'https://script.google.com/macros/s/AKfycbxnaLHwDYVVIcQmGZklgLLnI2VETzhI89RRfwPhJPNzmE5pQRuh3s1U72V0YDIuqj9TLw/exec') {
        console.error('[Camera] ❌ GAS_URL is not set!');
        return false;
      }

      // Apps Script ले यी फिल्डहरू Expect गर्छ:
      // action: "upload", photoId, image (Base64), mimeType, fileName, createdAt
      var payload = {
        action: 'upload',
        photoId: entry.photoId,
        image: entry.image, // Already Base64
        mimeType: entry.mimeType || 'image/png',
        fileName: entry.fileName,
        createdAt: entry.createdAt || new Date().toISOString()
      };

      var resp = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        var errorText = await resp.text();
        console.error('[Camera] ❌ Server error:', resp.status, errorText);
        return false;
      }

      var result = await resp.json();
      if (result.success) {
        console.log('[Camera] ✅ Uploaded successfully:', entry.fileName);
        return true;
      } else {
        console.error('[Camera] ❌ Upload failed:', result.error);
        return false;
      }
    } catch (err) {
      console.error('[Camera] ❌ Upload error:', err);
      return false;
    }
  }

  // ---------- Process Queue ----------
  async function processQueue() {
    if (!navigator.onLine) {
      console.log('[Camera] 🔴 Offline, skipping queue');
      return;
    }

    try {
      var pending = await getAllPending();
      if (pending.length === 0) return;

      console.log('[Camera] 📤 Processing ' + pending.length + ' pending photos...');

      for (var i = 0; i < pending.length; i++) {
        var entry = pending[i];
        var success = await uploadPhoto(entry);
        if (success) {
          await removeFromQueue(entry.photoId);
        } else {
          console.warn('[Camera] ⏳ Retry later:', entry.fileName);
          // Exponential backoff
          var delay = Math.min(Math.pow(2, (entry.retryCount || 0)), 60) * 1000;
          entry.retryCount = (entry.retryCount || 0) + 1;
          entry.lastAttempt = Date.now();
          await addToQueue(entry);
          setTimeout(function() {
            if (navigator.onLine) processQueue();
          }, delay);
          break;
        }
      }
    } catch (e) {
      console.error('[Camera] ❌ Queue processing error:', e);
    }
  }

  // ---------- Capture ----------
  async function capturePhoto() {
    if (isCountingDown || !isCameraReady) return;

    // Timer countdown
    if (timerSeconds > 0) {
      isCountingDown = true;
      var count = timerSeconds;
      countdownDisplay.textContent = count;
      countdownDisplay.className = 'show';
      await new Promise(function(r) { setTimeout(r, 300); });
      while (count > 0) {
        countdownDisplay.textContent = count;
        await new Promise(function(r) { setTimeout(r, 900); });
        count--;
        if (count > 0) countdownDisplay.textContent = count;
      }
      countdownDisplay.className = '';
      isCountingDown = false;
      flashScreen();
    } else {
      flashScreen();
    }

    // Capture from video
    var vw = video.videoWidth || 1280;
    var vh = video.videoHeight || 720;
    canvas.width = vw;
    canvas.height = vh;

    // Apply effect
    ctx.filter = getFilterCSS(currentEffect);
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.filter = 'none';

    // Get image as PNG (original quality)
    var imageData = canvas.toDataURL('image/png');
    var timestamp = Date.now();
    var photoId = generatePhotoId();
    var fileName = 'PHOTO_' + new Date().toISOString().replace(/[:.]/g, '') + '_' + photoId + '.png';

    // Show in gallery (fly animation)
    var img = new Image();
    img.onload = function() { flyToGallery(img); };
    img.src = imageData;

    lastPhotoData = { image: imageData, fileName: fileName, photoId: photoId };
    galleryImg.src = imageData;
    galleryImg.style.display = 'block';

    // Save to IndexedDB queue
    var entry = {
      photoId: photoId,
      image: imageData,
      mimeType: 'image/png',
      fileName: fileName,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      lastAttempt: null
    };
    await addToQueue(entry);
    console.log('[Camera] ✅ Photo saved to queue:', fileName);

    // Try upload immediately if online
    if (navigator.onLine) {
      processQueue();
    } else {
      triggerSync();
    }
  }

  // ---------- Flash ----------
  function flashScreen() {
    flashOverlay.classList.add('active');
    setTimeout(function() {
      flashOverlay.classList.remove('active');
    }, 150);
  }

  // ---------- Effects ----------
  function getFilterCSS(effect) {
    switch (effect) {
      case 'sepia': return 'sepia(1)';
      case 'grayscale': return 'grayscale(1)';
      case 'blur': return 'blur(3px)';
      case 'invert': return 'invert(1)';
      case 'brightness': return 'brightness(1.5)';
      case 'contrast': return 'contrast(2)';
      case 'hue': return 'hue-rotate(180deg)';
      case 'pixelated': return 'blur(2px) contrast(3)';
      default: return 'none';
    }
  }

  function applyEffect(effect) {
    currentEffect = effect;
    video.style.filter = getFilterCSS(effect);
  }

  // ---------- Fly Animation ----------
  function flyToGallery(imgElement) {
    var container = document.getElementById('camera-container');
    var thumb = document.getElementById('gallery-thumb');

    var cRect = container.getBoundingClientRect();
    var tRect = thumb.getBoundingClientRect();

    var startW = Math.min(cRect.width * 0.5, 200);
    var startH = startW * (imgElement.naturalHeight / imgElement.naturalWidth);

    var endW = tRect.width;
    var endH = tRect.height;

    flyImg.src = imgElement.src;
    flyImg.style.width = startW + 'px';
    flyImg.style.height = startH + 'px';
    flyImg.style.left = (cRect.left + (cRect.width - startW) / 2) + 'px';
    flyImg.style.top = (cRect.top + (cRect.height - startH) / 2) + 'px';
    flyImg.style.transform = 'scale(1) rotate(0deg)';
    flyImg.style.borderRadius = '16px';

    void flyImg.offsetWidth;
    flyImg.className = 'flying';
    flyImg.style.width = endW + 'px';
    flyImg.style.height = endH + 'px';
    flyImg.style.left = (tRect.left) + 'px';
    flyImg.style.top = (tRect.top) + 'px';
    flyImg.style.transform = 'scale(0.9) rotate(2deg)';
    flyImg.style.borderRadius = '8px';

    setTimeout(function() {
      flyImg.className = '';
      flyImg.style.display = 'none';
    }, 600);
  }

  // ---------- View Last Photo ----------
  function viewLastPhoto() {
    if (lastPhotoData) {
      var img = document.createElement('img');
      img.src = lastPhotoData.image;
      img.style.position = 'fixed';
      img.style.inset = '0';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      img.style.background = '#000';
      img.style.zIndex = '999';
      img.style.cursor = 'pointer';
      img.onclick = function() { img.remove(); };
      document.body.appendChild(img);
    }
  }

  // ---------- Camera ----------
  async function checkAndStart() {
    try {
      var permissionStatus = 'prompt';
      if (navigator.permissions && navigator.permissions.query) {
        var result = await navigator.permissions.query({ name: 'camera' });
        permissionStatus = result.state;
        result.onchange = function() {
          if (result.state === 'granted') initCamera();
        };
      }

      if (permissionStatus === 'denied') {
        permError.textContent = '⚠️ क्यामेरा अनुमति ब्लक गरिएको छ। Settings बाट Allow गर्नुहोस्।';
        permError.style.display = 'block';
        return;
      }

      await initCamera();

    } catch (err) {
      permError.textContent = '❌ क्यामेरा खोल्न सकिएन: ' + err.message;
      permError.style.display = 'block';
      console.error('[Camera] Error:', err);
    }
  }

  async function initCamera() {
    var constraints = {
      audio: false,
      video: {
        facingMode: facingMode,
        width: { ideal: 9999 },
        height: { ideal: 9999 }
      }
    };
    if (currentAspect !== 'free') {
      var parts = currentAspect.split(':');
      if (parts.length === 2) {
        var w = parseFloat(parts[0]);
        var h = parseFloat(parts[1]);
        if (w > 0 && h > 0) constraints.video.aspectRatio = w / h;
      }
    }

    if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    var track = stream.getVideoTracks()[0];
    var cap = track.getCapabilities();

    if (cap.zoom && cap.zoom.max) {
      zoomMax = cap.zoom.max;
      zoomSlider.max = zoomMax;
    } else {
      zoomMax = 5;
      zoomSlider.max = 5;
    }
    zoomSlider.value = 1;
    applyZoom(1);

    if (cap.torch) {
      flashBtn.style.display = 'inline-flex';
    } else {
      flashBtn.style.display = 'inline-flex';
    }

    if (cap.focusModes && cap.focusModes.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }

    video.onclick = async function(e) {
      if (!track || !cap.focusModes) return;
      var rect = video.getBoundingClientRect();
      var x = (e.clientX - rect.left) / rect.width;
      var y = (e.clientY - rect.top) / rect.height;
      if (cap.focusModes.includes('manual') || cap.focusModes.includes('single-shot')) {
        try {
          await track.applyConstraints({
            advanced: [{ focusMode: 'manual', focusDistance: 0.5 }]
          });
          setTimeout(function() {
            if (stream) {
              var t = stream.getVideoTracks()[0];
              if (t) t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
                .catch(function() {});
            }
          }, 3000);
        } catch (err) { /* ignore */ }
      }
    };

    setOnline(navigator.onLine);

    permOverlay.classList.add('hidden');
    topBar.style.display = 'flex';
    camContainer.style.display = 'block';
    zoomArea.style.display = 'block';
    bottomBar.style.display = 'flex';

    isCameraReady = true;
    processQueue();
    registerSW();
  }

  // ---------- Zoom ----------
  function applyZoom(val) {
    var track = stream?.getVideoTracks()[0];
    val = Math.min(Math.max(val, 1), zoomMax);
    if (track && track.getCapabilities().zoom) {
      track.applyConstraints({ advanced: [{ zoom: val }] }).catch(function() {});
    } else {
      video.style.transform = 'scale(' + val + ')';
      video.style.transformOrigin = 'center center';
    }
    zoomSlider.value = val;
    zoomValue.textContent = val.toFixed(1) + 'x';
    zoomIndicator.textContent = val.toFixed(1) + 'x';
    zoomIndicator.classList.add('show');
    clearTimeout(window.zoomTimeout);
    window.zoomTimeout = setTimeout(function() {
      zoomIndicator.classList.remove('show');
    }, 1500);
  }

  var lastPinchDist = 0;
  var initialZoomVal = 1;

  function getPinchDist(e) {
    if (e.touches.length < 2) return 0;
    var t1 = e.touches[0];
    var t2 = e.touches[1];
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }

  document.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2 && isCameraReady) {
      lastPinchDist = getPinchDist(e);
      initialZoomVal = parseFloat(zoomSlider.value);
    }
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (e.touches.length === 2 && isCameraReady) {
      var dist = getPinchDist(e);
      if (lastPinchDist > 0) {
        var scale = dist / lastPinchDist;
        var newVal = initialZoomVal * scale;
        newVal = Math.min(Math.max(newVal, 1), zoomMax);
        applyZoom(newVal);
      }
    }
  }, { passive: true });

  document.addEventListener('touchend', function() {
    lastPinchDist = 0;
  }, { passive: true });

  zoomSlider.addEventListener('input', function() {
    applyZoom(parseFloat(this.value));
  });

  // ---------- Online Status ----------
  function setOnline(online) {
    statusDot.className = 'status-dot ' + (online ? 'online' : 'offline');
    if (online) {
      setTimeout(processQueue, 1000);
    }
  }
  window.addEventListener('online', function() { setOnline(true); });
  window.addEventListener('offline', function() { setOnline(false); });

  // ---------- UI Events ----------
  gridBtn.addEventListener('click', function() {
    isGridOn = !isGridOn;
    gridOverlay.classList.toggle('show', isGridOn);
    gridBtn.classList.toggle('active', isGridOn);
  });

  var timerOptions = [0, 3, 5, 10];
  var timerIndex = 0;
  timerBtn.addEventListener('click', function() {
    timerIndex = (timerIndex + 1) % timerOptions.length;
    timerSeconds = timerOptions[timerIndex];
    timerBtn.textContent = '⏱️ ' + (timerSeconds === 0 ? '0s' : timerSeconds + 's');
    timerBtn.classList.toggle('timer-active', timerSeconds > 0);
  });

  flashBtn.addEventListener('click', function() {
    var track = stream?.getVideoTracks()[0];
    if (!track) return;
    isTorchOn = !isTorchOn;
    track.applyConstraints({ advanced: [{ torch: isTorchOn }] }).catch(function(err) {
      if (isTorchOn) {
        flashScreen();
        setTimeout(function() { isTorchOn = false; }, 200);
      }
    });
    flashBtn.classList.toggle('active', isTorchOn);
  });

  flipBtn.addEventListener('click', function() {
    facingMode = (facingMode === 'environment') ? 'user' : 'environment';
    initCamera();
  });

  effectsBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    effectsDropdown.classList.toggle('open');
    aspectDropdown.classList.remove('open');
  });
  effectsDropdown.querySelectorAll('.item').forEach(function(el) {
    el.addEventListener('click', function() {
      effectsDropdown.querySelectorAll('.item').forEach(function(i) { i.classList.remove('selected'); });
      el.classList.add('selected');
      applyEffect(el.dataset.effect);
      effectsDropdown.classList.remove('open');
    });
  });

  aspectBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    aspectDropdown.classList.toggle('open');
    effectsDropdown.classList.remove('open');
  });
  aspectDropdown.querySelectorAll('.item').forEach(function(el) {
    el.addEventListener('click', async function() {
      aspectDropdown.querySelectorAll('.item').forEach(function(i) { i.classList.remove('selected'); });
      el.classList.add('selected');
      currentAspect = el.dataset.aspect;
      aspectLabel.textContent = currentAspect;
      aspectDropdown.classList.remove('open');
      if (isCameraReady) await initCamera();
    });
  });

  document.addEventListener('click', function() {
    effectsDropdown.classList.remove('open');
    aspectDropdown.classList.remove('open');
  });

  captureBtn.addEventListener('click', capturePhoto);
  galleryThumb.addEventListener('click', viewLastPhoto);

  // Make functions global for onclick safety
  window.capturePhoto = capturePhoto;
  window.viewLastPhoto = viewLastPhoto;

  // ---------- Start ----------
  if (!GAS_URL || GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE') {
    console.warn('[Camera] ⚠️ GAS_URL not set. Update app.js with your Apps Script URL.');
  }

  checkAndStart();

})();