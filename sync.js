// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Replace the two placeholders with your Supabase project URL +
// publishable key (same ones you used in topbar.js/gym.html).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://dfxzzusswemjxpbushon.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_TNfPTq4dWRbe2hMqp063mA_MeFv79o-';
  const STORAGE_VERSION = 'dashboard-storage-v1';

  const persistenceConfigs = [];
  let storageWrapped = false;
  let rawSetItem = null;
  let rawRemoveItem = null;
  const backupCache = {};

  function cfgKeys(config) { return (config && config.syncedKeys) || []; }
  function cfgPrefixes(config) { return (config && config.syncedPrefixes) || []; }
  function cfgAppKey(config) { return (config && config.appKey) || 'dashboard'; }
  function cfgVersion(config) { return (config && config.storageVersion) || STORAGE_VERSION; }
  function configMatches(config, k) {
    if (!k) return false;
    if (cfgKeys(config).indexOf(k) !== -1) return true;
    const prefixes = cfgPrefixes(config);
    for (let i = 0; i < prefixes.length; i++) {
      if (k.indexOf(prefixes[i]) === 0) return true;
    }
    return false;
  }
  function matchingConfigs(k) {
    return persistenceConfigs.filter((config) => configMatches(config, k));
  }
  function isNonEmptyValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== null && value !== undefined && value !== '';
  }
  function parseStored(raw, key) {
    if (raw == null) return { ok: false, value: null };
    try { return { ok: true, value: JSON.parse(raw) }; }
    catch (e) {
      console.warn('Persistent storage parse failed for', key, e);
      return { ok: false, value: null };
    }
  }
  function backupId(config, key) {
    return cfgAppKey(config) + ':' + key;
  }
  function openBackupDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('dashboard_persistence_v1', 1); }
      catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore('kv'); } catch (e) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  function backupPut(config, key, value) {
    const id = backupId(config, key);
    const record = { key: key, appKey: cfgAppKey(config), version: cfgVersion(config), value: value, updatedAt: new Date().toISOString() };
    backupCache[id] = record;
    const listId = backupId(config, '__keys__');
    const listRecord = backupCache[listId] || { key: '__keys__', appKey: cfgAppKey(config), version: cfgVersion(config), value: [], updatedAt: new Date().toISOString() };
    if (listRecord.value.indexOf(key) === -1) listRecord.value.push(key);
    listRecord.updatedAt = new Date().toISOString();
    backupCache[listId] = listRecord;
    openBackupDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        store.put(record, id);
        store.put(listRecord, listId);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      } catch (e) { try { db.close(); } catch (_) {} }
    });
  }
  function backupGet(config, key) {
    const id = backupId(config, key);
    if (id in backupCache) return Promise.resolve(backupCache[id]);
    return openBackupDb().then((db) => new Promise((resolve) => {
      if (!db) { resolve(null); return; }
      try {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(id);
        req.onsuccess = () => {
          const record = req.result || null;
          if (record) backupCache[id] = record;
          resolve(record);
        };
        req.onerror = () => resolve(null);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      } catch (e) { try { db.close(); } catch (_) {} resolve(null); }
    }));
  }
  function listLocalKeysForConfig(config) {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (configMatches(config, k)) out.push(k);
      }
    } catch (e) {}
    return out;
  }
  function backupCurrentLocal(config) {
    listLocalKeysForConfig(config).forEach((key) => {
      let raw = null;
      try { raw = localStorage.getItem(key); } catch (e) {}
      const parsed = parseStored(raw, key);
      if (parsed.ok) backupPut(config, key, parsed.value);
    });
    try { rawSetItem('__dashboard_storage_version__:' + cfgAppKey(config), JSON.stringify(cfgVersion(config))); } catch (e) {}
  }
  function restoreFromBackup(config) {
    backupGet(config, '__keys__').then((listRecord) => {
      const indexedKeys = listRecord && Array.isArray(listRecord.value) ? listRecord.value : [];
      const keys = Array.from(new Set(cfgKeys(config).concat(indexedKeys)));
      return Promise.all(keys.map((key) => backupGet(config, key).then((record) => {
      if (!record || record.version !== cfgVersion(config)) return false;
      let raw = null;
      try { raw = localStorage.getItem(key); } catch (e) {}
      const parsed = parseStored(raw, key);
      if (raw != null && parsed.ok) return false;
      try {
        rawSetItem(key, JSON.stringify(record.value));
        return true;
      } catch (e) { return false; }
      })));
    }).then((restored) => {
      if (restored.some(Boolean) && typeof config.onRestored === 'function') {
        try { config.onRestored(); } catch (e) {}
      }
      if (restored.some(Boolean)) window.dispatchEvent(new Event('storage'));
    });
  }
  function installPersistentStorage() {
    if (storageWrapped) return;
    storageWrapped = true;
    rawSetItem = localStorage.setItem.bind(localStorage);
    rawRemoveItem = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      rawSetItem(k, v);
      const parsed = parseStored(v, k);
      if (parsed.ok) {
        matchingConfigs(k).forEach((config) => backupPut(config, k, parsed.value));
      }
    };
    localStorage.removeItem = function (k) {
      rawRemoveItem(k);
    };
  }

  window.initPersistentStorage = function (config) {
    if (!config || !config.appKey) return;
    installPersistentStorage();
    persistenceConfigs.push(config);
    backupCurrentLocal(config);
    restoreFromBackup(config);
  };

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    const preserveLocalKeys = (config && config.preserveLocalKeys) || [];
    const preserveLocalPrefixes = (config && config.preserveLocalPrefixes) || [];
    window.initPersistentStorage(config);
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null;
    let preservedLocalDuringApply = false;

    function matches(k) { return configMatches(config, k); }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); }
        catch (e) { console.warn('Skipping corrupted stored value for', k, e); }
      }
      return out;
    }
    function readLocalParsed(k) {
      const raw = localStorage.getItem(k);
      if (raw == null) return { exists: false, value: null };
      try { return { exists: true, value: JSON.parse(raw) }; }
      catch (e) { return { exists: true, value: raw }; }
    }
    function shouldPreserveKey(k) {
      if (preserveLocalKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < preserveLocalPrefixes.length; i++) {
        if (k.indexOf(preserveLocalPrefixes[i]) === 0) return true;
      }
      return preserveLocalKeys.length === 0 && preserveLocalPrefixes.length === 0;
    }
    function shouldPreserveLocal(k, incomingValue) {
      if (!shouldPreserveKey(k)) return false;
      if (isNonEmptyValue(incomingValue)) return false;
      const local = readLocalParsed(k);
      const preserve = local.exists && isNonEmptyValue(local.value);
      if (preserve) preservedLocalDuringApply = true;
      return preserve;
    }
    const origSet = rawSetItem || localStorage.setItem.bind(localStorage);
    const origRemove = rawRemoveItem || localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      const parsed = parseStored(v, k);
      if (parsed.ok) matchingConfigs(k).forEach((persistConfig) => backupPut(persistConfig, k, parsed.value));
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      preservedLocalDuringApply = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          if (shouldPreserveLocal(k, remote[k])) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) {
            try {
              origSet(k, incoming);
              matchingConfigs(k).forEach((persistConfig) => backupPut(persistConfig, k, remote[k]));
              changed = true;
            } catch (e) {}
          }
        }
        for (const k of listAllKeys()) {
          if (shouldPreserveKey(k) && !(k in remote)) {
            preservedLocalDuringApply = true;
            continue;
          }
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      if (preservedLocalDuringApply) schedulePush();
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }
    async function pushNow() {
      if (!supa) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) lastSyncedJson = json;
      } catch (e) {}
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });
  };
})();
