  (() => {
    const GETFORM_ENDPOINT = 'https://getform.io/f/brogxoja'; 
    const STATE_KEY = 'frz_state_v1';
    const DB_NAME = 'frz_db';
    let db;

    // ------- Data Base (photos) -------
    function openDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        eq.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('photos')) {
            db.createObjectStore('photos', { keyPath: 'id' });
          }
        };    
        req.onsuccess = (e) => { db = e.target.result; resolve(db); };
        req.onerror = (e) => reject(e.target.error);
      });
    }
    function savePhoto(id, blob) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        tx.objectStore('photos').put({ id, blob });
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    }
    function getPhoto(id) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readonly');
        const req = tx.objectStore('photos').get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    function deletePhoto(id) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        tx.objectStore('photos').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    }

    // ------- LocalStorage (text) -------
    function loadState() { try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch { return {}; } }
    function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
    function resetState() { localStorage.removeItem(STATE_KEY); }
    function newCycle() {
      const id = 'cycle_' + Date.now();
      const s = { cycleId: id, submitted: false, inicio: {}, fim: {} };
      saveState(s); return s;
    }

    // ------- Navegation -------
    function show(screenId) {
      document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
      document.getElementById(screenId).classList.add('active');
      window.scrollTo(0, 0);
    }

    // ------- Forms -------
    function buildInicioFields() {
      const list = [
        'Manifesto',
        'Placa',
        'Quantidade de Entregas',
        'Quantidade de Cidades',
        '3 Cidades Mais Distantes',
        'Km Inicial'
      ];
      const wrap = document.getElementById('inicio-fields');
      wrap.innerHTML = '';
      for (const labelText of list) {
        const div = document.createElement('div'); div.className = 'field';
        const label = document.createElement('label'); label.textContent = labelText;
        const input = document.createElement('input');
        const isNum = /Quantidade|Km/.test(labelText);
        input.type = isNum ? 'number' : 'text';
        input.inputMode = isNum ? 'numeric' : 'text';
        input.setAttribute('data-bind', `inicio.${labelText}`);
        div.appendChild(label); div.appendChild(input); wrap.appendChild(div);
      }
    }
    function buildFimFields() {
      const wrap = document.getElementById('fim-fields');
      wrap.innerHTML = '';
      const list = [
        ['Quantidade de Devoluções (Se não tiver coloque zero)', 'Quantidade de Devoluções'],
        ['Km Final', 'Km Final']
      ];
      for (const [display, key] of list) {
        const div = document.createElement('div'); div.className = 'field';
        const label = document.createElement('label'); label.textContent = display;
        const input = document.createElement('input');
        input.type = 'number'; input.inputMode = 'numeric';
        input.setAttribute('data-bind', `fim.${key}`);
        div.appendChild(label); div.appendChild(input); wrap.appendChild(div);
      }
    }

    // ------- Data binding -------
    function bindInputs(prefix) {
      document.querySelectorAll(`[data-bind^="${prefix}."]`).forEach(input => {
        input.addEventListener('input', () => {
          const s = loadState();
          const key = input.dataset.bind.split('.').slice(1).join('.');
          s[prefix][key] = input.value; saveState(s); validate(prefix);
        });
        const s = loadState();const key = input.dataset.bind.split('.').slice(1).join('.');
        if (s[prefix] && s[prefix][key]) input.value = s[prefix][key];
      });
    }

    // ------- Camera and Location -------
    function compressImage(file) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          const maxW = 1600; const scale = Math.min(1, maxW / img.width);
          const w = Math.round(img.width * scale); const h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((blob) => { URL.revokeObjectURL(url); resolve(blob || file); }, 'image/jpeg', 0.8);
        };
        img.onerror = reject; img.src = url;
      });
    }
    function getLocation() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Sem geolocalização'));
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
          (err) => reject(err),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
      });
    }
    let lastGeoTime = 0;
    async function reverseGeocode(lat, lon) {
      const now = Date.now(); const since = now - lastGeoTime; if (since < 1200) await new Promise(r => setTimeout(r, 1200 - since)); lastGeoTime = Date.now();
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&addressdetails=1&zoom=14&accept-language=pt-BR`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('reverse failed');
        const data = await res.json(); return data.address || null;
      } catch (e) { console.warn('reverse geocode error', e); return null; }
    }
    function setupCapture(prefix) {
      const input = document.getElementById(`${prefix}-photo`);
      const preview = document.getElementById(`${prefix}-preview`);
      const locText = document.getElementById(`${prefix}-loc`);
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0]; if (!file) return;
        try {
          const blob = await compressImage(file);
          const s = loadState(); const id = `${s.cycleId}_${prefix}_photo`;
          await savePhoto(id, blob);
          preview.src = URL.createObjectURL(blob); preview.classList.remove('hidden');
          locText.textContent = 'Coletando localização...';
          try {
            const coords = await getLocation(); s[prefix].location = coords; saveState(s);
            const address = await reverseGeocode(coords.lat, coords.lon);
            if (address) { s[prefix].address = address; saveState(s); }
            locText.textContent = address
            ? `${address.city || address.town || address.village || 'Cidade desconhecida'}, ${address.state || 'UF?'} ${address.postcode ? '(' + address.postcode + ')' : ''} • Lat ${coords.lat.toFixed(5)}, Lon ${coords.lon.toFixed(5)}`
            : 'Falha ao conseguir localização, entre em contato imediatamente com seu supervisor';
          } catch (e) {
            console.error(e);
            locText.textContent = 'Falha ao conseguir localização, entre em contato imediatamente com seu supervisor';
          }
        } catch (err) {
          console.error(err);
          locText.textContent = 'Falha ao conseguir localização, entre em contato imediatamente com seu supervisor';
        } finally { validate(prefix); }
      });
    } 

    // ------- Validation -------
    function hasText(prefix, key) {
      const el = document.querySelector(`[data-bind="${prefix}.${key}"]`);
      return el && String(el.value).trim().length > 0;
    }
    function hasPreview(prefix) { return !document.getElementById(`${prefix}-preview`).classList.contains('hidden'); }
    function validate(prefix) {
      const required = prefix === 'inicio'
      ? ['Manifesto', 'Placa', 'Quantidade de Entregas', 'Quantidade de Cidades', '3 Cidades Mais Distantes', 'Km Inicial']
      : ['Quantidade de Devoluções', 'Km Final'];
      const filled = required.every(k => hasText(prefix, k));
      const photo = hasPreview(prefix);
      const s = loadState(); const hasLoc = !!(s[prefix] && (s[prefix].address || s[prefix].location));
      const ok = filled && photo && hasLoc;
      const btn = document.getElementById(`${prefix}-send`);
      if (btn) { btn.disabled = !ok; btn.classList.toggle('hidden', !ok); }
    }

    // ------- Sending Process -------
    async function sendToGetform(allData) {
      const fd = new FormData();
      fd.append('submissionId', allData.cycleId);
      for (const [k, v] of Object.entries(allData.inicio || {})) {
        if (typeof v !== 'object') {
          const key = 'inicio_' + k.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '');
          fd.append(key, String(v));
        }
      }
      for (const [k, v] of Object.entries(allData.fim || {})) {
        if (typeof v !== 'object') {
          const key = 'fim_' + k.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '');
          fd.append(key, String(v));
        }
      }
      ['inicio', 'fim'].forEach(stage => {
        const loc = allData[stage]?.location;
        const addr = allData[stage]?.address;
        if (loc) {
          fd.append(`${stage}_latitude`, String(loc.lat));
          fd.append(`${stage}_longitude`, String(loc.lon));
          fd.append(`${stage}_accuracy`, String(loc.accuracy || ''));
          if (addr) {
            fd.append(`${stage}_cidade`, addr.city || addr.town || addr.village || '');
            fd.append(`${stage}_uf`, addr.state || '');
            fd.append(`${stage}_cep`, addr.postcode || '');
          }
        }
      });
      const inicioPhoto = await getPhoto(`${allData.cycleId}_inicio_photo`);
      const fimPhoto = await getPhoto(`${allData.cycleId}_fim_photo`);
      if (inicioPhoto) fd.append('Foto do Odômetro (Início)', new File([inicioPhoto], `inicio_${allData.cycleId}.jpg`, { type: 'image/jpeg' }));
      if (fimPhoto) fd.append('Foto do Odômetro (Fim)', new File([fimPhoto], `fim_${allData.cycleId}.jpg`, { type: 'image/jpeg' }));
      const res = await fetch(GETFORM_ENDPOINT, { method: 'POST', body: fd });
      if (!res.ok) throw new Error('Falha ao enviar');
      return true;
    }

    // ------- Hints iOS -------
    function iosFocusScrollGuard() {
      window.addEventListener('pageshow', () => {
        document.querySelectorAll('input,button,select,textarea').forEach(el => el.addEventListener('focus', () => window.scrollTo(0, 0), { passive: true }));
      });
    }

    // ------- Boot -------
    function init() {
      openDB().then(() => {
        buildInicioFields(); buildFimFields();
        bindInputs('inicio'); bindInputs('fim');
        setupCapture('inicio'); setupCapture('fim');
        iosFocusScrollGuard();
        document.getElementById('btnStart').addEventListener('click', () => {
          let s = loadState(); if (!s.cycleId || s.submitted) s = newCycle(); saveState(s);
          show('inicio'); validate('inicio');
        });
        document.getElementById('inicio-send').addEventListener('click', () => { show('middle'); });
        document.getElementById('btnFim').addEventListener('click', () => { show('fim'); validate('fim'); });
        document.getElementById('fim-send').addEventListener('click', async () => {
        const btn = document.getElementById('fim-send'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Enviando...';
        try {
          const s = loadState(); await sendToGetform(s); s.submitted = true; saveState(s);
          await deletePhoto(`${s.cycleId}_inicio_photo`).catch(()=>{}); await deletePhoto(`${s.cycleId}_fim_photo`).catch(()=>{});
          resetState(); alert('Enviado com sucesso!'); show('home');
        } catch (e) { alert('Falha ao enviar. Verifique sua conexão e tente novamente.'); }
        finally { btn.textContent = old; btn.disabled = false; }
        });

    // Do not lose infomation during process
    const s = loadState();
    if (s.cycleId && !s.submitted) {
      getPhoto(`${s.cycleId}_inicio_photo`).then(blob => { if (blob) { const p = document.getElementById('inicio-preview'); p.src = URL.createObjectURL(blob); p.classList.remove('hidden'); } });
      getPhoto(`${s.cycleId}_fim_photo`).then(blob => { if (blob) { const p = document.getElementById('fim-preview'); p.src = URL.createObjectURL(blob); p.classList.remove('hidden'); } });
    }
      });
    }
    document.addEventListener('DOMContentLoaded', init);
  })();