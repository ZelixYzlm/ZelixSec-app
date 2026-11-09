'use strict';

/**
 * ZelixSec - arayüz mantığı (v1.0.2)
 * Sekmeli ayarlar · 12 renk teması · dil seçimi (23 dil) · reklam engelleyici ·
 * uygulama içi güncelleme. Tüm ağ işleri ana süreçtedir; burada yalnızca
 * görüntüleme + IPC çağrıları var.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const I18N = window.ZelixI18N;

  const state = {
    settings: null,
    profiles: [],
    allowlist: [],
    status: null,
    systemProxy: null,
    platform: '',
    version: '1.0.2',
    logs: [],
    lang: 'tr',
    update: null,
  };

  let lastLatency = null;
  let busy = false;
  let lastSplit = null;
  let activeTab = 'general';

  const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

  /* -------------------------------------------------------------- temalar */

  // 12 renk teması: [accent, accent2]
  const THEMES = {
    neon: ['#34e5ff', '#7c5cff'],
    lilac: ['#c58cff', '#ff7ae0'],
    emerald: ['#3dffa2', '#00c2a8'],
    lagoon: ['#2ee6c8', '#2f9bff'],
    cobalt: ['#4d8dff', '#7c5cff'],
    crimson: ['#ff4d6b', '#ff7a45'],
    ember: ['#ff8a3d', '#ff4d6b'],
    gold: ['#ffd166', '#ff9f43'],
    rose: ['#ff7ab6', '#c58cff'],
    frond: ['#a8e063', '#38f9d7'],
    graphite: ['#c7d0e0', '#8a97ad'],
    magenta: ['#ff3df2', '#7c5cff'],
  };
  const THEME_IDS = Object.keys(THEMES);

  function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }

  function mix(a, b, ratio) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * ratio),
      Math.round(a[1] + (b[1] - a[1]) * ratio),
      Math.round(a[2] + (b[2] - a[2]) * ratio),
    ];
  }

  function rgba(rgb, alpha) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(alpha).toFixed(3)})`;
  }

  /** Ayarları CSS değişkenlerine döker: --accent, --panel, --aurora-* vs. */
  function applyAppearance() {
    const ap = state.settings?.appearance || {};
    const [c1, c2] = THEMES[ap.theme] || THEMES.neon;
    const opacity = Math.min(100, Math.max(25, Number(ap.opacity) || 78)) / 100;
    const p = hexToRgb(c1);
    const q = hexToRgb(c2);
    const dark = [10, 15, 26];
    const root = document.documentElement.style;

    root.setProperty('--accent', c1);
    root.setProperty('--accent-2', c2);
    root.setProperty('--glow', rgba(p, 0.5));
    root.setProperty('--glow-soft', rgba(p, 0.16));
    root.setProperty('--glow-strong', rgba(q, 0.6));
    root.setProperty('--panel', rgba(mix(dark, p, 0.16), opacity));
    root.setProperty('--panel-line', rgba(p, 0.22 + opacity * 0.2));
    root.setProperty('--aurora-1', rgba(p, 1));
    root.setProperty('--aurora-2', rgba(q, 1));

    document.body.classList.toggle('no-aurora', ap.aurora === false);

    // Marka şıralaması (kalkan logosu) da temaya uysun
    const stops = document.querySelectorAll('#zg stop');
    if (stops[0]) stops[0].setAttribute('stop-color', c1);
    if (stops[1]) stops[1].setAttribute('stop-color', c2);
  }

  /* -------------------------------------------------------------- biçimde */

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let index = -1;
    let size = value;
    do {
      size /= 1024;
      index += 1;
    } while (size >= 1024 && index < units.length - 1);
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
  }

  function formatTime(ts) {
    const date = new Date(ts);
    return date.toTimeString().slice(0, 8);
  }

  function t2(key, vars) {
    const raw = I18N.t(state.lang, key);
    return vars ? I18N.template(raw, vars) : raw;
  }

  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast${kind === 'error' ? ' error' : ''}`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  /* ---------------------------------------------------------------- çizöl */

  function profileLabel(profile) {
    if (profile.id === 'all') return t2('profile.all');
    if (profile.id === 'social') return t2('profile.social');
    return profile.name || profile.id;
  }

  function renderProfiles() {
    const row = $('profileRow');
    row.innerHTML = '';
    const active = state.settings ? state.settings.activeProfile : '';
    for (const profile of state.profiles) {
      const chip = document.createElement('button');
      chip.className = `chip${profile.id === active ? ' active' : ''}`;
      chip.type = 'button';
      chip.dataset.profile = profile.id;
      const count = profile.hosts.length;
      chip.innerHTML = `<span>${profile.emoji || '🎯'}</span><span></span>${
        count ? `<span class="hint">${count}</span>` : ''
      }`;
      chip.children[1].textContent = profileLabel(profile);
      chip.addEventListener('click', () => selectProfile(profile.id));
      row.appendChild(chip);
    }
  }

  function renderStatus() {
    const status = state.status || {};
    const running = Boolean(status.running);
    const hero = $('heroCard');

    hero.classList.toggle('running', running);

    const dot = $('statusDot');
    dot.className = 'dot';
    if (busy) {
      dot.classList.add('busy');
      $('statusLabel').textContent = t2('status.connecting');
      $('statusSub').textContent = t2('status.connecting');
    } else if (running) {
      dot.classList.add('on');
      $('statusLabel').textContent = t2('status.on');
      $('statusSub').textContent = `${t2('status.splitting')}${
        status.upstream?.enabled ? ` · ${t2('status.upstreamOn')}` : ''
      }`;
    } else {
      $('statusLabel').textContent = t2('status.off');
      $('statusSub').textContent = t2('status.subOff');
    }

    const settings = state.settings || {};
    const mode = status.mode || settings.engine?.mode || 'split2';
    $('modePill').textContent = mode;
    $('portPill').textContent = `127.0.0.1:${status.port || settings.engine?.port || 7717}`;
    $('dohPill').textContent = settings.doh?.enabled
      ? `DoH: ${settings.doh.provider === 'system' ? t2('dns.p.system') : settings.doh.provider}`
      : `DoH: ${t2('diag.off')}`;

    const metrics = status.metrics || {};
    const adsBlocked = status.adblock?.blocked ?? metrics.adsBlocked ?? 0;
    $('statActive').textContent = String(metrics.active || 0);
    $('statDown').textContent = formatBytes(metrics.bytesDown);
    $('statUp').textContent = formatBytes(metrics.bytesUp);
    $('statResets').textContent = String(metrics.suspiciousResets || 0);
    $('statAds').textContent = String(adsBlocked);
    $('adblockCount').textContent = String(adsBlocked);
    $('statLatency').textContent = lastLatency ? `${lastLatency.toFixed(0)} ms` : '—';

    $('systemProxyToggle').checked = Boolean(
      state.systemProxy?.applied || settings.systemProxy?.enabled,
    );

    $('lastSplit').textContent = lastSplit
      ? `${lastSplit.sni || '—'} · split-pos ${lastSplit.offset} · ${lastSplit.first}+${lastSplit.second} B · ${formatTime(
          lastSplit.at,
        )}`
      : t2('last.none');

    renderHosts();
    renderAdblockHosts();
  }

  function renderHosts() {
    const list = $('hostList');
    const hosts = (state.status?.hosts || []).slice(0, 12);
    $('hostCount').textContent = t2('hosts.count', { n: hosts.length });
    list.innerHTML = '';
    if (!hosts.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t2('hosts.empty');
      list.appendChild(li);
      return;
    }
    for (const host of hosts) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = host.host;
      const count = document.createElement('span');
      count.className = host.resets ? 'reset-flag' : 'count';
      count.textContent = `${host.count}×${host.resets ? ` · ${host.resets} reset` : ''}`;
      li.appendChild(name);
      li.appendChild(count);
      list.appendChild(li);
    }
  }

  function renderAdblockHosts() {
    const list = $('adblockHosts');
    const hosts = (state.status?.adblock?.hosts || []).slice(0, 10);
    list.innerHTML = '';
    if (!hosts.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t2('adblock.empty');
      list.appendChild(li);
      return;
    }
    for (const host of hosts) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = host.host;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${host.count}×`;
      li.appendChild(name);
      li.appendChild(count);
      list.appendChild(li);
    }
  }

  /* --------------------------------------------------------------- loglar */

  function appendLog(entry) {
    const box = $('logConsole');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const line = document.createElement('div');
    line.className = `log-line ${entry.level || 'info'}`;
    line.innerHTML = '<span class="time"></span><span class="msg"></span>';
    line.querySelector('.time').textContent = formatTime(entry.at || Date.now());
    line.querySelector('.msg').textContent = entry.message;
    box.appendChild(line);
    while (box.childElementCount > 400) box.removeChild(box.firstElementChild);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function renderAll(data) {
    Object.assign(state, data);
    state.lang = state.settings?.app?.language || state.lang || 'tr';
    $('platformBadge').textContent = PLATFORM_LABEL[state.platform] || state.platform || '—';
    $('versionLabel').textContent = state.version || '1.0.2';
    $('aboutVersion').textContent = state.version || '1.0.2';
    document.documentElement.lang = state.lang;
    I18N.apply(state.lang);
    applyAppearance();
    renderThemeGrid();
    renderProfiles();
    renderStatus();
    const box = $('logConsole');
    box.innerHTML = '';
    (state.logs || []).slice(-200).forEach(appendLog);
    box.scrollTop = box.scrollHeight;
    fillSettingsForm();
    renderUpdateUI();
  }

  /* --------------------------------------------------------------- eyleml */

  async function refresh() {
    try {
      const data = await window.zelix.getState();
      Object.assign(state, data);
      state.lang = state.settings?.app?.language || state.lang;
      renderStatus();
      renderProfiles();
      renderUpdateUI();
    } catch {
      /* yoksay */
    }
  }

  function livePatch(partial) {
    return window.zelix.patchSettings(partial).then((result) => {
      if (result?.ok) {
        state.settings = result.settings;
        state.allowlist = result.allowlist || state.allowlist;
      }
      return result;
    });
  }

  async function selectProfile(profileId) {
    const result = await window.zelix.setProfile(profileId);
    if (result?.ok) {
      state.allowlist = result.allowlist;
      if (state.settings) state.settings.activeProfile = profileId;
      renderProfiles();
      const profile = state.profiles.find((p) => p.id === profileId);
      toast(t2('toast.profile', { p: profile ? profileLabel(profile) : profileId }));
    }
  }

  async function toggleEngine() {
    if (busy) return;
    busy = true;
    renderStatus();
    const running = Boolean(state.status?.running);
    try {
      const result = await window.zelix.toggle(!running);
      if (!result?.ok) {
        toast(result?.error || 'IPC error', 'error');
      } else {
        state.status = result.status;
        toast(running ? t2('toast.disconnected') : t2('toast.connected'));
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function runDiagnostics(host) {
    $('diagCard').classList.remove('hidden');
    $('diagBody').innerHTML = '<div class="diag-verdict"></div>';
    $('diagBody').firstElementChild.textContent = t2('diag.running');

    const report = await window.zelix.diagnose(host);
    if (!report?.ok) {
      const el = $('diagBody');
      el.innerHTML = '<div class="diag-verdict blocked"></div>';
      el.firstElementChild.textContent = `${t2('diag.err')}: ${report?.error || '—'}`;
      return;
    }
    renderDiagnostics(report.report);
  }

  function renderDiagnostics(report) {
    const box = $('diagBody');
    box.innerHTML = '';
    const item = (key, value) => {
      const wrap = document.createElement('div');
      wrap.className = 'diag-item';
      const k = document.createElement('div');
      k.className = 'k';
      k.textContent = key;
      const v = document.createElement('div');
      v.className = 'v';
      v.textContent = value;
      wrap.appendChild(k);
      wrap.appendChild(v);
      box.appendChild(wrap);
    };

    if (report.secured?.ok) lastLatency = report.secured.ms;

    const VERDICT_KEYS = {
      open: 'diag.v.open',
      bypassed: 'diag.v.bypassed',
      'proxy-error': 'diag.v.proxyError',
      'blocked-hard': 'diag.v.hard',
      'dns-failed': 'diag.v.dns',
    };

    const dns = report.dns.ok
      ? `${report.dns.ips.slice(0, 3).join(', ')} · ${report.dns.ms} ms`
      : `${t2('diag.err')}: ${report.dns.error || ''}`;
    const direct = report.direct.ok
      ? `${t2('diag.open')} · ${report.direct.ms} ms · ${report.direct.protocol || ''}`
      : `${t2('diag.blocked')} · ${report.direct.error || ''}`;
    const secured = report.secured.ok
      ? `${t2('diag.open')} · ${report.secured.ms} ms · ${report.secured.protocol || ''}`
      : `${t2('diag.off')} · ${report.secured.error || ''}`;

    item(t2('diag.dns'), dns);
    item(t2('diag.direct'), direct);
    item(t2('diag.secured'), secured);

    const verdict = document.createElement('div');
    const key = VERDICT_KEYS[report.verdict];
    verdict.className = `diag-verdict ${
      report.verdict === 'open' || report.verdict === 'bypassed'
        ? 'bypassed'
        : report.verdict === 'blocked-hard' || report.verdict === 'dns-failed'
          ? 'blocked'
          : ''
    }`;
    verdict.textContent = key ? t2(key) : (report.notes || []).join(' ');
    box.appendChild(verdict);
    renderStatus();
  }

  async function toggleSystemProxy(enabled) {
    const result = await window.zelix.setSystemProxy(enabled);
    if (!result.ok) toast(result.error || 'IPC error', 'error');
    else toast(enabled ? t2('toast.proxyOn') : t2('toast.proxyOff'));
    await refresh();
  }

  /* ------------------------------------------------------------- ayarlar */

  function fillSettingsForm() {
    const s = state.settings;
    if (!s) return;
    $('modeSelect').value = s.engine.mode;
    $('splitPosInput').value = s.engine.splitPosition;
    $('splitDelayInput').value = s.engine.splitDelayMs;
    $('portInput').value = s.engine.port;
    $('dohToggle').checked = Boolean(s.doh.enabled);
    $('dohProvider').value = s.doh.provider;
    $('dohFallbackToggle').checked = Boolean(s.doh.allowSystemFallback);
    $('upstreamToggle').checked = Boolean(s.upstream.enabled);
    $('upstreamType').value = s.upstream.type;
    $('upstreamHost').value = s.upstream.host;
    $('upstreamPort').value = s.upstream.port;
    $('upstreamUser').value = s.upstream.username || '';
    $('upstreamPass').value = s.upstream.password || '';
    $('customHostsInput').value = (s.customHosts || []).join(', ');
    $('autoStartToggle').checked = Boolean(s.app.autoStart);
    $('trayToggle').checked = Boolean(s.app.minimizeToTray);
    $('autoConnectToggle').checked = Boolean(s.app.autoConnect);
    $('autoProxyToggle').checked = Boolean(s.app.autoSystemProxy);
    $('adblockToggle').checked = Boolean(s.adblock.enabled);
    $('adblockListInput').value = (s.adblock.customBlocked || []).join(', ');
    $('opacityRange').value = s.appearance.opacity;
    $('opacityValue').textContent = String(s.appearance.opacity);
    $('auroraToggle').checked = s.appearance.aurora !== false;
    $('updateAutoToggle').checked = Boolean(s.update.autoCheck);
    $('updateManifestInput').value = s.update.manifestUrl || '';
    $('languageSelect').value = state.lang;
    renderThemeGrid();
  }

  function parseList(value) {
    return String(value || '')
      .split(/[\s,;]+/)
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  async function saveSettings() {
    const partial = {
      engine: {
        mode: $('modeSelect').value,
        splitPosition: Number($('splitPosInput').value) || 1,
        splitDelayMs: Math.max(0, Number($('splitDelayInput').value) || 0),
        port: Math.min(65535, Math.max(1024, Number($('portInput').value) || 7717)),
      },
      doh: {
        enabled: $('dohToggle').checked,
        provider: $('dohProvider').value,
        allowSystemFallback: $('dohFallbackToggle').checked,
      },
      upstream: {
        enabled: $('upstreamToggle').checked,
        type: $('upstreamType').value,
        host: $('upstreamHost').value.trim() || '127.0.0.1',
        port: Number($('upstreamPort').value) || 1080,
        username: $('upstreamUser').value,
        password: $('upstreamPass').value,
      },
      customHosts: parseList($('customHostsInput').value),
      adblock: { customBlocked: parseList($('adblockListInput').value) },
      diagnosticsTarget: $('testTargetInput').value.trim() || 'discord.com',
    };

    const result = await window.zelix.patchSettings(partial);
    if (result?.ok) {
      state.settings = result.settings;
      state.allowlist = result.allowlist;
      await refresh();
      toast(t2('toast.saved'));
    } else {
      toast(t2('toast.saveFailed'), 'error');
    }
  }

  /* ------------------------------------------------------------- çekmece */

  function activateTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.drawer-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.drawer-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === tabId);
    });
  }

  function openDrawer(tab) {
    fillSettingsForm();
    activateTab(tab || activeTab || 'general');
    $('drawer').classList.remove('hidden');
    $('drawerBackdrop').classList.remove('hidden');
  }

  function closeDrawer() {
    $('drawer').classList.add('hidden');
    $('drawerBackdrop').classList.add('hidden');
  }

  /* ------------------------------------------------- görünüm (tema+renk) */

  function renderThemeGrid() {
    const grid = $('themeGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const current = state.settings?.appearance?.theme || 'neon';
    for (const id of THEME_IDS) {
      const [c1, c2] = THEMES[id];
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = `swatch${id === current ? ' active' : ''}`;
      swatch.dataset.theme = id;
      swatch.title = id;
      swatch.setAttribute('aria-label', id);
      swatch.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
      swatch.addEventListener('click', () => {
        state.settings = {
          ...state.settings,
          appearance: { ...state.settings.appearance, theme: id },
        };
        renderThemeGrid();
        applyAppearance();
        livePatch({ appearance: { theme: id } });
      });
      grid.appendChild(swatch);
    }
  }

  function setLanguage(lang) {
    if (!I18N.codes.includes(lang)) return;
    state.lang = lang;
    state.settings = {
      ...state.settings,
      app: { ...state.settings.app, language: lang },
    };
    document.documentElement.lang = lang;
    I18N.apply(lang);
    $('languageSelect').value = lang;
    renderStatus();
    renderUpdateUI();
    livePatch({ app: { language: lang } });
  }

  /* ------------------------------------------------------------ adblock */

  function renderUpdateBadge() {
    const u = state.update || { phase: 'idle' };
    const show = u.phase === 'available' || u.phase === 'downloading' || u.phase === 'ready';
    $('updateBadge').classList.toggle('hidden', !show);
    document.querySelectorAll('.tab-dot[data-tab-dot="update"]').forEach((dot) => {
      dot.classList.toggle('hidden', !show);
    });
  }

  function renderUpdateUI() {
    if (!$('updateInstallBtn')) return;
    const u = state.update || { phase: 'idle' };
    const settings = state.settings || {};

    $('updateCheckBtn').disabled = u.phase === 'checking' || u.phase === 'downloading';
    $('updateCheckBtn').textContent =
      u.phase === 'checking' ? t2('update.checking') : u.phase === 'downloading' ? t2('update.checking') : t2('update.check');

    const ready = u.phase === 'ready';
    $('updateInstallBtn').classList.toggle('hidden', !ready);

    const statusText = $('updateStatusText');
    statusText.textContent =
      u.phase === 'up-to-date'
        ? t2('update.home')
        : u.phase === 'available'
          ? t2('update.available', { v: u.latest || '' })
          : u.phase === 'downloading'
            ? t2('update.downloading', { p: Math.round(u.progress?.percent || 0) })
            : u.phase === 'ready'
              ? t2('update.ready')
              : u.phase === 'installing'
                ? t2('update.installing')
                : u.phase === 'error'
                  ? `${t2('update.failed')}${u.error ? `: ${u.error}` : ''}`
                  : '';

    $('updateProgressWrap').classList.toggle('hidden', u.phase !== 'downloading');
    $('updateProgressFill').style.width = `${Math.round(u.progress?.percent || 0)}%`;

    const notesWrap = $('updateNotesWrap');
    if (u.notes && (u.phase === 'available' || u.phase === 'ready')) {
      notesWrap.classList.remove('hidden');
      $('updateNotes').textContent = String(u.notes);
    } else {
      notesWrap.classList.add('hidden');
    }

    const lastCheck = settings.update?.lastCheck;
    $('updateLastCheck').textContent =
      t2('update.lastCheck') + ': ' + (lastCheck ? new Date(lastCheck).toLocaleString() : '—');

    renderUpdateBadge();
  }

  /* ---------------------------------------------------------------- kurulum */

  function bind() {
    $('powerBtn').addEventListener('click', toggleEngine);
    $('settingsBtn').addEventListener('click', () => openDrawer());
    $('updateBadge').addEventListener('click', () => openDrawer('update'));
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);
    document.querySelectorAll('.drawer-tab').forEach((btn) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    $('saveBtn').addEventListener('click', saveSettings);
    $('resetBtn').addEventListener('click', async () => {
      if (!window.confirm(t2('drawer.resetConfirm'))) return;
      await window.zelix.patchSettings({
        engine: { mode: 'split2', port: 7717, splitPosition: 1, splitDelayMs: 0 },
      });
      await refresh();
      fillSettingsForm();
      toast(t2('toast.resetDone'));
    });

    $('diagBtn').addEventListener('click', () => {
      const host = (state.settings?.diagnosticsTarget || 'discord.com').trim();
      runDiagnostics(host);
    });
    $('diagClose').addEventListener('click', () => $('diagCard').classList.add('hidden'));

    $('flushBtn').addEventListener('click', flushDns);
    $('testFlushBtn').addEventListener('click', flushDns);
    $('testRunBtn').addEventListener('click', async () => {
      const host = ($('testTargetInput').value.trim() || state.settings?.diagnosticsTarget || 'discord.com').trim();
      closeDrawer();
      await runDiagnostics(host);
    });

    $('systemProxyToggle').addEventListener('change', (event) => toggleSystemProxy(event.target.checked));

    // Genel sekme — canlı kayıt
    $('languageSelect').addEventListener('change', (event) => setLanguage(event.target.value));
    $('autoStartToggle').addEventListener('change', (event) => livePatch({ app: { autoStart: event.target.checked } }));
    $('trayToggle').addEventListener('change', (event) => livePatch({ app: { minimizeToTray: event.target.checked } }));
    $('autoConnectToggle').addEventListener('change', (event) => livePatch({ app: { autoConnect: event.target.checked } }));
    $('autoProxyToggle').addEventListener('change', (event) => livePatch({ app: { autoSystemProxy: event.target.checked } }));

    // Görünüm — canlı kayıt
    $('opacityRange').addEventListener('input', (event) => {
      state.settings = {
        ...state.settings,
        appearance: { ...state.settings.appearance, opacity: Number(event.target.value) },
      };
      $('opacityValue').textContent = String(event.target.value);
      applyAppearance();
    });
    $('opacityRange').addEventListener('change', (event) =>
      livePatch({ appearance: { opacity: Number(event.target.value) } }),
    );
    $('auroraToggle').addEventListener('change', (event) => {
      state.settings = {
        ...state.settings,
        appearance: { ...state.settings.appearance, aurora: event.target.checked },
      };
      applyAppearance();
      livePatch({ appearance: { aurora: event.target.checked } });
    });

    // Reklam engelleyici
    $('adblockToggle').addEventListener('change', (event) =>
      livePatch({ adblock: { enabled: event.target.checked } }),
    );
    $('adblockClearBtn').addEventListener('click', async () => {
      const result = await window.zelix.clearAdBlock();
      if (result?.ok) toast(t2('toast.adblockCleared'));
      await refresh();
    });
    $('adblockTestBtn').addEventListener('click', async () => {
      const btn = $('adblockTestBtn');
      btn.disabled = true;
      try {
        const result = await window.zelix.testAdBlock();
        if (!result?.ok) toast(result?.error || t2('toast.adblockFail'), 'error');
        else if (result.blocked) toast(t2('adblock.testOk'));
        else toast(t2('adblock.testFail'), 'error');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    // Güncelleme
    $('updateAutoToggle').addEventListener('change', (event) =>
      livePatch({ update: { autoCheck: event.target.checked } }),
    );
    $('updateManifestInput').addEventListener('change', (event) =>
      livePatch({ update: { manifestUrl: event.target.value.trim() } }),
    );
    $('updateCheckBtn').addEventListener('click', async () => {
      try {
        const result = await window.zelix.checkUpdate();
        if (!result.ok) {
          toast(result.error || t2('toast.updateFail'), 'error');
          return;
        }
        state.update = result.status;
        renderUpdateUI();
        if (result.status.phase === 'up-to-date') toast(t2('toast.updateLatest'));
        else if (result.status.phase === 'available') toast(t2('toast.updateFound', { v: result.status.latest }));
      } catch (err) {
        toast(err.message || t2('toast.updateFail'), 'error');
      }
    });
    $('updateInstallBtn').addEventListener('click', async () => {
      try {
        const result = await window.zelix.installUpdate();
        if (!result.ok) toast(result.error || t2('toast.updateError'), 'error');
        else toast(t2('update.installing'));
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    $('clearLogBtn').addEventListener('click', async () => {
      await window.zelix.clearLogs();
      $('logConsole').innerHTML = '';
    });

    $('exportLogBtn').addEventListener('click', async () => {
      const result = await window.zelix.exportLogs();
      if (result.ok) toast(t2('toast.savedLog'));
    });

    $('hideBtn').addEventListener('click', () => window.zelix.hide());

    window.zelix.onLog((entry) => {
      state.logs.push(entry);
      appendLog(entry);
    });
    window.zelix.onStatus((status) => {
      state.status = status;
      renderStatus();
    });
    window.zelix.onSplit((info) => {
      lastSplit = info;
      renderStatus();
    });
    window.zelix.onSettings((settings) => {
      state.settings = settings;
      state.lang = settings.app?.language || state.lang;
      I18N.apply(state.lang);
      applyAppearance();
      renderProfiles();
      renderStatus();
      fillSettingsForm();
      renderUpdateUI();
    });
    if (window.zelix.onUpdateStatus) {
      window.zelix.onUpdateStatus((u) => {
        state.update = u;
        renderUpdateUI();
      });
    }
    if (window.zelix.onUpdateProgress) {
      window.zelix.onUpdateProgress((progress) =>
        $('updateProgressFill').style.setProperty('width', `${Math.round(progress?.percent || 0)}%`),
      );
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDrawer();
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        toggleEngine();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault();
        openDrawer('general');
      }
    });

    setInterval(refresh, 3000);
  }

  async function flushDns() {
    const result = await window.zelix.flushDns();
    toast(result.ok ? t2('toast.dnsOk') : t2('toast.dnsFail'), result.ok ? undefined : 'error');
  }

  async function boot() {
    if (!window.zelix) {
      // Tarayıcıda (Electron dışı) açılırsa arayüz yine de çizilsin
      window.zelix = createMockBridge();
    }
    // Dil seçim kutusu
    const select = $('languageSelect');
    for (const [code, name] of I18N.LANGS) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = name;
      select.appendChild(option);
    }
    const data = await window.zelix.getState();
    state.lang = data.settings?.app?.language || 'tr';
    document.documentElement.lang = state.lang;
    I18N.apply(state.lang);
    renderAll(data);
    bind();
  }

  /* --------------------------------------------------- tarayıcı önizleme köprüsü */

  function createMockBridge() {
    const listeners = { log: [], status: [], split: [], settings: [], updateStatus: [], updateProgress: [] };
    const DEFAULT_URL = 'https://raw.githubusercontent.com/ZelixYzlm/ZelixSec-app/main/update.json';
    const mock = {
      settings: {
        activeProfile: 'discord',
        customHosts: [],
        engine: { port: 7717, mode: 'split2', splitPosition: 1, splitDelayMs: 0 },
        doh: { enabled: true, provider: 'cloudflare', allowSystemFallback: true },
        upstream: { enabled: false, type: 'socks5', host: '127.0.0.1', port: 1080, username: '', password: '' },
        systemProxy: { enabled: false },
        adblock: { enabled: true, customBlocked: [] },
        appearance: { theme: 'neon', opacity: 78, aurora: true },
        update: { manifestUrl: DEFAULT_URL, autoCheck: true, lastCheck: null },
        app: { autoStart: false, minimizeToTray: true, autoConnect: true, autoSystemProxy: true, language: 'tr' },
        diagnosticsTarget: 'discord.com',
      },
      status: {
        running: false,
        port: 7717,
        mode: 'split2',
        doh: { provider: 'cloudflare' },
        upstream: { enabled: false },
        metrics: { active: 0, bytesDown: 0, bytesUp: 0, suspiciousResets: 0, adsBlocked: 0 },
        hosts: [],
        adblock: { enabled: true, blocked: 0, counts: {}, hosts: [] },
      },
      profiles: [
        { id: 'discord', name: 'Discord', emoji: '💬', hosts: ['discord.com'] },
        { id: 'roblox', name: 'Roblox', emoji: '🧱', hosts: ['roblox.com'] },
        { id: 'all', name: 'All traffic', emoji: '🌐', hosts: [] },
      ],
      logs: [{ level: 'info', message: 'Önizleme modu: motor bağlı değil', at: Date.now() }],
      systemProxy: { applied: false },
      update: {
        phase: 'up-to-date',
        currentVersion: '1.0.2',
        latest: null,
        notes: '',
        progress: { received: 0, total: 0, percent: 0 },
        error: null,
      },
      platform: 'linux',
      version: '1.0.2',
    };
    const emit = (kind) => (cb) => {
      listeners[kind].push(cb);
      return () => {};
    };
    return {
      getState: async () => mock,
      start: async () => ({ ok: true, status: { ...mock.status, running: true } }),
      stop: async () => ({ ok: true, status: { ...mock.status, running: false } }),
      toggle: async (running) => {
        mock.status.running = Boolean(running);
        mock.status.metrics.active = running ? 3 : 0;
        return { ok: true, status: { ...mock.status } };
      },
      patchSettings: async (partial) => {
        mock.settings = {
          ...mock.settings,
          ...Object.fromEntries(
            Object.entries(partial).map(([k, v]) => [
              k,
              v && typeof v === 'object' && !Array.isArray(v) ? { ...mock.settings[k], ...v } : v,
            ]),
          ),
        };
        return { ok: true, settings: mock.settings, allowlist: ['discord.com'] };
      },
      setProfile: async (id) => ({ ok: true, allowlist: ['discord.com'] }),
      setSystemProxy: async (enabled) => ({ ok: true, systemProxy: { applied: enabled } }),
      diagnose: async () => ({
        ok: true,
        report: {
          host: 'discord.com',
          dns: { ok: true, ips: ['162.159.128.233'], ms: 42, error: null },
          direct: { ok: false, ms: 0, error: 'ECONNRESET', protocol: null },
          secured: { ok: true, ms: 168, protocol: 'TLSv1.3' },
          verdict: 'bypassed',
          notes: ['Preview data: direct connect was blocked, ZelixSec opened it.'],
        },
      }),
      checkUpdate: async () => ({
        ok: true,
        status: { ...mock.update, phase: 'up-to-date', checkedAt: new Date().toISOString() },
      }),
      installUpdate: async () => ({ ok: false, error: 'Preview mode' }),
      clearAdBlock: async () => {
        mock.status.adblock.blocked = 0;
        mock.status.metrics.adsBlocked = 0;
        mock.status.adblock.hosts = [];
        return { ok: true };
      },
      testAdBlock: async () => ({ ok: true, blocked: true, detail: 'preview' }),
      clearLogs: async () => ({ ok: true }),
      exportLogs: async () => ({ ok: true }),
      flushDns: async () => ({ ok: true }),
      copy: async () => ({ ok: true }),
      openExternal: async () => ({ ok: true }),
      quit: async () => ({ ok: true }),
      hide: async () => ({ ok: true }),
      onLog: emit('log'),
      onStatus: emit('status'),
      onSplit: emit('split'),
      onSettings: emit('settings'),
      onUpdateStatus: emit('updateStatus'),
      onUpdateProgress: emit('updateProgress'),
    };
  }

  document.addEventListener('DOMContentLoaded', boot);
})();