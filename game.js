(function(global) {
  'use strict';

  const STARTING_CHIPS    = 1000;
  const INITIAL_BIG_BLIND = 10;
  const MAX_SEATS         = 5;   // ← ИСПРАВЛЕНО: 5 мест (было 6)
  const PHASE = { PRE_FLOP: 0, FLOP: 1, TURN: 2, RIVER: 3, SHOWDOWN: 4 };
  const PHASE_NAMES = ['Пре-флоп', 'Флоп', 'Тёрн', 'Ривер', 'Вскрытие'];

  const TABLES_CONFIG = [
    { id: 'table_1', name: 'Стол №1 — Новичок',  bigBlind: 10,  minBuy: 100,  maxBuy: 500  },
    { id: 'table_2', name: 'Стол №2 — Любитель', bigBlind: 25,  minBuy: 250,  maxBuy: 1500 },
    { id: 'table_3', name: 'Стол №3 — Профи',    bigBlind: 100, minBuy: 1000, maxBuy: 5000 },
  ];

  let myPlayerId       = null;
  let myName           = 'Игрок';
  let myChips          = STARTING_CHIPS;
  let currentTableId   = null;
  let mySeatIdx        = -1;
  let state            = null;
  let syncTimer        = null;
  let fbUnsubscribe    = null;
  let lobbyUnsubscribe = null;

  let settings = {
    musicVolume: 0.5,
    sfxVolume:   0.7,
    animations:  true,
  };

  let playerData = {
    chips:       STARTING_CHIPS,
    totalGames:  0,
    totalWins:   0,
    maxWin:      0,
    achievements:{},
    dailyReward: { lastClaim: 0, streak: 0 },
    stats: { handsWon: 0, handsPlayed: 0, biggestPot: 0 }
  };

  // ─── Звук ────────────────────────────────────────────────────
  const AudioManager = (() => {
    let ctx = null;
    function init() { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){} }
    function playTone(freq, duration, type='sine', volume=0.3) {
      if (!ctx || settings.sfxVolume === 0) return;
      try {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type; osc.frequency.value = freq;
        gain.gain.setValueAtTime(settings.sfxVolume * volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + duration);
      } catch(e) {}
    }
    function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }
    return {
      init, resume,
      card:  () => playTone(880, 0.08, 'triangle', 0.4),
      chips: () => playTone(660, 0.15, 'sine', 0.5),
      win:   () => { playTone(523,0.2); setTimeout(()=>playTone(659,0.2),150); setTimeout(()=>playTone(784,0.4),300); },
      fold:  () => playTone(330, 0.2, 'sawtooth', 0.3),
      click: () => playTone(440, 0.05, 'triangle', 0.3),
      deal:  () => { for(let i=0;i<3;i++) setTimeout(()=>playTone(700+i*80,0.07,'triangle'),i*120); }
    };
  })();

  // ─── Яндекс SDK ─────────────────────────────────────────────
  const YandexSDK = (() => {
    let ysdk=null, player=null, leaderboard=null, adShowing=false;
    async function init() {
      try {
        if (typeof YaGames === 'undefined') return false;
        if (window.self === window.top && !location.hostname.includes('yandex')) {
          console.log('Режим разработки: SDK Яндекса пропущен');
          return false;
        }
        const sdkInit = Promise.race([
          YaGames.init().catch(err => { console.warn("YaGames.init отклонен:", err); return null; }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SDK timeout')), 3000))
        ]);
        ysdk = await sdkInit;
        if (!ysdk) return false;
        player = await ysdk.getPlayer({ scopes: false }).catch(() => null);
        try { leaderboard = await ysdk.getLeaderboards(); } catch(e) {}
        return true;
      } catch(e) { console.warn("Не удалось инициализировать Яндекс SDK:", e.message); return false; }
    }
    async function loadData() {
      if (!player) return null;
      try { const d = await player.getData(['gameData']); return d.gameData || null; } catch(e){ return null; }
    }
    async function saveData(data) {
      if (!player) return;
      try { await player.setData({ gameData: data }, true); } catch(e) {}
    }
    async function submitScore(score) {
      if (!leaderboard) return;
      try { await leaderboard.setLeaderboardScore('mainLeaderboard', score); } catch(e) {}
    }
    async function getLeaderboardEntries() {
      if (!leaderboard) return [];
      try { const r = await leaderboard.getLeaderboardEntries('mainLeaderboard',{quantityTop:10}); return r.entries||[]; } catch(e){ return []; }
    }
    function showAd(type='fullscreen') {
      if (!ysdk || adShowing) return Promise.resolve();
      adShowing = true;
      const overlay = document.getElementById('pauseOverlay');
      if (overlay) overlay.classList.remove('hidden');
      return new Promise(resolve => {
        const done = () => {
          adShowing = false;
          if (overlay) overlay.classList.add('hidden');
          resolve();
        };
        const cb = { onClose: done, onError: done };
        try {
          if (type === 'rewarded') ysdk.adv.showRewardedVideo(cb);
          else ysdk.adv.showFullscreenAdv({ callbacks: cb });
        } catch(e) { done(); }
      });
    }
    function getPlayerName() { if (!player) return null; return player.getName()||null; }
    function getPlayerId() { if (!player) return null; try { return player.getUniqueID()||null; } catch(e){ return null; } }
    return { init, loadData, saveData, submitScore, getLeaderboardEntries, showAd, getPlayerName, getPlayerId };
  })();

  // ─── Локальный лидерборд (фоллбэк для dev-режима) ──────────
  const LocalLeaderboard = {
    KEY: 'poker_local_leaderboard_v1',

    load() {
      try { return JSON.parse(localStorage.getItem(this.KEY) || '{}'); }
      catch(e) { return {}; }
    },

    save(data) {
      try { localStorage.setItem(this.KEY, JSON.stringify(data)); }
      catch(e) {}
    },

    submit(playerId, name, score, wonThisHand) {
      if (!playerId) return;
      const data = this.load();
      const cur = data[playerId] || { name: name || 'Игрок', score: 0, wins: 0, hands: 0, lastSeen: 0 };
      data[playerId] = {
        name:       name || cur.name,
        score:      Math.max(Number(cur.score) || 0, Number(score) || 0),
        wins:       (Number(cur.wins)  || 0) + (wonThisHand ? 1 : 0),
        hands:      (Number(cur.hands) || 0) + 1,
        lastSeen:   Date.now()
      };
      this.save(data);
    },

    getTop(n = 10) {
      const data = this.load();
      return Object.entries(data)
        .map(([id, p]) => ({ id, ...p }))
        .sort((a, b) => (b.score - a.score) || (b.wins - a.wins))
        .slice(0, n);
    },

    clear() {
      try { localStorage.removeItem(this.KEY); } catch(e) {}
    }
  };

  // ─── Firebase ──────────────────────────────────────────────
  const FIREBASE_DB_URL = 'https://poker-14ab8-default-rtdb.firebaseio.com/';
  const FirebaseDB = (() => {
    const base = FIREBASE_DB_URL.replace(/\/$/, '');
    async function get(path) {
      try {
        const url = `${base}/${path}.json?t=${Date.now()}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
      } catch(e) { return null; }
    }
    async function set(path, data) {
      try {
        await fetch(`${base}/${path}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
      } catch(e) {}
    }
    async function update(path, data) {
      try {
        await fetch(`${base}/${path}.json`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
      } catch(e) {}
    }
    function subscribe(path, callback) {
      let stopped = false;
      let lastDataStr = null;
      async function poll() {
        while (!stopped) {
          try {
            const url = `${base}/${path}.json?t=${Date.now()}`;
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) { await sleep(2000); continue; }
            const data = await res.json();
            const dataStr = JSON.stringify(data);
            if (dataStr !== lastDataStr) {
              lastDataStr = dataStr;
              if (!stopped) callback(data);
            }
          } catch(e) { console.error("Firebase sync error:", e); }
          await sleep(1000);
        }
      }
      poll();
      return () => { stopped = true; };
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    return { get, set, update, subscribe };
  })();

  // ─── TableStore ─────────────────────────────────────────────
  function isSeatFree(seat) {
    return !seat || seat.playerId === null || seat.playerId === undefined;
  }

  function normalizeSeats(seats) {
    const result = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      let s = Array.isArray(seats) ? seats[i] : (seats && seats[i]) || (seats && seats[String(i)]);
      if (!s) {
        s = { seatIdx: i, playerId: null, name: null, chips: 0, holeCards: [], currentBet: 0, totalBet: 0, folded: false, isAllIn: false, isDealer: false, ready: false };
      }
      result.push(s);
    }
    return result;
  }

  function normalizeTable(t, tableId) {
    if (!t) return t;
    t.seats = normalizeSeats(t.seats);
    const cfg = TABLES_CONFIG.find(c => c.id === tableId);
    if (cfg) {
      if (t.smallBlind === undefined || t.smallBlind === null) t.smallBlind = Math.floor(cfg.bigBlind / 2);
      if (t.bigBlind === undefined || t.bigBlind === null) t.bigBlind = cfg.bigBlind;
      if (t.minBuy === undefined) t.minBuy = cfg.minBuy;
      if (t.maxBuy === undefined) t.maxBuy = cfg.maxBuy;
    }
    if (t.phase === undefined) t.phase = PHASE.PRE_FLOP;
    if (!t.communityCards) t.communityCards = [];
    if (t.pot === undefined) t.pot = 0;
    if (t.currentSeat === undefined) t.currentSeat = -1;
    if (t.dealerSeat === undefined) t.dealerSeat = -1;
    if (t.smallBlindSeat === undefined) t.smallBlindSeat = -1;
    if (t.bigBlindSeat === undefined) t.bigBlindSeat = -1;
    if (t.callAmount === undefined) t.callAmount = 0;
    if (t.lastRaiser === undefined) t.lastRaiser = -1;
    if (!t.roundActed) t.roundActed = [];
    if (t.bbSeatIdx === undefined) t.bbSeatIdx = -1;
    if (t.handNumber === undefined) t.handNumber = 0;
    if (!t.winners) t.winners = [];
    if (!t.winningCards) t.winningCards = [];
    if (t.gameStarted === undefined) t.gameStarted = false;
    if (!t.deck) t.deck = [];
    if (t.updatedAt === undefined) t.updatedAt = Date.now();
    return t;
  }

  const TableStore = {
    _cache: {},
    _defaultTable(tableId) {
      const cfg = TABLES_CONFIG.find(t => t.id === tableId);
      return {
        id: tableId,
        name: cfg.name,
        bigBlind: cfg.bigBlind,
        smallBlind: Math.floor(cfg.bigBlind / 2),
        minBuy: cfg.minBuy,
        maxBuy: cfg.maxBuy,
        phase: PHASE.PRE_FLOP,
        communityCards: [],
        pot: 0,
        seats: Array.from({length: MAX_SEATS}, (_, i) => ({
          seatIdx: i,
          playerId: null,
          name: null,
          chips: 0,
          holeCards: [],
          currentBet: 0,
          totalBet: 0,
          folded: false,
          isAllIn: false,
          isDealer: false,
          ready: false,
        })),
        currentSeat: -1,
        dealerSeat: -1,
        smallBlindSeat: -1,
        bigBlindSeat: -1,
        callAmount: 0,
        lastRaiser: -1,
        roundActed: [],
        bbSeatIdx: -1,
        handNumber: 0,
        winners: [],
        winningCards: [],
        gameStarted: false,
        deck: [],
        updatedAt: Date.now(),
      };
    },
    async getTable(tableId) {
      let data = await FirebaseDB.get(`tables/${tableId}`);
      if (data) { data = normalizeTable(data, tableId); this._cache[tableId] = data; return data; }
      return this._cache[tableId] || null;
    },
    getTableSync(tableId) { return this._cache[tableId] || null; },
    async saveTable(tableId, data) {
      data = normalizeTable(data, tableId);
      this._cache[tableId] = data;
      await FirebaseDB.set(`tables/${tableId}`, data);
    },
    async getOrInit(tableId) {
      const existing = await this.getTable(tableId);
      if (existing) return existing;
      const fresh = this._defaultTable(tableId);
      await this.saveTable(tableId, fresh);
      return fresh;
    },
    getOrInitSync(tableId) {
      if (!this._cache[tableId]) this._cache[tableId] = this._defaultTable(tableId);
      return this._cache[tableId];
    },
    async joinTable(tableId, playerId, playerName, buyIn, desiredSeat = null) {
      let t = await this.getTable(tableId);
      if (!t) t = await this.getOrInit(tableId);
      const existing = t.seats.findIndex(s => s.playerId === playerId);
      if (existing !== -1) return existing;
      const free = desiredSeat !== null
        ? (isSeatFree(t.seats[desiredSeat]) ? desiredSeat : -1)
        : t.seats.findIndex(s => isSeatFree(s));
      if (free === -1) return -1;
      const freshSeat = await FirebaseDB.get(`tables/${tableId}/seats/${free}`);
      if (!isSeatFree(freshSeat)) {
        if (desiredSeat !== null) return -1;
        const t2 = await this.getTable(tableId);
        const free2 = t2.seats.findIndex(s => isSeatFree(s));
        if (free2 === -1) return -1;
        return this._takeSeat(tableId, t2, free2, playerId, playerName, buyIn);
      }
      return this._takeSeat(tableId, t, free, playerId, playerName, buyIn);
    },
    async _takeSeat(tableId, t, seatIdx, playerId, playerName, buyIn) {
      const seatData = {
        seatIdx, playerId, name: playerName, chips: buyIn,
        holeCards: [], currentBet: 0, totalBet: 0,
        folded: false, isAllIn: false, isDealer: false, ready: true,
      };
      await FirebaseDB.set(`tables/${tableId}/seats/${seatIdx}`, seatData);
      t.seats[seatIdx] = seatData;
      t.updatedAt = Date.now();
      this._cache[tableId] = t;
      await FirebaseDB.update(`tables/${tableId}`, { updatedAt: t.updatedAt });
      return seatIdx;
    },
    async leaveTable(tableId, playerId) {
      const t = await this.getTable(tableId);
      if (!t) return;
      const seat = t.seats.findIndex(s => s.playerId === playerId);
      if (seat === -1) return;
      const emptySeat = {
        seatIdx: seat, playerId: null, name: null, chips: 0,
        holeCards: [], currentBet: 0, totalBet: 0,
        folded: false, isAllIn: false, isDealer: false, ready: false,
      };
      await FirebaseDB.set(`tables/${tableId}/seats/${seat}`, emptySeat);
      t.seats[seat] = emptySeat;
      t.updatedAt = Date.now();
      this._cache[tableId] = t;
      await FirebaseDB.update(`tables/${tableId}`, { updatedAt: t.updatedAt });
    },
    async preloadAll() {
      for (const cfg of TABLES_CONFIG) {
        let data = await FirebaseDB.get(`tables/${cfg.id}`);
        if (data) { data = normalizeTable(data, cfg.id); this._cache[cfg.id] = data; }
        else { this._cache[cfg.id] = this._defaultTable(cfg.id); }
      }
    }
  };

  // ─── ScreenManager ──────────────────────────────────────────
  const ScreenManager = (() => {
    function show(id) {
      document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.classList.add('hidden'); });
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('hidden');
      requestAnimationFrame(() => el.classList.add('active'));
    }
    return { show };
  })();

  // ─── UI ──────────────────────────────────────────────────────
  const UI = {
    notify(msg, duration=2500) {
      const el = document.getElementById('notification');
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('hidden');
      el.classList.add('show');
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.classList.remove('show'); setTimeout(()=>el.classList.add('hidden'),400); }, duration);
    },
    cardHTML(card, hidden=false, highlight=false) {
      if (hidden) return `<div class="card card-back blue"><div class="card-inner"></div></div>`;
      const isRed = card.suit==='♥'||card.suit==='♦';
      return `<div class="card ${isRed?'red':'black'} ${highlight?'highlighted':''} animate-deal">
        <div class="card-corner top"><span class="rank">${card.rank}</span><span class="suit">${card.suit}</span></div>
        <div class="card-center">${card.suit}</div>
        <div class="card-corner bottom"><span class="rank">${card.rank}</span><span class="suit">${card.suit}</span></div>
      </div>`;
    },
  };

  // ─── Рендер лобби ────────────────────────────────────────────
  function renderLobby() {
    const container = document.getElementById('lobbyTablesList');
    if (!container) return;
    let html = '';
    TABLES_CONFIG.forEach(cfg => {
      const t = TableStore.getOrInitSync(cfg.id);
      const occupied = t.seats.filter(s => !isSeatFree(s)).length;
      const isMine = t.seats.some(s => s.playerId === myPlayerId);
      html += `<div class="lobby-table-card ${isMine ? 'mine' : ''}">
        <div class="lobby-table-header">
          <span class="lobby-table-name">${cfg.name}</span>
          <span class="lobby-table-players">${occupied}/${MAX_SEATS} игроков</span>
        </div>
        <div class="lobby-table-info">
          <span class="lobby-info-item">🎰 Блайнды: ${cfg.bigBlind/2}/${cfg.bigBlind}</span>
          <span class="lobby-info-item">💰 Бай-ин: ${cfg.minBuy}–${cfg.maxBuy}</span>
        </div>
        <div class="lobby-seats-preview">
          ${t.seats.map((s,i) => `
            <div class="lobby-seat-dot ${s.playerId ? (s.playerId===myPlayerId?'me':'taken') : 'free'}">
              ${s.playerId ? (s.playerId===myPlayerId?'👤':'🎩') : '⭕'}
            </div>`).join('')}
        </div>
        <button class="btn ${isMine?'btn-primary':'btn-secondary'} lobby-join-btn"
          onclick="PokerGame.joinTable('${cfg.id}')">
          ${isMine ? '→ Вернуться' : (occupied >= MAX_SEATS ? '🚫 Занято' : '→ Войти')}
        </button>
      </div>`;
    });
    container.innerHTML = html;
    const chipsEl = document.getElementById('playerChipsMenu');
    if (chipsEl) chipsEl.textContent = `${getTotalChips()} 🪙`;
    const nameEl = document.getElementById('playerNameMenu');
    if (nameEl) nameEl.textContent = myName;
  }

  async function refreshLobbyFromFirebase() {
    await TableStore.preloadAll();
    renderLobby();
  }

  function startLobbySync() {
    stopLobbySync();
    lobbyUnsubscribe = FirebaseDB.subscribe('tables', (data) => {
      if (!data) return;
      let changed = false;
      for (const cfg of TABLES_CONFIG) {
        if (data[cfg.id]) {
          const normalized = normalizeTable(data[cfg.id], cfg.id);
          const cached = TableStore._cache[cfg.id];
          if (!cached || JSON.stringify(cached) !== JSON.stringify(normalized)) {
            TableStore._cache[cfg.id] = normalized;
            changed = true;
          }
        }
      }
      if (changed && currentTableId === null) renderLobby();
    });
  }

  function stopLobbySync() {
    if (lobbyUnsubscribe) { lobbyUnsubscribe(); lobbyUnsubscribe = null; }
  }

  // ─── Вход и выход ──────────────────────────────────────────
  async function joinTable(tableId) {
    AudioManager.click();
    const cfg = TABLES_CONFIG.find(t => t.id === tableId);
    if (!cfg) return;
    const t = await TableStore.getOrInit(tableId);
    const existingSeat = t.seats.findIndex(s => s.playerId === myPlayerId);
    if (existingSeat !== -1) {
      currentTableId = tableId;
      mySeatIdx = existingSeat;
      enterGame(tableId);
      return;
    }
    const occupied = t.seats.filter(s => !isSeatFree(s)).length;
    if (occupied >= MAX_SEATS) { UI.notify('Все места заняты'); return; }
    if (playerData.chips < cfg.minBuy) { UI.notify(`Недостаточно фишек! Минимум: ${cfg.minBuy} 🪙`); return; }
    currentTableId = tableId;
    mySeatIdx = -1;
    enterGame(tableId);
    UI.notify('Выберите свободное место');
  }

  function showBuyInDialog(cfg, desiredSeat = null) {
    console.log('showBuyInDialog вызван', cfg, desiredSeat);
    const overlay = document.getElementById('buyinOverlay');
    const title   = document.getElementById('buyinTableName');
    const slider  = document.getElementById('buyinSlider');
    const valEl   = document.getElementById('buyinValue');
    const minEl   = document.getElementById('buyinMin');
    const maxEl   = document.getElementById('buyinMax');
    if (!overlay) {
      console.error('buyinOverlay не найден');
      return;
    }
    const actualMax = Math.min(cfg.maxBuy, playerData.chips);
    const actualMin = cfg.minBuy;
    if (title)  title.textContent  = cfg.name;
    if (minEl)  minEl.textContent  = actualMin;
    if (maxEl)  maxEl.textContent  = actualMax;
    if (slider) {
      slider.min   = actualMin;
      slider.max   = actualMax;
      slider.value = Math.min(Math.floor((actualMin + actualMax) / 2), actualMax);
      slider.oninput = () => { if (valEl) valEl.textContent = slider.value; };
    }
    if (valEl) valEl.textContent = slider ? slider.value : actualMin;
    overlay.classList.remove('hidden');

    document.getElementById('buyinConfirm').onclick = async () => {
      const amount = slider ? parseInt(slider.value) : actualMin;
      overlay.classList.add('hidden');
      await doJoinTable(cfg.id, amount, desiredSeat);
    };
    document.getElementById('buyinCancel').onclick = () => {
      overlay.classList.add('hidden');
    };
  }

  async function doJoinTable(tableId, buyIn, desiredSeat = null) {
    const seat = await TableStore.joinTable(tableId, myPlayerId, myName, buyIn, desiredSeat);
    if (seat === -1) {
      UI.notify(desiredSeat !== null ? 'Место занято, выберите другое' : 'Все места заняты!');
      if (desiredSeat !== null) renderGameTable();
      return;
    }
    playerData.chips -= buyIn;
    currentTableId = tableId;
    mySeatIdx = seat;
    saveProgress();
    enterGame(tableId);
  }

  function enterGame(tableId) {
    stopLobbySync();
    ScreenManager.show('gameScreen');
    state = TableStore.getTableSync(tableId);
    renderGameTable();
    startSync();
    checkStartCondition();
  }

  function checkStartCondition() {
    if (!state) return;
    const occupied = state.seats.filter(s => !isSeatFree(s));
    if (occupied.length >= 2 && !state.gameStarted) {
      const startBtn = document.getElementById('btnStartHand');
      if (startBtn) startBtn.classList.remove('hidden');
    }
  }

  // ─── Синхронизация ──────────────────────────────────────────
  function startSync() {
    stopSync();
    if (!currentTableId) return;
    fbUnsubscribe = FirebaseDB.subscribe(`tables/${currentTableId}`, (data) => {
      if (!data) return;
      data = normalizeTable(data, currentTableId);
      if (!state || JSON.stringify(state) !== JSON.stringify(data)) {
        TableStore._cache[currentTableId] = data;
        state = data;
        renderGameTable();
      }
    });
  }

  function stopSync() {
    if (fbUnsubscribe) { fbUnsubscribe(); fbUnsubscribe = null; }
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }

  async function saveTableState() {
    if (!currentTableId || !state) return;
    state.updatedAt = Date.now();
    await TableStore.saveTable(currentTableId, state);
  }

  // ─── Игровой стол ─────────────────────────────────────────────
  function renderGameTable() {
    if (!state) return;
    renderCommunityCards();
    renderPot();
    renderSeats();
    renderControls();
    renderInfo();
    syncNextHandCountdown();
    // Шапка главного меню (если она видна) тоже должна показывать актуальные фишки
    // на случай, если мы сидим за столом и открыли «Назад» в лобби.
    const chipsEl = document.getElementById('playerChipsMenu');
    if (chipsEl) chipsEl.textContent = `${getTotalChips()} 🪙`;
  }

  function syncNextHandCountdown() {
    if (state && state.handEndsAt && state.handEndsAt > Date.now()) {
      if (!nextHandTimerInterval) startNextHandCountdown();
    } else {
      stopNextHandCountdown();
    }
  }

  function renderCommunityCards() {
    const el = document.getElementById('communityCards');
    if (!el) return;
    const cc = state.communityCards || [];
    const winCards = state.winningCards || [];
    let html = '';
    for (let i = 0; i < 5; i++) {
      if (i < cc.length) {
        const hl = winCards.some(c => c.id === cc[i].id);
        html += UI.cardHTML(cc[i], false, hl);
      } else {
        html += `<div class="card card-placeholder"></div>`;
      }
    }
    el.innerHTML = html;
  }

  function renderPot() {
    const potEl = document.getElementById('potDisplay');
    if (potEl) potEl.textContent = `Банк: ${state.pot||0} 🪙`;
    const phaseEl = document.getElementById('phaseDisplay');
    if (phaseEl) phaseEl.textContent = state.gameStarted ? (PHASE_NAMES[state.phase]||'') : 'Ожидание игроков';
    const blindEl = document.getElementById('blindsDisplay');
    if (blindEl) {
      const sb = state.smallBlind !== undefined ? state.smallBlind : '?';
      const bb = state.bigBlind   !== undefined ? state.bigBlind   : '?';
      blindEl.textContent = `Блайнды: ${sb}/${bb}`;
    }
  }

  function renderSeats() {
    for (let i = 0; i < MAX_SEATS; i++) {
      const el = document.getElementById(`player-${i}`);
      if (!el) continue;
      const seat = state.seats[i];
      const isMe = seat.playerId === myPlayerId;
      const isCurrent = state.currentSeat === i;

      if (!seat.playerId) {
        el.className = 'player-seat empty-seat';
        el.dataset.idx = i;
        el.innerHTML = `
          <div class="empty-seat-inner">
            <div class="empty-seat-icon">+</div>
            <div class="empty-seat-label">Свободно</div>
          </div>`;
      } else {
        el.className = `player-seat ${seat.folded?'folded':''} ${seat.isAllIn?'allin':''} ${isCurrent?'active':''} ${isMe?'is-me':''}`;
        const dealerBadge = seat.isDealer ? ' <span class="dealer-btn">D</span>' : '';
        const sbBadge = state.smallBlindSeat===i ? ' <span class="blind-badge">SB</span>' : '';
        const bbBadge = state.bigBlindSeat===i   ? ' <span class="blind-badge">BB</span>' : '';
        const winBadge = (state.winners||[]).includes(i) ? '<div class="win-badge">★</div>' : '<div class="win-badge hidden">★</div>';
        const showCards = isMe || (state.phase===PHASE.SHOWDOWN && !seat.folded);
        let cardsHtml = '';
        (seat.holeCards||[]).forEach(c => {
          const hl = state.phase===PHASE.SHOWDOWN && (state.winningCards||[]).some(w=>w.id===c.id);
          cardsHtml += UI.cardHTML(c, !showCards, hl);
        });
        const handName = seat.hand ? (isMe||state.phase===PHASE.SHOWDOWN ? seat.hand.name : '') : '';
        const turnIndicator = isCurrent ? '<div class="turn-indicator">●</div>' : '';
        el.innerHTML = `
          <div style="position:relative">
            <div class="player-avatar-ring">${isMe?'👤':'🎩'}</div>
            ${winBadge}
            ${turnIndicator}
          </div>
          <div class="player-info-compact">
            <div class="player-name">${seat.name || 'Игрок'}${dealerBadge}${sbBadge}${bbBadge}</div>
            <div class="player-chips">${seat.chips} 🪙</div>
            <div class="player-bet">${seat.currentBet>0?`Ставка: ${seat.currentBet}`:''}</div>
          </div>
          <div class="player-cards">${cardsHtml}</div>
          <div class="player-hand-name">${handName}</div>`;
      }
    }
  }

  function renderControls() {
    const mySeat = mySeatIdx !== -1 ? state.seats[mySeatIdx] : null;
    const isMyTurn = state.gameStarted && state.currentSeat === mySeatIdx && mySeat && !mySeat.folded && !mySeat.isAllIn && state.phase !== PHASE.SHOWDOWN;

    const startBtn = document.getElementById('btnStartHand');
    const occupied = state.seats.filter(s => !isSeatFree(s));
    const canStart = occupied.length >= 2 && !state.gameStarted;
    if (startBtn) startBtn.classList.toggle('hidden', !canStart);

    const toCall = mySeat ? Math.max(0, state.callAmount - mySeat.currentBet) : 0;
    const canCheck = toCall === 0;

    document.getElementById('btnFold')  ?.classList.toggle('hidden', !isMyTurn);
    document.getElementById('btnCheck') ?.classList.toggle('hidden', !isMyTurn || !canCheck);
    document.getElementById('btnCall')  ?.classList.toggle('hidden', !isMyTurn || canCheck);
    document.getElementById('btnBet')   ?.classList.toggle('hidden', !isMyTurn || !canCheck);
    document.getElementById('btnRaise') ?.classList.toggle('hidden', !isMyTurn || canCheck);
    document.getElementById('btnAllIn') ?.classList.toggle('hidden', !isMyTurn);

    const callEl = document.getElementById('btnCall');
    if (callEl) callEl.textContent = toCall > 0 ? `📞 Колл (${toCall} 🪙)` : `📞 Колл`;

    const betSlider = document.getElementById('betSlider');
    const betValue  = document.getElementById('betValue');
    if (betSlider && isMyTurn && mySeat) {
      const min = state.bigBlind || 10;
      const max = mySeat.chips;
      betSlider.min = min;
      betSlider.max = max;
      if (Number(betSlider.value) < min || Number(betSlider.value) > max) betSlider.value = Math.min(min*2, max);
      if (betValue) betValue.textContent = betSlider.value;
    }
    const leaveBtn = document.getElementById('btnLeaveTable');
    if (leaveBtn) leaveBtn.classList.remove('hidden');
  }

  function renderInfo() {
    const el = document.getElementById('handCount');
    if (el) el.textContent = state.gameStarted ? `Раздача #${state.handNumber}` : 'Лобби';
  }

  // ─── Действия игрока ──────────────────────────────────────────
  async function takeSeat(seatIdx) {
    console.log('takeSeat вызван для места', seatIdx);
    if (mySeatIdx !== -1) {
      UI.notify('Вы уже сидите за этим столом');
      return;
    }
    if (!currentTableId) {
      UI.notify('Сначала войдите за стол');
      console.error('currentTableId не задан!');
      return;
    }
    const t = await TableStore.getTable(currentTableId);
    if (!t) {
      UI.notify('Стол не найден');
      console.error('Стол не найден для id:', currentTableId);
      return;
    }
    if (!isSeatFree(t.seats[seatIdx])) {
      UI.notify('Это место занято');
      console.log('Место', seatIdx, 'занято');
      return;
    }
    const cfg = TABLES_CONFIG.find(c => c.id === currentTableId);
    if (!cfg) {
      UI.notify('Конфигурация стола не найдена');
      console.error('Конфигурация не найдена для', currentTableId);
      return;
    }
    console.log('Показываем диалог для cfg', cfg, 'место', seatIdx);
    showBuyInDialog(cfg, seatIdx);
  }

  async function leaveTable() {
    if (!currentTableId || mySeatIdx === -1) {
      stopSync();
      stopNextHandCountdown();
      ScreenManager.show('mainMenu');
      await refreshLobbyFromFirebase();
      startLobbySync();
      return;
    }
    const t = await TableStore.getTable(currentTableId);
    if (t && t.seats[mySeatIdx]) {
      const remaining = t.seats[mySeatIdx].chips || 0;
      playerData.chips += remaining;
    }
    await TableStore.leaveTable(currentTableId, myPlayerId);
    if (state && state.gameStarted) {
      const fresh = await TableStore.getTable(currentTableId);
      if (fresh) {
        const stillPlaying = fresh.seats.filter(s => !isSeatFree(s));
        if (stillPlaying.length < 2) {
          fresh.gameStarted = false;
          fresh.phase = PHASE.PRE_FLOP;
          fresh.communityCards = [];
          fresh.pot = 0;
          fresh.currentSeat = -1;
          await TableStore.saveTable(currentTableId, fresh);
        }
      }
    }
    currentTableId = null;
    mySeatIdx = -1;
    state = null;
    stopSync();
    stopNextHandCountdown();
    saveProgress();
    ScreenManager.show('mainMenu');
    await refreshLobbyFromFirebase();
    startLobbySync();
  }

  // ─── Новая раздача ───────────────────────────────────────────
  async function startNewHand() {
    if (!state) return;
    const activePlayers = state.seats.filter(s => !isSeatFree(s) && s.chips > 0);
    if (activePlayers.length < 2) { UI.notify('Нужно минимум 2 игрока!'); return; }

    state.handNumber = (state.handNumber || 0) + 1;
    state.gameStarted = true;
    state.phase = PHASE.PRE_FLOP;
    state.communityCards = [];
    state.pot = 0;
    state.winners = [];
    state.winningCards = [];
    state.callAmount = state.bigBlind || 10;
    state.lastRaiser = -1;
    state.roundActed = [];
    state.bbSeatIdx = -1;
    state.handEndsAt = null;

    state.seats.forEach(s => {
      s.holeCards = [];
      s.currentBet = 0;
      s.totalBet = 0;
      s.folded = isSeatFree(s) || s.chips === 0;
      s.isAllIn = false;
      s.hand = null;
    });

    moveDealer();
    state.deck = PokerEngine.createDeck();
    dealHoleCards();
    postBlinds();

    const bbNext = nextActiveSeat(state.bigBlindSeat);
    state.currentSeat = bbNext;

    evaluateAllHands();
    await saveTableState();
    renderGameTable();
    AudioManager.deal();
  }

  function moveDealer() {
    const alive = state.seats.map((s,i) => ({s,i})).filter(({s}) => !isSeatFree(s) && s.chips > 0);
    if (alive.length === 0) return;
    let dealerIdx = state.dealerSeat;
    let nextDealer = alive.find(({i}) => i > dealerIdx) || alive[0];
    state.seats.forEach(s => s.isDealer = false);
    state.seats[nextDealer.i].isDealer = true;
    state.dealerSeat = nextDealer.i;
    state.smallBlindSeat = nextActiveSeat(nextDealer.i);
    state.bigBlindSeat   = nextActiveSeat(state.smallBlindSeat);
    state.bbSeatIdx = state.bigBlindSeat;
  }

  function dealHoleCards() {
    state.seats.forEach(s => {
      if (s.playerId && !s.folded && s.chips > 0) {
        s.holeCards = [state.deck.pop(), state.deck.pop()];
      }
    });
  }

  function postBlinds() {
    const sb = state.seats[state.smallBlindSeat];
    const bb = state.seats[state.bigBlindSeat];
    if (sb) placeBet(state.smallBlindSeat, state.smallBlind || Math.floor((state.bigBlind||10)/2));
    if (bb) placeBet(state.bigBlindSeat,   state.bigBlind || 10);
    state.callAmount = state.bigBlind || 10;
  }

  function placeBet(seatIdx, amount) {
    const s = state.seats[seatIdx];
    const actual = Math.min(amount, s.chips);
    s.chips      -= actual;
    s.currentBet += actual;
    s.totalBet   += actual;
    state.pot    += actual;
    if (s.chips === 0) s.isAllIn = true;
    AudioManager.chips();
  }

  function evaluateAllHands() {
    state.seats.forEach(s => {
      if (s.playerId && !s.folded && s.holeCards && s.holeCards.length > 0) {
        s.hand = PokerEngine.evaluateHand([...s.holeCards, ...(state.communityCards||[])]);
      }
    });
  }

  function nextActiveSeat(from) {
    let idx = (from + 1) % MAX_SEATS;
    for (let i = 0; i < MAX_SEATS; i++) {
      const s = state.seats[idx];
      if (s.playerId && !s.folded && !s.isAllIn && s.chips > 0) return idx;
      idx = (idx + 1) % MAX_SEATS;
    }
    return -1;
  }

  // ─── Действия игрока ──────────────────────────────────────────
  function humanAction(action, amount) {
    if (!state || !state.gameStarted) return;
    if (state.currentSeat !== mySeatIdx) return;
    const seat = state.seats[mySeatIdx];
    if (!seat || seat.folded || seat.isAllIn) return;
    AudioManager.resume();
    processSeatAction(mySeatIdx, action, amount);
  }

  async function processSeatAction(seatIdx, action, amount) {
    const s = state.seats[seatIdx];
    if (!s || s.folded || s.isAllIn) { advanceAction(); return; }

    if (!state.roundActed) state.roundActed = [];
    if (!state.roundActed.includes(seatIdx)) state.roundActed.push(seatIdx);

    switch (action) {
      case 'fold':
        s.folded = true;
        AudioManager.fold();
        break;
      case 'check':
        break;
      case 'call': {
        const toCall = Math.min(state.callAmount - s.currentBet, s.chips);
        placeBet(seatIdx, toCall);
        break;
      }
      case 'bet':
      case 'raise': {
        const raiseAmt = Math.max(amount || state.bigBlind || 10, state.bigBlind || 10);
        const actual   = Math.min(raiseAmt, s.chips);
        placeBet(seatIdx, actual);
        state.callAmount = s.currentBet;
        state.lastRaiser = seatIdx;
        state.roundActed = [seatIdx];
        break;
      }
      case 'allin': {
        const allinAmt = s.chips;
        if (allinAmt + s.currentBet > state.callAmount) {
          state.callAmount = allinAmt + s.currentBet;
          state.lastRaiser = seatIdx;
          state.roundActed = [seatIdx];
        }
        placeBet(seatIdx, allinAmt);
        break;
      }
    }

    evaluateAllHands();
    await saveTableState();
    renderGameTable();
    advanceAction();
  }

  async function advanceAction() {
    const activePlayers = state.seats.filter(s => s.playerId && !s.folded && !s.isAllIn);
    const notFolded     = state.seats.filter(s => s.playerId && !s.folded);

    if (notFolded.length === 1) {
      const winnerIdx = state.seats.findIndex(s => s.playerId && !s.folded);
      awardPot([winnerIdx]);
      return;
    }

    if (activePlayers.length <= 1) {
      runOutBoard();
      return;
    }

    const next = nextActiveSeat(state.currentSeat);
    if (isBettingRoundComplete(next)) {
      nextPhase();
      return;
    }

    state.currentSeat = next;
    await saveTableState();
    renderGameTable();
  }

  function isBettingRoundComplete(nextSeat) {
    if (nextSeat === -1) return true;
    const active = state.seats.filter(s => s.playerId && !s.folded && !s.isAllIn);
    if (active.length === 0) return true;
    const allEven = active.every(s => s.currentBet === state.callAmount || s.chips === 0);
    if (!allEven) return false;
    if (state.lastRaiser !== -1) {
      return nextSeat === state.lastRaiser;
    }
    const roundActed = state.roundActed || [];
    const allActed   = active.every(s => roundActed.includes(state.seats.indexOf(s)));
    if (state.phase === PHASE.PRE_FLOP) {
      const bbActed = roundActed.includes(state.bbSeatIdx);
      return allActed && bbActed;
    }
    return allActed;
  }

  async function nextPhase() {
    state.seats.forEach(s => s.currentBet = 0);
    state.callAmount  = 0;
    state.lastRaiser  = -1;
    state.roundActed  = [];
    state.phase++;

    if (state.phase === PHASE.FLOP) {
      state.communityCards.push(state.deck.pop(), state.deck.pop(), state.deck.pop());
      AudioManager.deal();
    } else if (state.phase === PHASE.TURN || state.phase === PHASE.RIVER) {
      state.communityCards.push(state.deck.pop());
      AudioManager.card();
    } else if (state.phase === PHASE.SHOWDOWN) {
      showdown();
      return;
    }

    evaluateAllHands();
    const first = nextActiveSeat(state.dealerSeat - 1 < 0 ? MAX_SEATS - 1 : state.dealerSeat - 1);
    state.currentSeat = first;
    if (first === -1) { nextPhase(); return; }

    await saveTableState();
    renderGameTable();
  }

  async function runOutBoard() {
    while ((state.communityCards||[]).length < 5) {
      state.communityCards.push(state.deck.pop());
    }
    evaluateAllHands();
    state.phase = PHASE.SHOWDOWN;
    await saveTableState();
    renderGameTable();
    setTimeout(showdown, 800);
  }

  async function showdown() {
    state.phase = PHASE.SHOWDOWN;
    const contenders = state.seats
      .map((s, i) => ({...s, seatIdx: i}))
      .filter(s => s.playerId && !s.folded && s.holeCards && s.holeCards.length > 0);

    if (contenders.length === 0) { endHand([]); return; }

    evaluateAllHands();

    const { winners, evaluated } = PokerEngine.determineWinners(
      contenders.map(s => ({ id: s.seatIdx, holeCards: s.holeCards })),
      state.communityCards
    );

    if (winners.length > 0) {
      const best = evaluated.find(e => e.id === winners[0].id);
      state.winningCards = best ? best.hand.cards : [];
    }

    const winnerIndices = winners.map(w => w.id);
    state.winners = winnerIndices;

    evaluated.forEach(e => {
      if (state.seats[e.id]) state.seats[e.id].hand = e.hand;
    });

    await saveTableState();
    renderGameTable();

    const winnerSeat = state.seats[winnerIndices[0]];
    const combo = evaluated.find(e => e.id === winnerIndices[0])?.hand?.name || '';
    const msg = winners.length === 1
      ? `${winnerSeat?.name||'Игрок'} выигрывает банк! (${combo})`
      : `Ничья! (${combo})`;
    UI.notify(msg, 4000);
    AudioManager.win();

    awardPot(winnerIndices);
  }

  async function awardPot(winnerIndices) {
    if (!winnerIndices || winnerIndices.length === 0) return;
    const validWinners = winnerIndices.filter(i => i >= 0 && state.seats[i]);
    if (validWinners.length === 0) return;

    const share = Math.floor(state.pot / validWinners.length);
    const remainder = state.pot - share * validWinners.length;

    let iWonThisHand = false;
    let myWinAmount = 0;

    validWinners.forEach((i, idx) => {
      const winAmount = share + (idx === 0 ? remainder : 0);
      state.seats[i].chips += winAmount;
      if (state.seats[i].playerId === myPlayerId) {
        iWonThisHand = true;
        myWinAmount = winAmount;
        playerData.stats.handsWon++;
        playerData.totalWins = (playerData.totalWins || 0) + 1;
        if (winAmount > (playerData.maxWin || 0)) playerData.maxWin = winAmount;
        if (state.pot > playerData.stats.biggestPot) playerData.stats.biggestPot = state.pot;
      }
    });

    playerData.stats.handsPlayed++;
    playerData.totalGames = (playerData.totalGames || 0) + 1;

    // Синхронизируем playerData.chips с реальным остатком за столом,
    // чтобы профиль/лидерборд показывали актуальную сумму (а не устаревшую до посадки).
    if (mySeatIdx !== -1 && state.seats[mySeatIdx]) {
      const seatChips = state.seats[mySeatIdx].chips || 0;
      // playerData.chips = кошелёк (не за столом) + фишки на месте.
      // Кошелёк = playerData.chips минус то, что мы посадили, но мы не хранили «сколько посадили»,
      // поэтому безопаснее так: playerData.chips = max(0, playerData.chips) + 0 (не трогаем кошелёк)
      // + просто пересчитаем общий «доступный» кэш для отображения:
      playerData._displayChips = (playerData.chips || 0) + seatChips;
    }

    // Отправляем результат раздачи в оба лидерборда (локальный + Яндекс)
    const totalChips = (playerData.chips || 0) + (state.seats[mySeatIdx]?.chips || 0);
    try { LocalLeaderboard.submit(myPlayerId, myName, totalChips, iWonThisHand); } catch(e) {}
    try { YandexSDK.submitScore(totalChips); } catch(e) {}

    // ★ playerData.chips не трогаем здесь — обновится при выходе из-за-стола,
    // чтобы не было двойного учёта (buy-in уже списал, leaveTable вернёт остаток).

    const HAND_END_DELAY = 15000;
    state.handEndsAt = Date.now() + HAND_END_DELAY;

    await saveTableState();
    saveProgress();
    renderGameTable();
    startNextHandCountdown();

    setTimeout(() => endHand(validWinners), HAND_END_DELAY);
  }

  async function endHand(winners) {
    stopNextHandCountdown();
    state.gameStarted = false;
    state.currentSeat = -1;
    state.winners = [];
    state.winningCards = [];
    state.handEndsAt = null;

    state.seats.forEach((s, i) => {
      s.currentBet = 0;
      s.totalBet = 0;
      s.folded = isSeatFree(s) || s.chips === 0;
      s.isAllIn = false;
      s.hand = null;
      if (!winners.includes(i)) {
        s.holeCards = [];
      }
    });

    state.seats.forEach((s, i) => {
      if (s.playerId && s.chips <= 0) {
        if (s.playerId === myPlayerId) {
          UI.notify('У вас закончились фишки! Войдите снова с новым бай-ином.', 5000);
          setTimeout(async () => {
            await TableStore.leaveTable(currentTableId, myPlayerId);
            currentTableId = null;
            mySeatIdx = -1;
            state = null;
            stopSync();
            ScreenManager.show('mainMenu');
            await refreshLobbyFromFirebase();
            startLobbySync();
          }, 3000);
        }
      }
    });

    await saveTableState();
    renderGameTable();

    setTimeout(() => {
      if (state && !state.gameStarted) {
        startNewHand();
      }
    }, 15000);
  }

  // ─── Таймер обратного отсчёта ──────────────────────────────
  let nextHandTimerInterval = null;

  function startNextHandCountdown() {
    stopNextHandCountdown();
    const tick = () => {
      if (!state || !state.handEndsAt) { stopNextHandCountdown(); return; }
      const el = document.getElementById('nextHandTimer');
      const secEl = document.getElementById('nextHandSeconds');
      const remainingMs = state.handEndsAt - Date.now();
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      if (el) el.classList.toggle('hidden', remainingMs <= 0);
      if (secEl) secEl.textContent = remainingSec;
      if (remainingMs <= 0) stopNextHandCountdown();
    };
    tick();
    nextHandTimerInterval = setInterval(tick, 250);
  }

  function stopNextHandCountdown() {
    if (nextHandTimerInterval) { clearInterval(nextHandTimerInterval); nextHandTimerInterval = null; }
    const el = document.getElementById('nextHandTimer');
    if (el) el.classList.add('hidden');
  }

  // ─── Прогресс ────────────────────────────────────────────────
  async function saveProgress() {
    const data = { playerData, settings, myName };
    try { localStorage.setItem('pokerSave', JSON.stringify(data)); } catch(e) {}
    await YandexSDK.saveData(data);
  }

  async function loadProgress() {
    const remote = await YandexSDK.loadData();
    if (remote) { applyLoaded(remote); return; }
    try {
      const local = localStorage.getItem('pokerSave');
      if (local) applyLoaded(JSON.parse(local));
    } catch(e) {}
  }

  function applyLoaded(data) {
    if (data.playerData) Object.assign(playerData, data.playerData);
    if (data.settings)   Object.assign(settings,   data.settings);
    if (data.myName)     myName = data.myName;
  }

  // ─── Меню и навигация ──────────────────────────────────────
  function getTotalChips() {
    const seatChips = (currentTableId && state && mySeatIdx >= 0)
      ? (state.seats[mySeatIdx]?.chips || 0)
      : 0;
    return (playerData.chips || 0) + seatChips;
  }

  function renderMainMenu() {
    const el = document.getElementById('playerChipsMenu');
    if (el) el.textContent = `${getTotalChips()} 🪙`;
    const nameEl = document.getElementById('playerNameMenu');
    if (nameEl) nameEl.textContent = myName;
    renderLobby();
  }

  function renderStatsScreen() {
    const totalChips = getTotalChips();
    const map = {
      statGames:  playerData.totalGames   || 0,
      statWins:   playerData.totalWins    || 0,
      statWinPct: (playerData.totalGames || 0)
                    ? Math.round((playerData.totalWins || 0) / playerData.totalGames * 100) + '%'
                    : '0%',
      statMaxWin: playerData.maxWin       || 0,
      statHands:  playerData.stats.handsPlayed || 0,
      statBigPot: playerData.stats.biggestPot  || 0,
    };
    Object.entries(map).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (!el) return;
      // Вспышка, если значение реально поменялось
      const prev = el.dataset.val;
      const next = String(val);
      if (prev !== undefined && prev !== next) {
        const item = el.closest('.stat-item');
        if (item) {
          item.classList.remove('flash');
          void item.offsetWidth; // перезапуск анимации
          item.classList.add('flash');
        }
      }
      el.dataset.val = next;
      el.textContent = next;
    });
    // Обновляем имя + фишки (включая те, что сейчас на столе)
    const pName  = document.getElementById('profileName');
    const pChips = document.getElementById('profileChips');
    if (pName)  pName.textContent  = myName;
    if (pChips) pChips.textContent = totalChips + ' 🪙';
  }

  async function renderLeaderboard() {
    const el = document.getElementById('leaderboardList');
    if (!el) return;
    el.innerHTML = '<div class="loading">Загрузка...</div>';

    // 1) Пытаемся взять глобальный лидерборд из Яндекс SDK
    let entries = [];
    let source = 'yandex';
    try {
      const remote = await YandexSDK.getLeaderboardEntries();
      if (Array.isArray(remote) && remote.length > 0) {
        entries = remote.map(e => ({
          name:  e.player?.publicName || e.player?.public_name || 'Игрок',
          score: e.score || 0,
          wins:  0
        }));
      }
    } catch(e) { /* SDK недоступен — идём в локальный */ }

    // 2) Фоллбэк — локальный лидерборд
    if (entries.length === 0) {
      source = 'local';
      const local = LocalLeaderboard.getTop(20);
      // Если совсем пусто — добавим запись текущего игрока, чтобы экран не был совсем грустным
      if (local.length === 0 && myPlayerId) {
        const seatChips = state?.seats?.[mySeatIdx]?.chips || 0;
        entries = [{
          name:  myName || 'Вы',
          score: (playerData.chips || 0) + seatChips,
          wins:  0
        }];
      } else {
        // Гарантируем, что текущий игрок тоже виден в своём рейтинге
        const seatChips = state?.seats?.[mySeatIdx]?.chips || 0;
        const myTotal   = (playerData.chips || 0) + seatChips;
        const meIdx = local.findIndex(p => p.id === myPlayerId);
        if (meIdx === -1 && myPlayerId) {
          local.push({ id: myPlayerId, name: myName || 'Вы', score: myTotal, wins: 0, hands: 0, lastSeen: Date.now() });
          local.sort((a, b) => b.score - a.score);
        }
        entries = local.map(p => ({ name: p.name, score: p.score, wins: p.wins || 0 }));
      }
    }

    if (entries.length === 0) {
      el.innerHTML = '<div class="empty">Пока нет данных.<br><span style="font-size:0.75rem">Сыграйте партию — и вы здесь!</span></div>';
      return;
    }

    el.innerHTML = entries.map((e, i) => {
      const rank  = i + 1;
      const name  = String(e.name || 'Игрок').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
      const score = Number(e.score) || 0;
      return `<div class="lb-row"><span class="lb-rank">#${rank}</span><span class="lb-name">${name}</span><span class="lb-score">${score} 🪙</span></div>`;
    }).join('');

    if (source === 'local') {
      el.insertAdjacentHTML('beforeend',
        '<div class="lb-note">📱 Локальный рейтинг этого устройства.<br>Глобальный Топ доступен в <strong>Яндекс Играх</strong>.</div>'
      );
    }
  }

  // ─── Инициализация ───────────────────────────────────────────
  async function bootstrap() {
    AudioManager.init();
    await YandexSDK.init();
    await loadProgress();

    myPlayerId = YandexSDK.getPlayerId() || localStorage.getItem('poker_pid');
    if (!myPlayerId) {
      myPlayerId = 'p_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('poker_pid', myPlayerId);
    }

    const sdkName = YandexSDK.getPlayerName();
    if (sdkName) myName = sdkName;

    buildUI();

    ScreenManager.show('mainMenu');
    renderMainMenu();
    await refreshLobbyFromFirebase();
    startLobbySync();

    const loader = document.getElementById('loadingScreen');
    if (loader) { loader.style.opacity='0'; setTimeout(()=>loader.classList.add('hidden'),600); }

    const now = Date.now();
    if (now - playerData.dailyReward.lastClaim >= 86400000) {
      setTimeout(() => {
        const streak = playerData.dailyReward.streak + 1;
        const bonus  = Math.min(streak, 30) * 50;
        playerData.chips += bonus;
        playerData.dailyReward = { lastClaim: now, streak };
        saveProgress();
        UI.notify(`🎁 Ежедневная награда: +${bonus} фишек!`, 4000);
      }, 1000);
    }
  }

  function buildUI() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    on('btnPlay', async () => {
      AudioManager.click();
      ScreenManager.show('mainMenu');
      await refreshLobbyFromFirebase();
      startLobbySync();
    });

    on('btnProfile',  () => { AudioManager.click(); renderStatsScreen(); ScreenManager.show('profileScreen'); });
    on('btnShop',     () => { AudioManager.click(); ScreenManager.show('shopScreen'); });
    on('btnLeader',   () => { AudioManager.click(); renderLeaderboard(); ScreenManager.show('leaderboardScreen'); });
    on('btnSettings', () => { AudioManager.click(); loadSettingsUI(); ScreenManager.show('settingsScreen'); });
    on('btnHelp',     () => { AudioManager.click(); ScreenManager.show('helpScreen'); });
    on('btnDaily',    () => { AudioManager.click(); ScreenManager.show('dailyScreen'); });

    document.querySelectorAll('.btn-back').forEach(btn =>
      btn.addEventListener('click', () => {
        AudioManager.click();
        ScreenManager.show('mainMenu');
        renderMainMenu();
        startLobbySync();
      })
    );

    on('btnStartHand', () => { AudioManager.click(); startNewHand(); });
    on('btnFold',  () => humanAction('fold'));
    on('btnCheck', () => humanAction('check'));
    on('btnCall',  () => humanAction('call'));
    on('btnBet',   () => {
      const v = parseInt(document.getElementById('betSlider')?.value || state?.bigBlind || 10);
      humanAction('bet', v);
    });
    on('btnRaise', () => {
      const v = parseInt(document.getElementById('betSlider')?.value || 0);
      humanAction('raise', v);
    });
    on('btnAllIn', () => humanAction('allin'));
    on('btnLeaveTable', () => { AudioManager.click(); leaveTable(); });

    const slider = document.getElementById('betSlider');
    if (slider) slider.addEventListener('input', () => {
      const vEl = document.getElementById('betValue');
      if (vEl) vEl.textContent = slider.value;
    });

    on('btnChangeName', () => {
      const input = document.getElementById('nameInput');
      if (!input) return;
      const newName = input.value.trim();
      if (newName.length < 2) { UI.notify('Имя слишком короткое'); return; }
      myName = newName.slice(0, 16);
      localStorage.setItem('poker_name_set', '1');
      saveProgress();
      renderMainMenu();
      UI.notify('Имя изменено!');
    });

    on('btnSaveSettings', saveSettingsUI);
    on('btnFullscreen', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    });

    on('btnAdReward', async () => {
      await YandexSDK.showAd('rewarded');
      playerData.chips += 200;
      saveProgress();
      UI.notify('+200 фишек за просмотр рекламы!', 3000);
      renderMainMenu();
    });
  }

  function loadSettingsUI() {
    const mEl = document.getElementById('musicVol');
    const sEl = document.getElementById('sfxVol');
    const aEl = document.getElementById('toggleAnim');
    if (mEl) mEl.value = settings.musicVolume * 100;
    if (sEl) sEl.value = settings.sfxVolume   * 100;
    if (aEl) aEl.checked = settings.animations;
  }

  function saveSettingsUI() {
    const mEl = document.getElementById('musicVol');
    const sEl = document.getElementById('sfxVol');
    const aEl = document.getElementById('toggleAnim');
    if (mEl) settings.musicVolume = mEl.value / 100;
    if (sEl) settings.sfxVolume   = sEl.value / 100;
    if (aEl) settings.animations  = aEl.checked;
    saveProgress();
    UI.notify('Настройки сохранены!');
    ScreenManager.show('mainMenu');
  }

  document.addEventListener('DOMContentLoaded', bootstrap);

  global.PokerGame = {
    joinTable,
    takeSeat,
    leaveTable,
    getState: () => state,
    getPlayerData: () => playerData,
  };

})(window);