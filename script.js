/* =========================================================
   JARVIS – Personal AI Assistant · script.js
   Vanilla JavaScript, no dependencies, no build step.

   Architecture
   ------------
   1. Helpers & storage
   2. Settings
   3. Assistant service interface (pluggable AI backend)
   4. Built-in command engine (deterministic, local)
   5. Anime data & picker
   6. Chat rendering & history
   7. Speech output (speechSynthesis)
   8. Speech input (Web Speech API)
   9. UI wiring (clock, dialogs, install, offline, service worker)

   IMPORTANT: This file never contains API keys. A real AI model must
   live behind your own server; see README.md for the contract.
   ========================================================= */
(() => {
  'use strict';

  /* =======================================================
     1. Helpers & storage
     ======================================================= */
  const APP_VERSION = '1.0.0';
  const STORAGE_KEYS = { history: 'jarvis.history.v1', settings: 'jarvis.settings.v1' };
  const MAX_HISTORY = 200;
  const CONTEXT_MESSAGES = 20;
  const MAX_INPUT_CHARS = 1000;
  const REQUEST_TIMEOUT_MS = 25000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const pad2 = (n) => String(n).padStart(2, '0');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (_) {
        return false; // private mode or quota exceeded
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
    },
  };

  const els = {
    clock: $('#clock'),
    date: $('#date'),
    core: $('#core'),
    statusText: $('#status-text'),
    transcript: $('#transcript'),
    log: $('#log'),
    form: $('#composer'),
    input: $('#message-input'),
    send: $('#send-btn'),
    mic: $('#mic-btn'),
    btnAnime: $('#btn-anime'),
    btnSettings: $('#btn-settings'),
    btnClear: $('#btn-clear'),
    btnInstall: $('#btn-install'),
    chipVoiceIn: $('#chip-voice-in'),
    chipVoiceOut: $('#chip-voice-out'),
    chipNet: $('#chip-net'),
    chipAi: $('#chip-ai'),
    settingsDialog: $('#settings-dialog'),
    animeDialog: $('#anime-dialog'),
    offline: $('#offline-screen'),
    toast: $('#toast'),
    setSpeak: $('#set-speak'),
    setVoice: $('#set-voice'),
    setRate: $('#set-rate'),
    setPitch: $('#set-pitch'),
    setVolume: $('#set-volume'),
    setLang: $('#set-lang'),
    setAutoSend: $('#set-autosend'),
    setEndpoint: $('#set-endpoint'),
    endpointMsg: $('#endpoint-msg'),
    outRate: $('#out-rate'),
    outPitch: $('#out-pitch'),
    outVolume: $('#out-volume'),
    btnTestVoice: $('#btn-test-voice'),
    btnResetSettings: $('#btn-reset-settings'),
    genreChips: $('#genre-chips'),
    animeResults: $('#anime-results'),
    btnAnimeRecommend: $('#btn-anime-recommend'),
    btnAnimeRandom: $('#btn-anime-random'),
    btnOfflineRetry: $('#btn-offline-retry'),
    btnOfflineContinue: $('#btn-offline-continue'),
  };

  let toastTimer = null;
  function toast(message, ms = 3200) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  function openDialog(dialog) {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  function closeDialog(dialog) {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  /* =======================================================
     2. Settings
     ======================================================= */
  const DEFAULT_SETTINGS = {
    speakReplies: true,
    voiceURI: '',
    rate: 1,
    pitch: 1,
    volume: 1,
    recognitionLang: navigator.language || 'en-US',
    autoSend: true,
    endpoint: '',
  };

  function sanitizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
    s.speakReplies = Boolean(s.speakReplies);
    s.autoSend = Boolean(s.autoSend);
    s.voiceURI = typeof s.voiceURI === 'string' ? s.voiceURI : '';
    s.rate = clamp(Number(s.rate) || 1, 0.6, 1.5);
    s.pitch = clamp(Number(s.pitch) || 1, 0.6, 1.6);
    s.volume = clamp(Number.isFinite(Number(s.volume)) ? Number(s.volume) : 1, 0, 1);
    s.recognitionLang = typeof s.recognitionLang === 'string' && s.recognitionLang ? s.recognitionLang : 'en-US';
    try { s.endpoint = normalizeEndpoint(typeof s.endpoint === 'string' ? s.endpoint : ''); } catch (_) { s.endpoint = ''; }
    return s;
  }

  let settings = sanitizeSettings(storage.get(STORAGE_KEYS.settings, {}));
  function saveSettings() { storage.set(STORAGE_KEYS.settings, settings); }

  /** Validates and normalizes an assistant service URL. Throws Error with a user-facing message. */
  function normalizeEndpoint(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    let u;
    try { u = new URL(v); } catch (_) {
      throw new Error('Enter a full URL such as https://example.com/api/chat');
    }
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(isLocal && u.protocol === 'http:')) {
      throw new Error('Use an https:// URL (plain http is only allowed for localhost).');
    }
    if (u.username || u.password) {
      throw new Error('Do not put a username or password in the URL.');
    }
    if (/(key|token|secret|password|auth)/i.test(u.search)) {
      throw new Error('Do not put keys or tokens in the URL. Keep secrets on your server.');
    }
    return u.toString();
  }

  /* =======================================================
     3. Assistant service interface
     -------------------------------------------------------
     Contract:  service.reply({ text, messages, signal })
                  -> Promise<{ text: string, actions?: [{label,url}], spoken?: string, speak?: boolean }>
     Throw AssistantError for failures that should be shown to the user.

     To connect a real AI model, run a server that accepts the JSON
     described in README.md and enter its URL under Settings.
     Or write your own subclass of AssistantService and return it
     from getAssistantService().
     ======================================================= */
  class AssistantError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'AssistantError';
      this.code = code;
    }
  }

  class AssistantService {
    get label() { return 'Base service'; }
    get connected() { return false; }
    // eslint-disable-next-line no-unused-vars
    async reply(request) {
      throw new AssistantError('not-implemented', 'AssistantService.reply() is not implemented.');
    }
  }

  /** Used when no backend is configured. It is honest: it is NOT an AI model. */
  class NoModelService extends AssistantService {
    get label() { return 'No model'; }
    async reply() {
      return {
        text:
          'No AI model is connected to this interface yet, so I cannot hold open-ended conversations. ' +
          'I can still run built-in commands: the time and date, opening sites, searching, and anime picks. ' +
          'Say "help" for the full list, or connect your own backend under Settings (see the README).',
        speak: true,
      };
    }
  }

  /** Sends the conversation to your own server. The server holds any API keys. */
  class RemoteAssistantService extends AssistantService {
    constructor(endpoint) {
      super();
      this.endpoint = endpoint;
    }
    get label() {
      try { return new URL(this.endpoint).hostname; } catch (_) { return 'Remote'; }
    }
    get connected() { return true; }

    async reply({ messages, signal }) {
      if (!navigator.onLine) {
        throw new AssistantError('offline', 'You are offline, so I cannot reach the assistant service. Built-in commands still work.');
      }
      const ctrl = new AbortController();
      let timedOut = false;
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ messages, client: { app: 'jarvis-pwa', version: APP_VERSION } }),
          signal: ctrl.signal,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        if (!res.ok) {
          throw new AssistantError('http', 'The assistant service returned an error (HTTP ' + res.status + ').');
        }
        let data;
        try { data = await res.json(); } catch (_) {
          throw new AssistantError('format', 'The assistant service did not return valid JSON.');
        }
        const reply = data && (typeof data.reply === 'string' ? data.reply : typeof data.message === 'string' ? data.message : '');
        if (!reply || !reply.trim()) {
          throw new AssistantError('format', 'The assistant service replied without a "reply" text.');
        }
        return { text: reply.trim().slice(0, 4000), speak: true };
      } catch (err) {
        if (err instanceof AssistantError) throw err;
        if (err && err.name === 'AbortError') {
          if (timedOut) throw new AssistantError('timeout', 'The assistant service took too long to respond. Please try again.');
          throw new AssistantError('aborted', 'Request cancelled.');
        }
        throw new AssistantError('network', 'Could not reach the assistant service. Check the URL, your connection, and that the server allows requests from this site (CORS).');
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
  }

  const noModelService = new NoModelService();
  function getAssistantService() {
    return settings.endpoint ? new RemoteAssistantService(settings.endpoint) : noModelService;
  }

  /* =======================================================
     4. Built-in command engine
     ======================================================= */
  const SITES = [
    { name: 'YouTube', url: 'https://www.youtube.com/', aliases: ['youtube', 'yt', 'you tube'] },
    { name: 'Google', url: 'https://www.google.com/', aliases: ['google', 'google search'] },
    { name: 'Gmail', url: 'https://mail.google.com/', aliases: ['gmail', 'mail', 'email', 'google mail'] },
    { name: 'Google Maps', url: 'https://maps.google.com/', aliases: ['maps', 'google maps', 'map'] },
    { name: 'Google Drive', url: 'https://drive.google.com/', aliases: ['drive', 'google drive'] },
    { name: 'Google Translate', url: 'https://translate.google.com/', aliases: ['translate', 'google translate', 'translator'] },
    { name: 'Wikipedia', url: 'https://www.wikipedia.org/', aliases: ['wikipedia', 'wiki'] },
    { name: 'GitHub', url: 'https://github.com/', aliases: ['github', 'git hub'] },
    { name: 'Stack Overflow', url: 'https://stackoverflow.com/', aliases: ['stack overflow', 'stackoverflow'] },
    { name: 'Spotify', url: 'https://open.spotify.com/', aliases: ['spotify'] },
    { name: 'BBC News', url: 'https://www.bbc.com/news', aliases: ['bbc', 'bbc news', 'news'] },
    { name: 'MyAnimeList', url: 'https://myanimelist.net/', aliases: ['myanimelist', 'my anime list', 'mal'] },
    { name: 'AniList', url: 'https://anilist.co/', aliases: ['anilist', 'ani list'] },
    { name: 'Crunchyroll', url: 'https://www.crunchyroll.com/', aliases: ['crunchyroll', 'crunchy roll'] },
  ];

  const ALLOWED_HOSTS = new Set(
    SITES.map((s) => new URL(s.url).hostname).concat(['en.wikipedia.org', 'www.google.com', 'www.youtube.com', 'myanimelist.net'])
  );

  /** Only https links to hosts on the permitted list may be rendered or opened. */
  function isAllowedUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
    } catch (_) {
      return false;
    }
  }

  function openExternal(url) {
    if (!isAllowedUrl(url)) return false;
    const w = window.open(url, '_blank');
    if (w) {
      try { w.opener = null; } catch (_) { /* ignore */ }
      return true;
    }
    return false;
  }

  function findSite(spoken) {
    const cleaned = String(spoken || '')
      .toLowerCase()
      .replace(/\b(the|app|website|web site|site|page|for me|please|now)\b/g, ' ')
      .replace(/\s*dot com$/, '')
      .replace(/\.com$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    return SITES.find((s) => s.aliases.includes(cleaned)) || null;
  }

  const timeFormatShort = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const timeFormatClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const dateFormatFull = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/^(?:hey |ok |okay )?jarvis[\s,:\-]*/, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function stripWake(text) {
    return String(text || '').trim().replace(/^(?:hey |ok |okay )?jarvis[\s,:\-]*/i, '');
  }

  const HELP_TEXT =
    'Here is what I can do right now:\n' +
    '• Ask "what time is it" or "what is the date"\n' +
    '• "Open YouTube" (say "sites" for the full list)\n' +
    '• "Search <topic>" or "Search <topic> on YouTube"\n' +
    '• "Random anime" or "Recommend anime action"\n' +
    '• "Settings", "Anime", "Clear chat", "Stop"\n' +
    'Open-ended conversation needs an AI backend. See the README to connect one.';

  function greetingForHour(h) {
    if (h < 5) return 'Good evening';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  const RULES = [
    {
      test: (t) => /^(stop|be quiet|quiet|silence|stop talking|shut up|mute)$/.test(t),
      run: () => { stopSpeaking(); return { text: 'Voice output stopped.', speak: false }; },
    },
    {
      test: (t) => /^(help|commands|what can you do|menu|options)$/.test(t),
      run: () => ({ text: HELP_TEXT, spoken: 'I can tell the time, open permitted websites, search, and pick anime. The full list is on screen.' }),
    },
    {
      test: (t) => /^(sites|websites|list sites|permitted sites|show sites|what can you open)$/.test(t),
      run: () => ({
        text: 'Permitted sites:\n' + SITES.map((s) => '• ' + s.name).join('\n') + '\nSay "open" followed by a name.',
        spoken: 'The permitted sites are listed on screen. Say open, followed by a name.',
      }),
    },
    {
      test: (t) => /^(open )?settings$/.test(t),
      run: () => { openDialog(els.settingsDialog); return { text: 'Opening settings.', speak: false }; },
    },
    {
      test: (t) => /^(open )?(anime|anime picker|anime panel)$/.test(t),
      run: () => { openAnimePanel(); return { text: 'Opening the anime picker.', speak: false }; },
    },
    {
      test: (t) => /^(clear|delete|erase|reset) (the |my )?(chat|history|conversation)$/.test(t),
      run: () => { clearChat(); return null; },
    },
    {
      test: (t) => /^(hi|hello|hey|hi there|hello there|good morning|good afternoon|good evening)$/.test(t),
      run: () => ({
        text: greetingForHour(new Date().getHours()) + '. JARVIS interface online. Say "help" to see what I can do.',
      }),
    },
    {
      test: (t) => t === 'time' || /\b(what time|time now|current time|the time|time is it)\b/.test(t),
      run: () => {
        const now = new Date();
        return { text: 'It is ' + timeFormatShort.format(now) + ' on ' + dateFormatFull.format(now) + '.' };
      },
    },
    {
      test: (t) => t === 'date' || t === 'day' || t === 'today' ||
        /\b(todays date|today s date|date today|what day|which day|current date|what is the date|what s the date)\b/.test(t),
      run: () => ({ text: 'Today is ' + dateFormatFull.format(new Date()) + '.' }),
    },
    {
      test: (t) => /\b(random|surprise me with|pick (an |some )?)\b.*\banime\b/.test(t) || /^anime random$/.test(t),
      run: (t) => animeRandomResult(detectGenre(t)),
    },
    {
      test: (t) => (/\b(recommend|suggest|recommendation|recommendations|suggestions?)\b/.test(t) && /\banime\b/.test(t)) ||
        /^anime (recommendation|recommendations|suggestion|suggestions)\b/.test(t),
      run: (t) => animeRecommendResult(detectGenre(t), 3),
    },
    {
      test: (t, raw) => /^(?:please\s+)?(?:search|google|look up)\s+(?:for\s+)?\S+/i.test(stripWake(raw)),
      run: (t, raw) => runSearch(stripWake(raw)),
    },
    {
      test: (t) => /^(?:please )?(?:open|launch|go to|take me to|visit|start)\s+\S+/.test(t),
      run: (t) => {
        const target = t.replace(/^(?:please )?(?:open|launch|go to|take me to|visit|start)\s+/, '');
        return openSiteResult(target);
      },
    },
  ];

  function matchCommand(input) {
    const t = normalize(input);
    if (!t) return null;
    for (const rule of RULES) {
      if (rule.test(t, input)) return () => rule.run(t, input);
    }
    return null;
  }

  function openSiteResult(target) {
    const site = findSite(target);
    if (!site) {
      return {
        text: '"' + target + '" is not on my permitted list. Say "sites" to see which websites I can open.',
        spoken: 'That site is not on my permitted list. Say sites to hear the options.',
      };
    }
    const opened = openExternal(site.url);
    return {
      text: opened
        ? 'Opening ' + site.name + '.'
        : 'Your browser blocked the automatic pop-up. Tap the button to open ' + site.name + '.',
      spoken: opened ? 'Opening ' + site.name + '.' : 'Tap the button to open ' + site.name + '.',
      actions: [{ label: 'Open ' + site.name, url: site.url }],
    };
  }

  function runSearch(raw) {
    const m = /^(?:please\s+)?(?:search|google|look up)\s+(?:for\s+)?(.+)$/i.exec(raw);
    let query = m ? m[1].trim() : '';
    let engine = 'google';
    const on = /^(.*\S)\s+on\s+(youtube|wikipedia|google)$/i.exec(query);
    if (on) { query = on[1].trim(); engine = on[2].toLowerCase(); }
    query = query.slice(0, 200);
    if (!query) return { text: 'What should I search for?' };
    const q = encodeURIComponent(query);
    const targets = {
      google: { name: 'Google', url: 'https://www.google.com/search?q=' + q },
      youtube: { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=' + q },
      wikipedia: { name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=' + q },
    };
    const target = targets[engine];
    const opened = openExternal(target.url);
    return {
      text: (opened ? 'Searching ' : 'Tap the button to search ') + target.name + ' for "' + query + '".',
      spoken: (opened ? 'Searching ' : 'Tap the button to search ') + target.name + '.',
      actions: [{ label: target.name + ' results', url: target.url }],
    };
  }

  /* =======================================================
     5. Anime data & picker
     ======================================================= */
  const GENRES = [
    ['action', 'Action'], ['adventure', 'Adventure'], ['comedy', 'Comedy'], ['drama', 'Drama'],
    ['fantasy', 'Fantasy'], ['historical', 'Historical'], ['mecha', 'Mecha'], ['music', 'Music'],
    ['mystery', 'Mystery'], ['psychological', 'Psychological'], ['romance', 'Romance'], ['scifi', 'Sci-Fi'],
    ['slice', 'Slice of life'], ['sports', 'Sports'], ['supernatural', 'Supernatural'], ['thriller', 'Thriller'],
  ];
  const GENRE_LABEL = Object.fromEntries(GENRES);

  const GENRE_PATTERNS = [
    [/\baction\b/, 'action'], [/\badventure\b/, 'adventure'], [/\b(?:comedy|comedies|funny)\b/, 'comedy'],
    [/\bdrama\b/, 'drama'], [/\bfantasy\b/, 'fantasy'], [/\bhistorical\b/, 'historical'],
    [/\b(?:mecha|robots?)\b/, 'mecha'], [/\bmusic\b/, 'music'], [/\bmystery\b/, 'mystery'],
    [/\bpsychological\b/, 'psychological'], [/\b(?:romance|romantic)\b/, 'romance'],
    [/\b(?:sci fi|scifi|science fiction)\b/, 'scifi'], [/\bslice of life\b/, 'slice'],
    [/\bsports?\b/, 'sports'], [/\bsupernatural\b/, 'supernatural'], [/\bthriller\b/, 'thriller'],
  ];
  function detectGenre(t) {
    for (const [re, key] of GENRE_PATTERNS) if (re.test(t)) return key;
    return '';
  }

  const ANIME = [
    { title: 'Fullmetal Alchemist: Brotherhood', year: 2009, type: 'TV', genres: ['action', 'adventure', 'fantasy', 'drama'], blurb: 'Two brothers use alchemy to repair a terrible loss and uncover a conspiracy reaching the whole country.' },
    { title: 'Death Note', year: 2006, type: 'TV', genres: ['mystery', 'psychological', 'thriller', 'supernatural'], blurb: 'A student finds a notebook that can kill and is hunted by a brilliant detective in a tense battle of wits.' },
    { title: 'Steins;Gate', year: 2011, type: 'TV', genres: ['scifi', 'thriller', 'drama'], blurb: 'A self-styled mad scientist discovers a way to message the past and must live with the consequences.' },
    { title: 'Attack on Titan', year: 2013, type: 'TV', genres: ['action', 'drama', 'thriller'], blurb: 'Humanity survives behind walls from giant man-eating creatures until the walls are breached.' },
    { title: 'Cowboy Bebop', year: 1998, type: 'TV', genres: ['scifi', 'action', 'drama'], blurb: 'A crew of bounty hunters drifts through space in a stylish blend of jazz, noir and loneliness.' },
    { title: 'Hunter x Hunter (2011)', year: 2011, type: 'TV', genres: ['adventure', 'action', 'fantasy'], blurb: 'A boy sets out to become a Hunter and find his father, on a journey far darker and more strategic than it first appears.' },
    { title: 'One Punch Man', year: 2015, type: 'TV', genres: ['action', 'comedy'], blurb: 'A hero who ends every fight with a single punch searches for an opponent who can challenge him.' },
    { title: 'Your Name', year: 2016, type: 'Movie', genres: ['romance', 'drama', 'fantasy', 'supernatural'], blurb: 'Two teenagers who swap bodies in their sleep try to find each other across distance and time.' },
    { title: 'Spirited Away', year: 2001, type: 'Movie', genres: ['fantasy', 'adventure'], blurb: 'A girl trapped in a world of spirits takes a job at a bathhouse to free her parents.' },
    { title: 'Violet Evergarden', year: 2018, type: 'TV', genres: ['drama', 'slice', 'fantasy'], blurb: 'A former soldier becomes a letter writer and learns about human feelings one client at a time.' },
    { title: 'Clannad: After Story', year: 2008, type: 'TV', genres: ['drama', 'romance', 'slice'], blurb: 'A quiet school romance grows into a story about family, responsibility and loss.' },
    { title: 'Mob Psycho 100', year: 2016, type: 'TV', genres: ['action', 'comedy', 'supernatural'], blurb: 'A middle-schooler with enormous psychic power just wants to live an ordinary life.' },
    { title: 'Demon Slayer: Kimetsu no Yaiba', year: 2019, type: 'TV', genres: ['action', 'fantasy', 'supernatural'], blurb: 'A boy becomes a demon hunter to save his sister, who has been turned into a demon.' },
    { title: 'Jujutsu Kaisen', year: 2020, type: 'TV', genres: ['action', 'supernatural', 'fantasy'], blurb: 'A high-schooler joins a school of sorcerers after swallowing a cursed object.' },
    { title: 'Vinland Saga', year: 2019, type: 'TV', genres: ['action', 'adventure', 'drama', 'historical'], blurb: 'A young Viking warrior\'s revenge story becomes a reflection on violence and what makes a life worth living.' },
    { title: 'Monster', year: 2004, type: 'TV', genres: ['mystery', 'psychological', 'thriller', 'drama'], blurb: 'A surgeon spends years hunting the killer that the boy he once saved has become.' },
    { title: 'Gintama', year: 2006, type: 'TV', genres: ['comedy', 'action', 'scifi'], blurb: 'Odd-job samurai in an alien-occupied Edo mix absurd parody with heartfelt action.' },
    { title: 'Haikyu!!', year: 2014, type: 'TV', genres: ['sports', 'comedy', 'drama'], blurb: 'A short, determined player and a gifted rival rebuild their high-school volleyball team.' },
    { title: 'Frieren: Beyond Journey\'s End', year: 2023, type: 'TV', genres: ['fantasy', 'adventure', 'drama', 'slice'], blurb: 'After the hero\'s party defeats the demon king, a long-lived elf mage reflects on time, memory and the people she failed to understand.' },
    { title: 'Bocchi the Rock!', year: 2022, type: 'TV', genres: ['comedy', 'music', 'slice'], blurb: 'An extremely shy guitarist tries to find her place in a band.' },
    { title: 'Cyberpunk: Edgerunners', year: 2022, type: 'TV', genres: ['scifi', 'action', 'drama'], blurb: 'A street kid in a neon megacity joins a crew of mercenaries with cybernetic upgrades.' },
    { title: 'Spy x Family', year: 2022, type: 'TV', genres: ['comedy', 'action'], blurb: 'A spy, an assassin and a telepathic child pose as an ordinary family.' },
    { title: 'Ghost in the Shell', year: 1995, type: 'Movie', genres: ['scifi', 'action', 'thriller'], blurb: 'A cyborg agent chases a mysterious hacker and questions what makes her human.' },
    { title: 'Neon Genesis Evangelion', year: 1995, type: 'TV', genres: ['mecha', 'scifi', 'psychological', 'drama'], blurb: 'Teenagers pilot giant machines against mysterious invaders while struggling with their inner lives.' },
    { title: 'Code Geass: Lelouch of the Rebellion', year: 2006, type: 'TV', genres: ['mecha', 'thriller', 'scifi', 'action'], blurb: 'An exiled prince gains a strange power and starts a rebellion against an empire.' },
    { title: 'Kaguya-sama: Love Is War', year: 2019, type: 'TV', genres: ['romance', 'comedy'], blurb: 'Two top students refuse to confess first, turning romance into a battle of strategy.' },
    { title: 'Fruits Basket (2019)', year: 2019, type: 'TV', genres: ['romance', 'drama', 'supernatural', 'slice'], blurb: 'A girl who lives with a family cursed to turn into zodiac animals helps them heal.' },
    { title: 'Made in Abyss', year: 2017, type: 'TV', genres: ['adventure', 'fantasy', 'mystery', 'drama'], blurb: 'An orphan and a robot boy descend into a vast, beautiful and dangerous chasm.' },
    { title: 'Mushishi', year: 2005, type: 'TV', genres: ['slice', 'supernatural', 'mystery'], blurb: 'A wanderer investigates strange life forms that affect villages, in calm, episodic stories.' },
    { title: 'Princess Mononoke', year: 1997, type: 'Movie', genres: ['fantasy', 'adventure', 'action'], blurb: 'A prince caught between a forest\'s gods and an iron-making town witnesses a struggle over nature and industry.' },
    { title: 'Odd Taxi', year: 2021, type: 'TV', genres: ['mystery', 'drama', 'comedy'], blurb: 'A walrus taxi driver is pulled into a missing-girl case in a witty, layered mystery.' },
    { title: 'Dr. Stone', year: 2019, type: 'TV', genres: ['scifi', 'adventure', 'comedy'], blurb: 'After humanity is turned to stone, a science genius rebuilds civilization from scratch.' },
  ];

  function animeLink(title) {
    return 'https://myanimelist.net/anime.php?cat=anime&q=' + encodeURIComponent(title);
  }

  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pickAnime(genre, count) {
    const pool = genre ? ANIME.filter((a) => a.genres.includes(genre)) : ANIME;
    return shuffled(pool).slice(0, count);
  }

  function animeMeta(a) {
    return a.year + ' · ' + a.type + ' · ' + a.genres.map((g) => GENRE_LABEL[g]).join(', ');
  }

  function animeRecommendResult(genre, count) {
    const picks = pickAnime(genre, count);
    if (!picks.length) return { text: 'I have no titles for that genre yet.' };
    const heading = 'Here ' + (picks.length === 1 ? 'is 1 pick' : 'are ' + picks.length + ' picks') +
      (genre ? ' (' + GENRE_LABEL[genre] + ')' : '') + ':';
    const lines = picks.map((a, i) => (i + 1) + '. ' + a.title + ' (' + animeMeta(a) + ')\n   ' + a.blurb);
    const names = picks.map((a) => a.title);
    const spokenList = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
    return {
      text: heading + '\n\n' + lines.join('\n\n'),
      spoken: 'I suggest ' + spokenList + '.',
      actions: picks.map((a) => ({ label: a.title, url: animeLink(a.title) })),
    };
  }

  function animeRandomResult(genre) {
    const [a] = pickAnime(genre, 1);
    if (!a) return { text: 'I have no titles for that genre yet.' };
    return {
      text: 'Random pick: ' + a.title + ' (' + animeMeta(a) + ')\n' + a.blurb,
      spoken: 'Random pick: ' + a.title + '. ' + a.blurb,
      actions: [{ label: a.title + ' on MyAnimeList', url: animeLink(a.title) }],
    };
  }

  /* ---- Anime panel UI ---- */
  let animeGenre = '';

  function buildGenreChips() {
    els.genreChips.replaceChildren();
    const all = [['', 'Any genre']].concat(GENRES);
    for (const [key, label] of all) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'genre';
      b.textContent = label;
      b.dataset.genre = key;
      b.setAttribute('aria-pressed', String(key === animeGenre));
      b.addEventListener('click', () => {
        animeGenre = key;
        $$('.genre', els.genreChips).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.genre === animeGenre)));
      });
      els.genreChips.append(b);
    }
  }

  function renderAnimeCards(list) {
    els.animeResults.replaceChildren();
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'anime-empty';
      p.textContent = 'No titles found for that genre.';
      els.animeResults.append(p);
      return;
    }
    for (const a of list) {
      const card = document.createElement('article');
      card.className = 'anime-card';
      const h = document.createElement('h3');
      h.textContent = a.title;
      const sub = document.createElement('p');
      sub.className = 'sub';
      sub.textContent = animeMeta(a);
      const blurb = document.createElement('p');
      blurb.textContent = a.blurb;
      const row = document.createElement('div');
      row.className = 'actions';
      const link = document.createElement('a');
      link.className = 'action';
      link.href = animeLink(a.title);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'MyAnimeList';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'action';
      add.textContent = 'Add to chat';
      add.addEventListener('click', () => {
        addMessage({
          role: 'assistant',
          text: a.title + ' (' + animeMeta(a) + ')\n' + a.blurb,
          actions: [{ label: a.title + ' on MyAnimeList', url: animeLink(a.title) }],
        });
        toast('Added to chat');
      });
      row.append(link, add);
      card.append(h, sub, blurb, row);
      els.animeResults.append(card);
    }
  }

  function openAnimePanel() {
    buildGenreChips();
    if (!els.animeResults.children.length) {
      const p = document.createElement('p');
      p.className = 'anime-empty';
      p.textContent = 'Choose a genre, then press Recommend 3 or Random pick.';
      els.animeResults.append(p);
    }
    openDialog(els.animeDialog);
  }

  /* =======================================================
     6. Chat rendering & history
     ======================================================= */
  const flags = { listening: false, thinking: false, speaking: false };
  const STATE_TEXT = { idle: 'STANDBY', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'SPEAKING' };

  function currentState() {
    if (flags.listening) return 'listening';
    if (flags.thinking) return 'thinking';
    if (flags.speaking) return 'speaking';
    return 'idle';
  }

  function renderState() {
    const s = currentState();
    document.body.dataset.state = s;
    els.core.dataset.state = s;
    els.core.setAttribute('aria-label', 'JARVIS core – ' + STATE_TEXT[s].toLowerCase());
    els.statusText.textContent = STATE_TEXT[s];
    els.mic.classList.toggle('is-listening', flags.listening);
    els.mic.setAttribute('aria-pressed', String(flags.listening));
    els.mic.setAttribute('aria-label', flags.listening ? 'Stop listening' : 'Start voice input');
    els.send.disabled = flags.thinking;
    els.send.classList.toggle('is-loading', flags.thinking);
  }

  let history = [];

  function isValidMessage(m) {
    return m && typeof m === 'object' && typeof m.text === 'string' &&
      (m.role === 'user' || m.role === 'assistant') && typeof m.ts === 'number';
  }
  function loadHistory() {
    const data = storage.get(STORAGE_KEYS.history, []);
    history = Array.isArray(data) ? data.filter(isValidMessage).slice(-MAX_HISTORY) : [];
  }
  function persistHistory() {
    if (!storage.set(STORAGE_KEYS.history, history.slice(-MAX_HISTORY))) {
      // Storage may be full or blocked; keep working in memory.
      console.warn('Could not save conversation history.');
    }
  }

  function scrollToBottom() {
    els.log.scrollTo({ top: els.log.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function renderMessage(m) {
    const wrap = document.createElement('article');
    wrap.className = 'msg msg-' + m.role + (m.error ? ' is-error' : '');
    if (m.role !== 'system') {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (m.role === 'user' ? 'You' : 'JARVIS') + ' · ' + timeFormatShort.format(new Date(m.ts));
      wrap.append(meta);
    }
    const body = document.createElement('p');
    body.className = 'body';
    body.textContent = m.text; // textContent only: never inject HTML
    wrap.append(body);

    if (Array.isArray(m.actions) && m.actions.length) {
      const row = document.createElement('div');
      row.className = 'actions';
      for (const a of m.actions) {
        if (!a || typeof a.label !== 'string' || !isAllowedUrl(a.url)) continue;
        const link = document.createElement('a');
        link.className = 'action';
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = a.label;
        row.append(link);
      }
      if (row.children.length) wrap.append(row);
    }
    els.log.append(wrap);
    scrollToBottom();
  }

  /** role: 'user' | 'assistant' (saved) or 'system' (shown once, never saved). */
  function addMessage({ role, text, actions, error }) {
    const m = { id: uid(), role, text: String(text), ts: Date.now() };
    if (actions && actions.length) m.actions = actions.map((a) => ({ label: String(a.label), url: String(a.url) }));
    if (error) m.error = true;
    if (role !== 'system') {
      history.push(m);
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      persistHistory();
    }
    renderMessage(m);
    return m;
  }

  let typingEl = null;
  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('article');
    typingEl.className = 'msg msg-assistant typing';
    typingEl.setAttribute('aria-label', 'JARVIS is working');
    const body = document.createElement('p');
    body.className = 'body';
    body.innerHTML = '<i></i><i></i><i></i>'; // static markup, no user content
    typingEl.append(body);
    els.log.append(typingEl);
    scrollToBottom();
  }
  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }
  function setThinking(on) {
    flags.thinking = on;
    if (on) { showTyping(); els.transcript.textContent = 'Working on it…'; }
    else { hideTyping(); if (!flags.listening) els.transcript.textContent = ''; }
    renderState();
  }

  function renderHistory() {
    els.log.replaceChildren();
    history.forEach(renderMessage);
  }

  function greet() {
    const connected = Boolean(settings.endpoint);
    const text = greetingForHour(new Date().getHours()) + '. JARVIS interface online.\n' +
      (connected
        ? 'Your assistant service is connected. Built-in commands still run locally.'
        : 'No AI model is connected yet, so I can run built-in commands only. Say "help" to see them.');
    addMessage({ role: 'assistant', text });
  }

  function buildContext() {
    return history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-CONTEXT_MESSAGES)
      .map((m) => ({ role: m.role, content: m.text.slice(0, 2000) }));
  }

  let currentAbort = null;

  async function respond(text, signal) {
    const handler = matchCommand(text);
    if (handler) return handler();
    return getAssistantService().reply({ text, messages: buildContext(), signal });
  }

  async function handleUserInput(raw) {
    const text = String(raw || '').trim().slice(0, MAX_INPUT_CHARS);
    if (!text) return;
    if (flags.thinking) { toast('Still working on your last request.'); return; }
    if (flags.listening) stopListening();
    stopSpeaking();

    addMessage({ role: 'user', text });
    const abort = new AbortController();
    currentAbort = abort;
    setThinking(true);
    try {
      const result = await respond(text, abort.signal);
      if (abort.signal.aborted) return;
      if (result && result.text) {
        addMessage({ role: 'assistant', text: result.text, actions: result.actions });
        if (result.speak !== false) speak(result.spoken || result.text);
      }
    } catch (err) {
      if (abort.signal.aborted || (err && err.code === 'aborted')) return;
      console.error(err);
      addMessage({
        role: 'system',
        error: true,
        text: err instanceof AssistantError ? err.message : 'Something went wrong while handling that request. Please try again.',
      });
    } finally {
      if (currentAbort === abort) currentAbort = null;
      setThinking(false);
    }
  }

  function clearChat() {
    if (!window.confirm('Clear the whole conversation on this device?')) return false;
    if (currentAbort) currentAbort.abort();
    stopSpeaking();
    if (flags.listening) stopListening();
    history = [];
    storage.remove(STORAGE_KEYS.history);
    setThinking(false);
    els.log.replaceChildren();
    greet();
    toast('Conversation cleared');
    return true;
  }

  /* =======================================================
     7. Speech output
     ======================================================= */
  const synth = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window ? window.speechSynthesis : null;
  let voices = [];
  let speakToken = 0;
  let activeUtterance = null; // keep a reference so Chrome does not garbage-collect it mid-speech

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices() || [];
    populateVoiceSelect();
    updateChips();
  }

  function populateVoiceSelect() {
    const sel = els.setVoice;
    sel.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = synth ? 'Device default' : 'Not supported on this browser';
    sel.append(def);
    voices
      .slice()
      .sort((a, b) => (a.lang + a.name).localeCompare(b.lang + b.name))
      .forEach((v) => {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = v.name + ' (' + v.lang + ')';
        sel.append(o);
      });
    sel.value = voices.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
    sel.disabled = !synth;
  }

  function cleanForSpeech(text) {
    return String(text)
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[•·]/g, ',')
      .replace(/[\r\n]+/g, '. ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function chunkText(text, max) {
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const chunks = [];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > max && buf) { chunks.push(buf.trim()); buf = ''; }
      if (s.length > max) {
        for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max).trim());
      } else {
        buf += s;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks.filter(Boolean);
  }

  function applyVoice(utterance) {
    const v = voices.find((x) => x.voiceURI === settings.voiceURI);
    if (v) { utterance.voice = v; utterance.lang = v.lang; }
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;
  }

  function speak(text, { force = false } = {}) {
    if (!synth) return false;
    if (!force && !settings.speakReplies) return false;
    const clean = cleanForSpeech(text);
    if (!clean) return false;

    try {
      if (synth.paused) synth.resume();
      synth.cancel();
    } catch (_) { /* ignore */ }
    const token = ++speakToken;
    const chunks = chunkText(clean, 170);
    let i = 0;

    const next = () => {
      if (token !== speakToken) return;
      if (i >= chunks.length) {
        activeUtterance = null;
        flags.speaking = false;
        renderState();
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      applyVoice(u);
      u.onstart = () => {
        if (token !== speakToken) return;
        flags.speaking = true;
        renderState();
      };
      u.onend = next;
      u.onerror = (e) => {
        if (token !== speakToken) return;
        if (e.error && e.error !== 'canceled' && e.error !== 'interrupted') {
          toast('Voice output failed (' + e.error + ').');
        }
        activeUtterance = null;
        flags.speaking = false;
        renderState();
      };
      activeUtterance = u;
      try { synth.speak(u); } catch (_) {
        flags.speaking = false;
        renderState();
      }
    };
    setTimeout(next, 60);
    return true;
  }

  function stopSpeaking() {
    speakToken++;
    activeUtterance = null;
    if (synth) { try { synth.cancel(); } catch (_) { /* ignore */ } }
    if (flags.speaking) { flags.speaking = false; renderState(); }
  }

  /* =======================================================
     8. Speech input
     ======================================================= */
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  let recognition = null;

  const RECOGNITION_ERRORS = {
    'not-allowed': 'Microphone access was blocked. In Chrome, tap the lock icon beside the address bar, allow the microphone for this site, then try again.',
    'service-not-allowed': 'Speech recognition is not allowed on this device or browser. Check Chrome\'s site settings and Android\'s voice input settings.',
    'no-speech': 'I did not hear anything. Tap the mic and try again.',
    'audio-capture': 'No microphone was found. Check that a microphone is available and not used by another app.',
    network: 'Speech recognition needs an internet connection. Please check your connection and try again.',
    'language-not-supported': 'That recognition language is not supported. Choose another one in Settings.',
  };

  function startListening() {
    if (!SpeechRecognitionCtor) {
      addMessage({ role: 'system', error: true, text: 'Voice input is not supported in this browser. Use Chrome on Android, or type your message.' });
      return;
    }
    if (!window.isSecureContext) {
      addMessage({ role: 'system', error: true, text: 'Voice input needs a secure (HTTPS) page. Open the GitHub Pages address instead of a local file.' });
      return;
    }
    if (flags.thinking) { toast('Please wait until I finish the current request.'); return; }
    if (!navigator.onLine) {
      addMessage({ role: 'system', error: true, text: 'You are offline. Chrome voice input needs an internet connection; typing still works.' });
      return;
    }

    stopSpeaking();
    let finalText = '';
    let lastError = '';
    const rec = new SpeechRecognitionCtor();
    recognition = rec;
    rec.lang = settings.recognitionLang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      flags.listening = true;
      els.transcript.textContent = 'Listening…';
      renderState();
    };
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      els.transcript.textContent = (finalText + interim).trim() || 'Listening…';
    };
    rec.onerror = (event) => { lastError = event.error || 'unknown'; };
    rec.onend = () => {
      if (recognition === rec) recognition = null;
      flags.listening = false;
      els.transcript.textContent = '';
      renderState();
      const text = finalText.trim();
      if (lastError && lastError !== 'aborted') {
        addMessage({ role: 'system', error: true, text: RECOGNITION_ERRORS[lastError] || 'Voice input stopped unexpectedly (' + lastError + '). Please try again.' });
      } else if (text) {
        if (settings.autoSend) handleUserInput(text);
        else { els.input.value = text; els.input.focus(); }
      } else if (!lastError) {
        toast('I did not catch that. Tap the mic and try again.');
      }
    };

    try {
      rec.start(); // the browser asks for microphone permission here, on the user's tap
    } catch (err) {
      recognition = null;
      flags.listening = false;
      renderState();
      addMessage({ role: 'system', error: true, text: 'Could not start voice input. Please try again.' });
    }
  }

  function stopListening() {
    if (recognition) {
      try { recognition.stop(); } catch (_) { /* ignore */ }
    }
  }

  function toggleListening() {
    if (flags.listening) stopListening();
    else startListening();
  }

  /* =======================================================
     9. UI wiring
     ======================================================= */
  function setChip(el, value, level) {
    el.dataset.level = level;
    $('.chip-value', el).textContent = value;
  }

  function updateChips() {
    setChip(els.chipVoiceIn, SpeechRecognitionCtor ? 'Ready' : 'Unsupported', SpeechRecognitionCtor ? 'ok' : 'off');
    if (!synth) setChip(els.chipVoiceOut, 'Unsupported', 'off');
    else if (!settings.speakReplies) setChip(els.chipVoiceOut, 'Muted', 'warn');
    else setChip(els.chipVoiceOut, 'Ready', 'ok');
    setChip(els.chipNet, navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? 'ok' : 'off');
    if (settings.endpoint) {
      let host = 'Remote';
      try { host = new URL(settings.endpoint).hostname; } catch (_) { /* ignore */ }
      setChip(els.chipAi, host.length > 18 ? host.slice(0, 17) + '…' : host, 'ok');
    } else {
      setChip(els.chipAi, 'No model', 'warn');
    }
  }

  /* ---- Clock ---- */
  let lastDateLabel = '';
  function tickClock() {
    const now = new Date();
    els.clock.textContent = timeFormatClock.format(now);
    els.clock.setAttribute('datetime', now.toISOString());
    const label = dateFormatFull.format(now);
    if (label !== lastDateLabel) { els.date.textContent = label; lastDateLabel = label; }
  }

  /* ---- Settings form ---- */
  function syncSettingsForm() {
    els.setSpeak.checked = settings.speakReplies;
    els.setRate.value = settings.rate;
    els.setPitch.value = settings.pitch;
    els.setVolume.value = settings.volume;
    els.setAutoSend.checked = settings.autoSend;
    els.setEndpoint.value = settings.endpoint;
    if (![...els.setLang.options].some((o) => o.value === settings.recognitionLang)) {
      const o = document.createElement('option');
      o.value = settings.recognitionLang;
      o.textContent = settings.recognitionLang;
      els.setLang.append(o);
    }
    els.setLang.value = settings.recognitionLang;
    els.outRate.textContent = settings.rate.toFixed(2).replace(/0$/, '');
    els.outPitch.textContent = settings.pitch.toFixed(2).replace(/0$/, '');
    els.outVolume.textContent = Math.round(settings.volume * 100) + '%';
    populateVoiceSelect();
    els.endpointMsg.hidden = true;
  }

  function bindSettings() {
    els.setSpeak.addEventListener('change', () => {
      settings.speakReplies = els.setSpeak.checked;
      if (!settings.speakReplies) stopSpeaking();
      saveSettings(); updateChips();
    });
    els.setVoice.addEventListener('change', () => { settings.voiceURI = els.setVoice.value; saveSettings(); });
    els.setRate.addEventListener('input', () => {
      settings.rate = clamp(Number(els.setRate.value), 0.6, 1.5);
      els.outRate.textContent = settings.rate.toFixed(2).replace(/0$/, '');
      saveSettings();
    });
    els.setPitch.addEventListener('input', () => {
      settings.pitch = clamp(Number(els.setPitch.value), 0.6, 1.6);
      els.outPitch.textContent = settings.pitch.toFixed(2).replace(/0$/, '');
      saveSettings();
    });
    els.setVolume.addEventListener('input', () => {
      settings.volume = clamp(Number(els.setVolume.value), 0, 1);
      els.outVolume.textContent = Math.round(settings.volume * 100) + '%';
      saveSettings();
    });
    els.setLang.addEventListener('change', () => { settings.recognitionLang = els.setLang.value; saveSettings(); });
    els.setAutoSend.addEventListener('change', () => { settings.autoSend = els.setAutoSend.checked; saveSettings(); });

    els.setEndpoint.addEventListener('change', () => {
      try {
        settings.endpoint = normalizeEndpoint(els.setEndpoint.value);
        els.setEndpoint.value = settings.endpoint;
        els.endpointMsg.hidden = true;
        saveSettings(); updateChips();
        toast(settings.endpoint ? 'Assistant service saved' : 'Using built-in commands only');
      } catch (err) {
        els.endpointMsg.textContent = err.message;
        els.endpointMsg.hidden = false;
      }
    });

    els.btnTestVoice.addEventListener('click', () => {
      if (!synth) { toast('Voice output is not supported on this browser.'); return; }
      speak('This is how I will sound with the current voice settings.', { force: true });
    });

    els.btnResetSettings.addEventListener('click', () => {
      settings = sanitizeSettings({});
      saveSettings();
      syncSettingsForm();
      updateChips();
      toast('Settings reset');
    });
  }

  /* ---- Install (PWA) ---- */
  let deferredInstallPrompt = null;
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  function bindInstall() {
    if (isStandalone()) els.btnInstall.hidden = true;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      els.btnInstall.hidden = true;
      toast('JARVIS installed');
    });
    els.btnInstall.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        const promptEvent = deferredInstallPrompt;
        deferredInstallPrompt = null;
        try {
          await promptEvent.prompt();
          await promptEvent.userChoice;
        } catch (_) { toast('The install prompt could not be shown.'); }
        return;
      }
      if (isStandalone()) { toast('JARVIS is already running as an installed app.'); return; }
      toast('Open Chrome\'s ⋮ menu and choose "Install app" or "Add to Home screen".', 6000);
    });
  }

  /* ---- Online / offline ---- */
  let offlineDismissed = false;
  function updateNetwork() {
    updateChips();
    if (!navigator.onLine && !offlineDismissed) els.offline.hidden = false;
    if (navigator.onLine) { els.offline.hidden = true; offlineDismissed = false; }
  }
  function bindNetwork() {
    window.addEventListener('online', () => { updateNetwork(); toast('Back online'); });
    window.addEventListener('offline', () => { updateNetwork(); });
    els.btnOfflineContinue.addEventListener('click', () => { offlineDismissed = true; els.offline.hidden = true; });
    els.btnOfflineRetry.addEventListener('click', () => {
      if (navigator.onLine) { updateNetwork(); toast('Connection restored'); }
      else toast('Still offline. Check Wi-Fi or mobile data.');
    });
  }

  /* ---- Service worker ---- */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready. Close and reopen JARVIS to update.', 6000);
          }
        });
      });
    }).catch((err) => console.warn('Service worker registration failed:', err));
  }

  /* ---- Event binding ---- */
  function bindEvents() {
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = els.input.value;
      if (!value.trim()) return;
      if (flags.thinking) { toast('Still working on your last request.'); return; }
      els.input.value = '';
      handleUserInput(value);
    });

    els.mic.addEventListener('click', toggleListening);

    $$('.shortcut').forEach((btn) => {
      btn.addEventListener('click', () => handleUserInput(btn.dataset.cmd));
    });

    els.btnSettings.addEventListener('click', () => { syncSettingsForm(); openDialog(els.settingsDialog); });
    els.btnAnime.addEventListener('click', openAnimePanel);
    els.btnClear.addEventListener('click', clearChat);

    $$('dialog.sheet').forEach((dialog) => {
      dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(dialog); });
      $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => closeDialog(dialog)));
    });

    els.btnAnimeRecommend.addEventListener('click', () => renderAnimeCards(pickAnime(animeGenre, 3)));
    els.btnAnimeRandom.addEventListener('click', () => renderAnimeCards(pickAnime(animeGenre, 1)));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopListening(); stopSpeaking(); }
      else tickClock();
    });
    window.addEventListener('pagehide', () => { stopListening(); stopSpeaking(); });

    window.addEventListener('unhandledrejection', (e) => {
      console.error(e.reason);
      toast('Something went wrong. Please try again.');
    });
  }

  /* ---- Init ---- */
  function init() {
    loadHistory();
    syncSettingsForm();
    bindSettings();
    bindInstall();
    bindNetwork();
    bindEvents();
    buildGenreChips();

    if (history.length) renderHistory();
    else greet();

    tickClock();
    setInterval(tickClock, 1000);

    if (synth) {
      loadVoices();
      synth.addEventListener('voiceschanged', loadVoices);
      setTimeout(loadVoices, 600);   // some Android builds populate voices late
      setTimeout(loadVoices, 1800);
    } else {
      populateVoiceSelect();
    }

    updateChips();
    updateNetwork();
    renderState();
    registerServiceWorker();
  }

  init();
})();
