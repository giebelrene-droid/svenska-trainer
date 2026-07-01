const APP_VERSION = "30.51";

// ==========================================
// 1. TOAST BENACHRICHTIGUNGEN & FEHLER-LOG
// ==========================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const bgColors = { 'success': 'var(--secondary)', 'error': '#EF4444', 'info': 'var(--primary)' };
    toast.style.backgroundColor = bgColors[type] || bgColors['info'];
    toast.style.color = 'white'; toast.style.padding = '12px 24px'; toast.style.borderRadius = '12px'; toast.style.fontWeight = '600'; toast.style.fontSize = '0.9rem'; toast.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.2)'; toast.style.opacity = '0'; toast.style.transform = 'translateY(20px)'; toast.style.transition = 'all 0.3s ease-out'; toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; }, 10);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(20px)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

let errorLog = JSON.parse(localStorage.getItem('trainerErrorLog') || '[]');
function logCustomError(context, error) {
    const entry = `[${new Date().toLocaleTimeString()}] ${context}: ${error instanceof Error ? error.message : String(error)}`;
    errorLog.unshift(entry); if (errorLog.length > 50) errorLog.pop(); localStorage.setItem('trainerErrorLog', JSON.stringify(errorLog));
    console.error("Custom Log:", entry);
    if(document.getElementById('errorLogOverlay') && document.getElementById('errorLogOverlay').style.display === 'flex') renderErrorLog();
}
window.onerror = function(msg, src, line) { logCustomError("Global Error", `${msg} (Zeile ${line})`); };
window.addEventListener('unhandledrejection', function(event) { logCustomError("Unhandled Promise", event.reason); });

function openErrorLog() { document.getElementById('settingsOverlay').style.display = 'none'; document.getElementById('errorLogOverlay').style.display = 'flex'; renderErrorLog(); }
function closeErrorLog() { document.getElementById('errorLogOverlay').style.display = 'none'; }
function clearErrorLog() { errorLog = []; localStorage.setItem('trainerErrorLog', JSON.stringify(errorLog)); renderErrorLog(); }
function renderErrorLog() { const el = document.getElementById('errorLogList'); if(!el) return; if(errorLog.length === 0) el.innerHTML = "Alles läuft reibungslos!"; else el.innerHTML = errorLog.map(e => `<div>${escapeHTML(e)}</div>`).join('<hr style="border-color:#374151; margin:5px 0;">'); }

function migrateOldData() {
    if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    if(allWords.length === 0) return showToast("Keine Wörter zum Exportieren gefunden.", "info");
    const exportObj = { version: "30.0", date: new Date().toISOString(), conf: conf, user: userNames[currentCollIndex], words: allWords.map(({ id, ...w }) => w) };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `sprachtutor_backup_${userNames[currentCollIndex].replace(/\s/g,'_')}_${new Date().toISOString().split('T')[0]}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast(`✅ Backup mit ${allWords.length} Wörtern erstellt!`, "success");
}

function importData(event) {
    const file = event.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
            let words = [];
            if(Array.isArray(data)) { words = data; }
            else if(data.words && Array.isArray(data.words)) { words = data.words; }
            else { return showToast("⚠️ Ungültiges Backup-Format.", "error"); }
            if(words.length === 0) return showToast("Keine Wörter im Backup gefunden.", "info");
            const ref = db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex);
            const batchSize = 400; let imported = 0;
            for(let i = 0; i < words.length; i += batchSize) {
                const batch = db.batch();
                words.slice(i, i + batchSize).forEach(w => { const { id, ...wordData } = w; wordData.ts = firebase.firestore.FieldValue.serverTimestamp(); if(!wordData.level) wordData.level = 0; if(!wordData.nextReview) wordData.nextReview = getNextReviewTimestamp(0); batch.set(ref.doc(), wordData); imported++; });
                await batch.commit();
            }
            showToast(`✅ ${imported} Wörter importiert!`, "success"); refreshData();
        } catch(err) { logCustomError("Import", err); showToast("⚠️ Fehler beim Importieren.", "error"); }
    };
    reader.readAsText(file); event.target.value = "";
}

async function nukeDatabase() {
    if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    if(!confirm(`⚠️ ACHTUNG!\n\nAlle Vokabeln von "${userNames[currentCollIndex]}" werden unwiderruflich gelöscht!\n\nWirklich fortfahren?`)) return;
    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).get();
        const batchSize = 400;
        for(let i = 0; i < snap.docs.length; i += batchSize) { const batch = db.batch(); snap.docs.slice(i, i + batchSize).forEach(doc => batch.delete(doc.ref)); await batch.commit(); }
        allWords = []; document.getElementById('wordCount').innerText = 0; renderList();
        showToast("✅ Alle Vokabeln gelöscht.", "success");
    } catch(e) { logCustomError("Nuke Database", e); showToast("⚠️ Fehler beim Löschen.", "error"); }
}

async function removeDuplicateWords() {
    if (!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    const btn = document.getElementById('btnRemoveDuplicates');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Suche Duplikate…'; }
    try {
        // Load fresh, newest first — first occurrence of each l1 key is the one to keep
        const snap = await db.collection('users').doc(currentUser.uid)
            .collection('words_' + currentCollIndex).orderBy("ts", "desc").get();

        const seen = new Set();
        const toDelete = [];
        snap.docs.forEach(doc => {
            const key = ((doc.data()[conf.l1] || '')).trim().toLowerCase();
            if (!key) return;
            if (seen.has(key)) {
                toDelete.push(doc.ref);
            } else {
                seen.add(key);
            }
        });

        if (toDelete.length === 0) {
            showToast("✅ Keine Duplikate gefunden!", "success");
            return;
        }

        const batchSize = 400;
        for (let i = 0; i < toDelete.length; i += batchSize) {
            const batch = db.batch();
            toDelete.slice(i, i + batchSize).forEach(ref => batch.delete(ref));
            await batch.commit();
        }

        const remaining = snap.docs.length - toDelete.length;
        await refreshData();
        showToast(`✅ ${toDelete.length} Duplikate gelöscht, ${remaining} Wörter verbleiben`, "success");
    } catch(e) {
        logCustomError("removeDuplicateWords", e);
        showToast("⚠️ Fehler beim Entfernen der Duplikate.", "error");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🧹 Duplikate entfernen'; }
    }
}

// ==========================================
// 2. KERN-VARIABLEN & FIREBASE INITIALISIERUNG
// ==========================================
let db = null; let currentUser = null;
try {
    firebase.initializeApp({ apiKey: "AIzaSyB4ViTtin8mGcayWbXX-UtpTpPF5E4u68Q", authDomain: "uebersetzer-d-eng-swe.firebaseapp.com", projectId: "uebersetzer-d-eng-swe" }); 
    db = firebase.firestore(); db.enablePersistence().catch(()=>{});
} catch(err) { logCustomError("Firebase Init", err); if(document.getElementById('offlineBanner')) document.getElementById('offlineBanner').style.display = 'block'; }

const ALL_LANGS = { 'de':{name:'Deutsch',tts:'de-DE',flag:'🇩🇪'}, 'en':{name:'Englisch',tts:'en-US',flag:'🇬🇧'}, 'sv':{name:'Schwedisch',tts:'sv-SE',flag:'🇸🇪'}, 'fr':{name:'Französisch',tts:'fr-FR',flag:'🇫🇷'}, 'no':{name:'Norwegisch',tts:'nb-NO',flag:'🇳🇴'}, 'es':{name:'Spanisch',tts:'es-ES',flag:'🇪🇸'}, 'it':{name:'Italienisch',tts:'it-IT',flag:'🇮🇹'} };
let userNames = ['Papa', 'Mama', 'Kind 1', 'Kind 2']; let currentCollIndex = 0; let conf = { l1: 'de', l2: 'en', l3: 'sv' }; let allWords = []; let dataReady = false;
let studyWords = []; let studyIndex = 0; let fcPool = []; let fcIndex = 0; let fcSessionHistory = { spaeter: [], nochmals: [], geuebt: [] }; let currentFcListType = '';
let activeRpSentenceForFeedback = ""; let rpOptionsBuffer = null; let rpFetchPromise = null; let rpMicTimer = null; let rpCurrentTranscript = "";
let rpWbwState = { active: false, words: [], index: 0, speed: 0.6, handler: null };
let picQuizState = { correct: null, options: [], answered: false };
let geminiApiKey = localStorage.getItem('trainerGeminiKey') || ""; let currentApiKeyIndex = 0; let cachedGeminiModel = null;
let deeplApiKey = localStorage.getItem('trainerDeeplKey') || "";
let elevenlabsApiKey = localStorage.getItem('trainerElevenLabsKey') || "";
let elevenlabsVoices = [];
let elevenlabsVoiceId = localStorage.getItem('trainerElevenLabsVoice') || "";
let currentElevenLabsAudio = null;
let isLiveRecording = false; let liveRecObj = null; let isChatSessionActive = false; let chatRec = null; let duelWordObj = null; let duelCanTap = false; let huntTarget = ""; let listDebounceTimer;
const RALLYE_CATEGORIES = [ { prompt: "ein Tier", label: "Nenne ein Tier! 🐾" }, { prompt: "eine Farbe", label: "Nenne eine Farbe! 🎨" }, { prompt: "eine Sportart", label: "Nenne eine Sportart! ⚽" }, { prompt: "ein Lebensmittel", label: "Nenne ein Lebensmittel! 🍎" }, { prompt: "ein Land", label: "Nenne ein Land! 🌍" }, { prompt: "ein Fahrzeug", label: "Nenne ein Fahrzeug! 🚗" }, { prompt: "ein Körperteil", label: "Nenne einen Körperteil! 💪" }, { prompt: "ein Möbelstück", label: "Nenne ein Möbelstück! 🛋️" } ];
let currentRallyeCategory = RALLYE_CATEGORIES[0];
let isFastInputMode = localStorage.getItem('trainerFastInput') !== 'false';
let userXP = parseInt(localStorage.getItem('trainerXP') || '0'); let userStreak = parseInt(localStorage.getItem('trainerStreak') || '0'); let lastActiveDate = localStorage.getItem('trainerLastDate') || '';
let statsToday = {learned:0, added:0, date:""};
try { const rawStats = localStorage.getItem('trainerStatsToday'); if(rawStats && rawStats !== "undefined") statsToday = JSON.parse(rawStats); } catch(e) {}

// Audio-Trainer Variablen
let isAudioRunning = false; let cancelAudio = false; let audioHistory = []; let currentAudioSentence = { l1: "", l3: "" }; let currentUtterance = null;
let availableVoices = [];

// ==========================================
// 3. SPRACHAUSGABE & STIMMEN (ANDROID CHROME FIX)
// ==========================================

// Prüfe speechSynthesis beim Laden
if (!('speechSynthesis' in window)) {
    document.addEventListener('DOMContentLoaded', () => {
        const b = document.createElement('div');
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#7c3aed;color:#fff;font-size:0.9rem;font-weight:800;padding:14px;z-index:99999;text-align:center;';
        b.textContent = '⚠️ Dein Browser unterstützt Text-to-Speech nicht. Lautsprecher-Buttons funktionieren nicht.';
        document.body.prepend(b);
    });
}

// ── ANDROID CHROME FIX ───────────────────────────────────────────────────
// Erkennung: Android + Chrome, aber nicht Opera, Samsung Browser oder Edge
const isAndroidChrome = /Android/i.test(navigator.userAgent) &&
    /Chrome\/\d+/.test(navigator.userAgent) &&
    !/OPR\/|SamsungBrowser|EdgA\//.test(navigator.userAgent);
console.log('[TTS] isAndroidChrome:', isAndroidChrome, '| UA:', navigator.userAgent.slice(0, 120));

if (isAndroidChrome && window.speechSynthesis) {
    // 1) Erster Klick → leere Utterance entsperrt Chrome, sofortiges cancel() leert die Queue
    document.addEventListener('click', function unlockTTS() {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        window.speechSynthesis.speak(u);
        window.speechSynthesis.cancel();
        console.log('[TTS] unlockTTS fired (Android Chrome first click)');
    }, { once: true });

    // 2) Keepalive alle 10s — verhindert dass Chrome speechSynthesis automatisch pausiert
    setInterval(() => {
        const ss = window.speechSynthesis;
        console.log('[TTS] keepalive — speaking:', ss.speaking, '| paused:', ss.paused);
        ss.resume();
    }, 10000);
}
// ─────────────────────────────────────────────────────────────────────────

function loadVoices() {
    if (!window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
        availableVoices = voices;
        updateVoiceDropdown();
    }
}
if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
    [100, 500, 1000, 2000].forEach(t => setTimeout(loadVoices, t));
}

function updateVoiceDropdown() {
    const voiceSelect = document.getElementById('selAudioVoice');
    if (elevenlabsApiKey) {
        if (voiceSelect) {
            voiceSelect.innerHTML = '<option value="">🎙️ ElevenLabs — Stimmen in ⚙️</option>';
            voiceSelect.disabled = true;
        }
        if (elevenlabsVoices.length > 0) updateElevenLabsLangDropdowns();
        return;
    }
    if (voiceSelect) voiceSelect.disabled = false;
    if (!voiceSelect) return;
    const ttsCode = (ALL_LANGS[conf.l3] && ALL_LANGS[conf.l3].tts) || 'sv-SE';
    const base = ttsCode.split('-')[0].toLowerCase();
    const nameMap = { sv:'swedish', de:'german', en:'english', fr:'french', es:'spanish', it:'italian', no:'norwegian' };
    const nameHint = nameMap[base] || base;
    const byLang = availableVoices.filter(v => v.lang.toLowerCase().startsWith(base));
    const byName = availableVoices.filter(v => !v.lang.toLowerCase().startsWith(base) && v.name.toLowerCase().includes(nameHint));
    const matchingVoices = [...byLang, ...byName];
    const prevVal = voiceSelect.value;
    let html = '<option value="">🤖 Standard-Stimme</option>';
    matchingVoices.forEach(v => { html += `<option value="${escapeHTML(v.name)}">${escapeHTML(v.name)} (${escapeHTML(v.lang)})</option>`; });
    voiceSelect.innerHTML = html;
    if (prevVal && matchingVoices.some(v => v.name === prevVal)) voiceSelect.value = prevVal;
}

// Chrome/Android: Synthesis bricht nach ~15s ab
let synthKeepAliveTimer = null;
function startSynthKeepAlive() {
    stopSynthKeepAlive();
    synthKeepAliveTimer = setInterval(() => {
        if (window.speechSynthesis && window.speechSynthesis.speaking) {
            window.speechSynthesis.pause();
            window.speechSynthesis.resume();
        }
    }, 10000);
}
function stopSynthKeepAlive() {
    if (synthKeepAliveTimer) { clearInterval(synthKeepAliveTimer); synthKeepAliveTimer = null; }
}

// Tab wieder sichtbar → aus Pause-State holen
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.speechSynthesis) {
        window.speechSynthesis.resume();
    }
});

function findBestVoice(langKey) {
    if (!availableVoices.length) return null;
    const ttsCode = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) || 'de-DE';
    const base = ttsCode.split('-')[0].toLowerCase();
    const nameMap = { sv:'swedish', de:'german', en:'english', fr:'french', es:'spanish', it:'italian', no:'norwegian' };
    const nameHint = nameMap[base] || base;
    return (
        availableVoices.find(v => v.lang.toLowerCase() === ttsCode.toLowerCase()) ||
        availableVoices.find(v => v.lang.toLowerCase().startsWith(base + '-')) ||
        availableVoices.find(v => v.lang.toLowerCase() === base) ||
        availableVoices.find(v => v.name.toLowerCase().includes(nameHint)) ||
        availableVoices[0]
    );
}

// buildUtterance() is ONLY used by speakAndWait() in the Audio-Trainer.
// It checks the selAudioVoice dropdown for the user-selected voice.
function buildUtterance(text, langKey, rate) {
    const msg = new SpeechSynthesisUtterance(text.trim());
    msg.lang   = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) || 'de-DE';
    msg.rate   = parseFloat(rate) || 1.0;
    msg.volume = 1.0;
    msg.pitch  = 1.0;
    // Audio-trainer voice dropdown takes priority for target language
    if (langKey === conf.l3 && availableVoices.length > 0) {
        const voiceSelect = document.getElementById('selAudioVoice');
        if (voiceSelect && voiceSelect.value) {
            const sel = availableVoices.find(v => v.name === voiceSelect.value);
            if (sel) { msg.voice = sel; return msg; }
        }
    }
    const voice = findBestVoice(langKey);
    if (voice) msg.voice = voice;
    return msg;
}

// speak() is the global TTS function used by ALL speaker buttons in the app.
// Uses ElevenLabs when key is set, falls back to speechSynthesis.
function speak(text, langKey, rate = 1.0) {
    if (!text || !text.trim()) return;
    if (elevenlabsApiKey) {
        const voiceId = getElevenLabsVoiceForLang(langKey);
        if (voiceId) { speakElevenLabs(text, voiceId); return; }
    }
    if (!window.speechSynthesis) return;
    const ss = window.speechSynthesis;
    ss.cancel();
    ss.resume();
    const msg = new SpeechSynthesisUtterance(text.trim());
    msg.lang   = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) || 'de-DE';
    msg.rate   = parseFloat(rate) || 1.0;
    msg.volume = 1.0;
    msg.pitch  = 1.0;
    const voice = findBestVoice(langKey);
    if (voice) msg.voice = voice;
    msg.onerror = (e) => { if (e.error !== 'interrupted') logCustomError('speak', e.error || String(e)); };
    ss.speak(msg);
}

// ==========================================
// 4. APP-INITIALISIERUNG & UI HILFSFUNKTIONEN
// ==========================================
function escapeHTML(str) { return !str ? "" : String(str).replace(/[&<>'"]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[m]); }
function safeJS(str) { return !str ? "" : String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;"); }

function removeBrokenServiceWorkers() {
    if('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for(let registration of registrations) { registration.unregister(); }
        }).catch(()=>{});
    }
}

async function clearAppCache() {
    showToast('🔄 Cache wird geleert…', 'info');
    try {
        // 1) Deregister all service workers
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
        // 2) Clear all Cache Storage entries
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        }
        showToast('✅ Cache geleert — Seite wird neu geladen…', 'success');
        // 3) Force hard reload, bypassing any browser cache
        setTimeout(() => {
            window.location.href = window.location.pathname + '?nocache=' + Date.now();
        }, 1000);
    } catch(e) {
        logCustomError('clearAppCache', e);
        showToast('⚠️ Fehler beim Leeren. Seite wird trotzdem neu geladen…', 'error');
        setTimeout(() => {
            window.location.href = window.location.pathname + '?nocache=' + Date.now();
        }, 1500);
    }
}

function updateVersionDisplay() {
    const badge = document.getElementById('versionBadge');
    const footer = document.getElementById('footerVersion');
    if (badge) badge.textContent = 'v' + APP_VERSION;
    if (footer) footer.textContent = APP_VERSION;
}

function init() {
    removeBrokenServiceWorkers();
    updateVersionDisplay();
    applyDarkMode();
    if(document.getElementById('inpGeminiKey')) document.getElementById('inpGeminiKey').value = geminiApiKey;
    if(document.getElementById('inpDeeplKey')) document.getElementById('inpDeeplKey').value = deeplApiKey;
    if(document.getElementById('inpElevenLabsKey')) document.getElementById('inpElevenLabsKey').value = elevenlabsApiKey;
    if (elevenlabsApiKey) { loadElevenLabsVoices(); loadElevenLabsSubscription(); }
    try { const storedNames = localStorage.getItem('trainerUserNames'); if(storedNames) userNames = JSON.parse(storedNames); const savedIdx = localStorage.getItem('trainerUserIdx'); if(savedIdx) currentCollIndex = parseInt(savedIdx); } catch(e){}
    const todayStr = new Date().toDateString(); if(statsToday.date !== todayStr) { statsToday = {learned:0, added:0, date:todayStr}; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); }
    loadUserLangs(); renderRenameInputs(); updateUserDropdown(); populateLangSelects(); checkStreak(); updateQuests(); updateSaveModeUI();
    // Onboarding on first visit
    if (!localStorage.getItem('onboardingDone')) { showOnboarding(); } else { showTab('home'); }
    if (window.speechSynthesis && !localStorage.getItem('ttsUnlocked')) {
        const b = document.getElementById('ttsUnlockBanner');
        if (b) b.style.display = 'flex';
    }
    if(typeof firebase !== 'undefined') { firebase.auth().signInAnonymously().catch((e)=>{}); firebase.auth().onAuthStateChanged((user) => { if (user) { currentUser = user; refreshData(); } }); }
}

// ==========================================
// DARK MODE
// ==========================================
function applyDarkMode() {
    const stored = localStorage.getItem('darkMode');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const on = stored !== null ? stored === '1' : prefersDark;
    document.documentElement.setAttribute('data-theme', on ? 'dark' : 'light');
    const tog = document.getElementById('darkModeToggle');
    if (tog) tog.checked = on;
}
function toggleDarkMode(on) {
    localStorage.setItem('darkMode', on ? '1' : '0');
    document.documentElement.setAttribute('data-theme', on ? 'dark' : 'light');
}
window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (localStorage.getItem('darkMode') === null) applyDarkMode();
});

// ==========================================
// NAVIGATION — BOTTOM BAR + SUBNAVS
// ==========================================
const TAB_TO_SECTION = {
    home:'home', add:'add',
    flashcards:'learn', study:'learn', quiz:'learn',
    roleplay:'practice', chat:'practice', live:'practice', audio:'practice', sentences:'practice',
    list:'more', arcade:'more', story:'more', achievements:'more'
};
const SECTION_SUBNAVS = { learn:'subnavLearn', practice:'subnavPractice', more:'subnavMore' };
const SECTION_DEFAULT = { home:'home', learn:'flashcards', add:'add', practice:'roleplay', more:'list' };

function showSection(name) { showTab(SECTION_DEFAULT[name]); }

// ==========================================
// ONBOARDING
// ==========================================
let obCurrent = 0;
function showOnboarding() {
    const ov = document.getElementById('onboardingOverlay');
    if (ov) { ov.style.display = 'flex'; setObSlide(0); }
}
function setObSlide(n) {
    obCurrent = n;
    [0,1,2].forEach(i => {
        document.getElementById('obs'+i).classList.toggle('active', i===n);
        document.getElementById('od'+i).classList.toggle('active', i===n);
    });
    const btn = document.getElementById('obBtn');
    if (btn) btn.textContent = n < 2 ? 'Weiter →' : '🚀 Los geht\'s!';
}
function obNext() {
    if (obCurrent < 2) { setObSlide(obCurrent + 1); return; }
    localStorage.setItem('onboardingDone', '1');
    const ov = document.getElementById('onboardingOverlay');
    if (ov) { ov.style.opacity = '0'; ov.style.transition = 'opacity 0.4s'; setTimeout(() => { ov.style.display = 'none'; }, 400); }
    showTab('home');
}

// ==========================================
// ACHIEVEMENTS
// ==========================================
const ACHIEVEMENTS = [
    { id:'first10',   icon:'🌱', name:'Erste Schritte',  desc:'10 Wörter hinzugefügt',   check:()=>allWords.length>=10 },
    { id:'words50',   icon:'📗', name:'Sammler',         desc:'50 Wörter',               check:()=>allWords.length>=50 },
    { id:'words100',  icon:'📚', name:'Wortschatz',      desc:'100 Wörter',              check:()=>allWords.length>=100 },
    { id:'words500',  icon:'🏛️', name:'Bibliothek',      desc:'500 Wörter',              check:()=>allWords.length>=500 },
    { id:'words2000', icon:'🌐', name:'Polyglott',       desc:'2000 Wörter',             check:()=>allWords.length>=2000 },
    { id:'streak3',   icon:'🔥', name:'Am Ball bleiben', desc:'3 Tage Streak',           check:()=>userStreak>=3 },
    { id:'streak7',   icon:'⚡', name:'Wochenkrieger',   desc:'7 Tage Streak',           check:()=>userStreak>=7 },
    { id:'streak30',  icon:'💎', name:'Monatsheld',      desc:'30 Tage Streak',          check:()=>userStreak>=30 },
    { id:'xp100',     icon:'⭐', name:'Fleißig',         desc:'100 XP gesammelt',        check:()=>userXP>=100 },
    { id:'xp500',     icon:'🌟', name:'Eifer',           desc:'500 XP gesammelt',        check:()=>userXP>=500 },
    { id:'xp2000',    icon:'🏆', name:'Meister',         desc:'2000 XP gesammelt',       check:()=>userXP>=2000 },
    { id:'quiz10',    icon:'🧩', name:'Quiz-Starter',    desc:'10 Quiz-Fragen richtig',  check:()=>(parseInt(localStorage.getItem('quizCorrect')||0))>=10 },
    { id:'quiz50',    icon:'🎯', name:'Quiz-Meister',    desc:'50 Quiz-Fragen richtig',  check:()=>(parseInt(localStorage.getItem('quizCorrect')||0))>=50 },
    { id:'fc100',     icon:'📇', name:'Karten-Fan',      desc:'100 Karten geübt',        check:()=>(parseInt(localStorage.getItem('fcPracticed')||0))>=100 },
    { id:'allLevels', icon:'🎓', name:'Level-Up!',       desc:'Ein Wort auf Level 5',    check:()=>allWords.some(w=>(w.level||0)>=5) },
];
let unlockedAch = new Set(JSON.parse(localStorage.getItem('unlockedAch')||'[]'));

function checkAchievements() {
    ACHIEVEMENTS.forEach(a => {
        if (!unlockedAch.has(a.id) && a.check()) {
            unlockedAch.add(a.id);
            localStorage.setItem('unlockedAch', JSON.stringify([...unlockedAch]));
            showAchievementPopup(a);
        }
    });
    renderAchievements();
}
function showAchievementPopup(a) {
    const p = document.getElementById('achPopup');
    if (!p) return;
    document.getElementById('achPopupIcon').textContent = a.icon;
    document.getElementById('achPopupName').textContent = a.name;
    document.getElementById('achPopupDesc').textContent = a.desc;
    p.classList.add('show');
    setTimeout(() => p.classList.remove('show'), 3500);
}
function renderAchievements() {
    const grid = document.getElementById('achGrid');
    if (!grid) return;
    grid.innerHTML = ACHIEVEMENTS.map(a => `<div class="ach-item${unlockedAch.has(a.id)?' unlocked':''}"><span class="ach-icon">${a.icon}</span><span class="ach-name">${a.name}</span></div>`).join('');
    const cnt = document.getElementById('achUnlockedCount');
    if (cnt) cnt.textContent = `${unlockedAch.size} von ${ACHIEVEMENTS.length} freigeschaltet`;
}

// ==========================================
// DASHBOARD
// ==========================================
const MOTIVATIONS = [
    '🌅 Heute ist ein guter Tag zum Lernen!',
    '💪 Kontinuität schlägt Intensität — jeden Tag ein bisschen!',
    '🧠 Jedes neue Wort öffnet eine neue Tür.',
    '🚀 Du bist {streak} Tage am Stück dabei — weiter so!',
    '🌍 Die Welt gehört denen, die ihre Sprache sprechen.',
    '⚡ Kurz aber regelmäßig — so funktioniert Sprachenlernen.',
    '🎯 Fokus auf die schwachen Wörter — da wächst du am meisten!',
];
function renderDashboard() {
    const mot = document.getElementById('dailyMotivation');
    if (mot) {
        const m = MOTIVATIONS[Math.floor(Math.random()*MOTIVATIONS.length)];
        mot.innerHTML = m.replace('{streak}', `<strong>${userStreak}</strong>`);
    }
    renderWeekBars();
    renderLevelBars();
    renderFamilyLeaderboard();
    renderWeakWords();
}
function recordDailyActivity() {
    const today = new Date().toDateString();
    let hist = JSON.parse(localStorage.getItem('weekActivity')||'{}');
    hist[today] = (hist[today]||0) + 1;
    // keep only last 30 days
    const keys = Object.keys(hist).sort((a,b)=>new Date(a)-new Date(b));
    if (keys.length > 30) keys.slice(0, keys.length-30).forEach(k=>delete hist[k]);
    localStorage.setItem('weekActivity', JSON.stringify(hist));
}
function renderWeekBars() {
    const el = document.getElementById('weekBars');
    if (!el) return;
    const hist = JSON.parse(localStorage.getItem('weekActivity')||'{}');
    const days = ['Mo','Di','Mi','Do','Fr','Sa','So'];
    const today = new Date();
    const weekData = [];
    for (let i=6; i>=0; i--) {
        const d = new Date(today); d.setDate(today.getDate()-i);
        const key = d.toDateString();
        weekData.push({ label: days[d.getDay()===0?6:d.getDay()-1], count: hist[key]||0 });
    }
    const max = Math.max(1, ...weekData.map(d=>d.count));
    el.innerHTML = weekData.map(d => `<div class="week-bar-wrap">
        <div class="week-bar-num">${d.count||''}</div>
        <div class="week-bar" style="height:${Math.max(4,(d.count/max)*60)}px"></div>
        <div class="week-bar-label">${d.label}</div>
    </div>`).join('');
}
function renderLevelBars() {
    const el = document.getElementById('levelBars');
    if (!el || !allWords.length) return;
    const LEVEL_COLORS = ['#9CA3AF','#FCD34D','#F59E0B','#10B981','#3B82F6','#4F46E5'];
    const counts = [0,0,0,0,0,0];
    allWords.forEach(w => counts[Math.min(5,w.level||0)]++);
    el.innerHTML = counts.map((c,i) => `<div class="level-bar-row">
        <span style="font-size:0.75rem;font-weight:800;width:52px;color:var(--text-light)">Level ${i}</span>
        <div class="level-bar-bg"><div class="level-bar-fill" style="width:${allWords.length?((c/allWords.length)*100).toFixed(1):0}%;background:${LEVEL_COLORS[i]}"></div></div>
        <span style="font-size:0.72rem;font-weight:800;width:28px;text-align:right;color:var(--text-light)">${c}</span>
    </div>`).join('');
}
function renderFamilyLeaderboard() {
    const el = document.getElementById('familyLeaderboard');
    if (!el) return;
    const medals = ['🥇','🥈','🥉','4️⃣'];
    const weekActs = JSON.parse(localStorage.getItem('weekActPerUser')||'{}');
    const entries = userNames.map((n,i) => ({ name:n, xp: parseInt(weekActs[i]||0) }))
        .sort((a,b)=>b.xp-a.xp);
    el.innerHTML = entries.map((e,i) => `<div class="family-row">
        <span class="family-medal">${medals[i]}</span>
        <span class="family-name">${escapeHTML(e.name)}</span>
        <span class="family-xp">${e.xp} XP</span>
    </div>`).join('');
}
function renderWeakWords() {
    const el = document.getElementById('weakWords');
    if (!el) return;
    const weak = [...allWords].filter(w=>(w.level||0)<=1).sort((a,b)=>(a.level||0)-(b.level||0)).slice(0,5);
    if (!weak.length) { el.innerHTML = '<p style="font-size:0.85rem;color:var(--text-light);margin:0;">Keine schwachen Wörter — super!</p>'; return; }
    el.innerHTML = weak.map(w=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border-soft);">
        <span style="font-weight:700">${escapeHTML(w[conf.l1])}</span>
        <span style="font-size:0.8rem;color:var(--text-light)">${escapeHTML(w[conf.l3])}</span>
        <span class="level-dot lvl-${w.level||0}"></span>
    </div>`).join('');
}

// ==========================================
// QUIZ MODE
// ==========================================
let quizWords=[], quizIndex=0, quizScore=0, quizTimerInterval=null, quizTimerLeft=15, lastQuizMode='mc';
function showQuizSetup() {
    document.getElementById('quizSetup').style.display='block';
    document.getElementById('quizGame').style.display='none';
    document.getElementById('quizResult').style.display='none';
    const hs = localStorage.getItem('quizHighscore')||'0';
    document.getElementById('quizHighscore').innerHTML = `<span style="font-size:0.85rem;color:var(--text-light)">🏆 Highscore: <strong>${hs} Punkte</strong></span>`;
}
function startQuiz(mode) {
    if (allWords.length < 4) return showToast('Min. 4 Wörter für Quiz nötig!','error');
    lastQuizMode = mode;
    quizWords = [...allWords].sort(()=>0.5-Math.random()).slice(0,10);
    quizIndex = 0; quizScore = 0;
    document.getElementById('quizSetup').style.display='none';
    document.getElementById('quizGame').style.display='block';
    document.getElementById('quizResult').style.display='none';
    document.getElementById('qTotal').textContent=quizWords.length;
    renderQuizQuestion(mode);
}
function renderQuizQuestion(mode) {
    if (quizIndex >= quizWords.length) { endQuiz(); return; }
    clearInterval(quizTimerInterval);
    const w = quizWords[quizIndex];
    document.getElementById('qNum').textContent = quizIndex+1;
    document.getElementById('qScore').textContent = quizScore;
    document.getElementById('qFeedback').textContent='';
    document.getElementById('qGap').style.display='none';
    document.getElementById('qOptions').innerHTML='';
    document.getElementById('qQuestion').textContent = w[conf.l1];
    if (mode==='gap') {
        const blanked = w[conf.l3].replace(/\S/g,(c,i)=>i===0?c:'_');
        document.getElementById('qQuestion').textContent = `${w[conf.l1]} → ${blanked}`;
        document.getElementById('qGap').style.display='block';
        document.getElementById('qGapInput').value='';
        document.getElementById('qGapInput').focus();
    } else {
        const wrongs = allWords.filter(x=>x.id!==w.id).sort(()=>0.5-Math.random()).slice(0,3).map(x=>x[conf.l3]);
        const opts = [w[conf.l3],...wrongs].sort(()=>0.5-Math.random());
        document.getElementById('qOptions').innerHTML = opts.map(o=>`<button class="quiz-option" onclick="checkAnswer(this,'${escapeHTML(o).replace(/'/g,"\\'")}','${escapeHTML(w[conf.l3]).replace(/'/g,"\\'")}','${mode}')">${escapeHTML(o)}</button>`).join('');
    }
    if (mode==='timed') {
        quizTimerLeft=15;
        document.getElementById('qTimerFill').style.width='100%';
        quizTimerInterval = setInterval(()=>{
            quizTimerLeft--;
            document.getElementById('qTimerFill').style.width=`${(quizTimerLeft/15)*100}%`;
            if (quizTimerLeft<=0) { clearInterval(quizTimerInterval); autoWrongQuiz(mode); }
        },1000);
    } else { document.getElementById('qTimerFill').style.width='100%'; }
}
function checkAnswer(btn, chosen, correct, mode) {
    clearInterval(quizTimerInterval);
    const isRight = chosen===correct;
    document.querySelectorAll('.quiz-option').forEach(b=>{
        if (b.textContent===correct) b.classList.add('correct');
    });
    if (!isRight) { btn.classList.add('wrong'); }
    else { quizScore += mode==='timed' ? Math.max(1,quizTimerLeft)*10 : 10; incrementQuizCorrect(); }
    document.getElementById('qFeedback').textContent = isRight ? '✅ Richtig!' : `❌ Richtig: ${correct}`;
    document.getElementById('qScore').textContent = quizScore;
    document.querySelectorAll('.quiz-option').forEach(b=>b.disabled=true);
    setTimeout(()=>{ quizIndex++; renderQuizQuestion(mode); }, 1200);
}
function checkGap() {
    clearInterval(quizTimerInterval);
    const w = quizWords[quizIndex];
    const inp = document.getElementById('qGapInput').value.trim().toLowerCase();
    const correct = (w[conf.l3]||'').trim().toLowerCase();
    const isRight = inp===correct;
    if (isRight) { quizScore+=10; incrementQuizCorrect(); }
    document.getElementById('qFeedback').textContent = isRight ? '✅ Richtig!' : `❌ Richtig: ${w[conf.l3]}`;
    document.getElementById('qGap').querySelector('button').disabled=true;
    setTimeout(()=>{ quizIndex++; renderQuizQuestion(lastQuizMode); }, 1400);
}
function autoWrongQuiz(mode) {
    document.getElementById('qFeedback').textContent = `⏱️ Zeit! Richtig: ${quizWords[quizIndex][conf.l3]}`;
    document.querySelectorAll('.quiz-option').forEach(b=>b.disabled=true);
    setTimeout(()=>{ quizIndex++; renderQuizQuestion(mode); }, 1200);
}
function incrementQuizCorrect() {
    const v = parseInt(localStorage.getItem('quizCorrect')||'0')+1;
    localStorage.setItem('quizCorrect',v);
    checkAchievements();
}
function endQuiz() {
    clearInterval(quizTimerInterval);
    document.getElementById('quizGame').style.display='none';
    document.getElementById('quizResult').style.display='block';
    document.getElementById('qFinalScore').textContent=`${quizScore} Punkte`;
    const pct = Math.round((quizScore/(quizWords.length*10))*100);
    const msgs = [[80,'🌟 Hervorragend!'],[60,'👍 Gut gemacht!'],[40,'😊 Solide!'],[0,'💪 Weiter üben!']];
    document.getElementById('qRating').textContent = msgs.find(([t])=>pct>=t)[1];
    const hs = parseInt(localStorage.getItem('quizHighscore')||'0');
    if (quizScore>hs) localStorage.setItem('quizHighscore',quizScore);
    addXP(Math.floor(quizScore/10));
    checkAchievements();
}

// ==========================================
// WORD DETAILS MODAL
// ==========================================
let wdExampleCache = {};
function openWordDetail(id) {
    const w = allWords.find(x=>x.id===id);
    if (!w) return;
    const ov = document.getElementById('wordDetailOverlay');
    if (!ov) return;
    const nextStr = w.nextReview ? new Date(w.nextReview).toLocaleDateString('de-DE') : 'Jetzt';
    document.getElementById('wdContent').innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <h3 style="margin:0;font-size:1.5rem;color:var(--primary)">${escapeHTML(w[conf.l1])}</h3>
            <div style="display:flex;gap:8px;">
                <button class="icon-btn" onclick="speak('${safeJS(w[conf.l3])}','${conf.l3}')" style="font-size:1.1rem;padding:8px;">🔊</button>
                <button class="icon-btn" onclick="closeWordDetail();editWord('${w.id}')" style="font-size:1rem;padding:8px;">✎</button>
            </div>
        </div>
        <div class="wd-row"><span style="font-size:1.4rem">${ALL_LANGS[conf.l1].flag}</span><span style="flex:1;font-weight:800">${escapeHTML(w[conf.l1])}</span></div>
        <div class="wd-row"><span style="font-size:1.4rem">${ALL_LANGS[conf.l2].flag}</span><span style="flex:1;font-weight:800">${escapeHTML(w[conf.l2])}</span></div>
        <div class="wd-row"><span style="font-size:1.4rem">${ALL_LANGS[conf.l3].flag}</span><span style="flex:1;font-weight:800">${escapeHTML(w[conf.l3])}</span><button class="icon-btn" onclick="speak('${safeJS(w[conf.l3])}','${conf.l3}')" style="font-size:0.9rem;padding:6px;border:none;background:transparent;">🔊</button></div>
        <div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap;">
            <span style="background:var(--primary-gradient);color:white;padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:800;">Level ${w.level||0}</span>
            <span style="background:rgba(229,231,235,0.6);padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:800;color:var(--text-light);">Nächste Wiederholung: ${nextStr}</span>
        </div>
        <div id="wdExampleArea"><button class="action-btn btn-secondary" style="font-size:0.85rem;padding:10px;margin-top:0;" onclick="loadWdExample('${w.id}','${safeJS(w[conf.l1])}','${safeJS(w[conf.l3])}')">✨ Beispielsatz generieren</button></div>
    `;
    if (wdExampleCache[id]) showWdExample(id, wdExampleCache[id]);
    ov.style.display = 'flex';
}
function closeWordDetail(e) {
    if (e && e.target !== document.getElementById('wordDetailOverlay')) return;
    document.getElementById('wordDetailOverlay').style.display='none';
}
async function loadWdExample(id, l1Word, l3Word) {
    const area = document.getElementById('wdExampleArea');
    if (!area) return;
    area.innerHTML='<div class="loader" style="display:block;margin:0;">KI generiert...</div>';
    const res = await callGemini(`Erstelle einen kurzen Beispielsatz (max 8 Wörter) auf ${ALL_LANGS[conf.l3].name} mit dem Wort "${l3Word}". Format: "${l3Word}" Satz auf ${ALL_LANGS[conf.l3].name} ||| Deutsche Übersetzung`);
    if (res) {
        wdExampleCache[id] = res;
        showWdExample(id, res);
    } else { area.innerHTML='<p style="font-size:0.8rem;color:var(--text-light)">Fehler beim Generieren.</p>'; }
}
function showWdExample(id, res) {
    const area = document.getElementById('wdExampleArea');
    if (!area) return;
    const parts = res.split('|||');
    const w = allWords.find(x=>x.id===id);
    area.innerHTML = `<div class="wd-example">
        <div style="font-weight:800;margin-bottom:4px;">${escapeHTML((parts[0]||'').trim())}</div>
        <div style="font-size:0.82rem;color:var(--text-light)">${escapeHTML((parts[1]||'').trim())}</div>
        <button class="icon-btn" onclick="speak('${safeJS((parts[0]||'').trim())}','${conf.l3}')" style="font-size:0.85rem;padding:5px;border:none;background:transparent;margin-top:6px;">🔊 Anhören</button>
    </div>`;
}

// ==========================================
// SENTENCE TRAINER
// ==========================================
async function generateDailySentences() {
    if (allWords.length < 3) return showToast('Min. 3 Wörter nötig!','error');
    document.getElementById('sentLoader').style.display='block';
    document.getElementById('sentList').innerHTML='';
    const sample = [...allWords].sort(()=>0.5-Math.random()).slice(0,8).map(w=>w[conf.l3]).join(', ');
    const res = await callGemini(`Erstelle genau 5 kurze Beispielsätze auf ${ALL_LANGS[conf.l3].name} (max je 10 Wörter) die diese Wörter verwenden: ${sample}. Format: jeder Satz auf einer eigenen Zeile, dann nach "---" die deutschen Übersetzungen in derselben Reihenfolge.`);
    document.getElementById('sentLoader').style.display='none';
    if (!res) return showToast('Fehler beim Generieren.','error');
    const halves = res.split('---');
    const svLines = (halves[0]||'').trim().split('\n').map(s=>s.trim()).filter(Boolean);
    const deLines = (halves[1]||'').trim().split('\n').map(s=>s.trim()).filter(Boolean);
    document.getElementById('sentList').innerHTML = svLines.map((s,i)=>`<div class="sent-item">
        <div class="sent-l3">${escapeHTML(s)} <button onclick="speak('${safeJS(s)}','${conf.l3}')" style="border:none;background:transparent;cursor:pointer;font-size:1rem;">🔊</button></div>
        <div class="sent-l1">${escapeHTML(deLines[i]||'')}</div>
    </div>`).join('');
}

function updateSaveModeUI() {
    const btn = document.getElementById('btnSaveMode'); if(!btn) return;
    if(isFastInputMode) { btn.innerHTML = "⚡ Modus: Schnelleingabe (Hier bleiben)"; btn.style.borderColor = "var(--secondary)"; btn.style.color = "var(--secondary)"; } 
    else { btn.innerHTML = "🔀 Modus: Normal (Zur Liste springen)"; btn.style.borderColor = "var(--border-soft)"; btn.style.color = "var(--text-light)"; }
}
function toggleSaveMode() { isFastInputMode = !isFastInputMode; localStorage.setItem('trainerFastInput', isFastInputMode); updateSaveModeUI(); }
function openSettings() {
    geminiApiKey = localStorage.getItem('trainerGeminiKey') || "";
    deeplApiKey = localStorage.getItem('trainerDeeplKey') || "";
    elevenlabsApiKey = localStorage.getItem('trainerElevenLabsKey') || "";
    const gEl = document.getElementById('inpGeminiKey'); if(gEl) gEl.value = geminiApiKey;
    const dEl = document.getElementById('inpDeeplKey'); if(dEl) dEl.value = deeplApiKey;
    const eEl = document.getElementById('inpElevenLabsKey'); if(eEl) eEl.value = elevenlabsApiKey;
    document.getElementById('settingsOverlay').style.display = 'flex';
}
function closeSettings() {
    saveApiKey();
    saveDeeplKey();
    saveElevenLabsKey();
    document.getElementById('settingsOverlay').style.display = 'none';
}

function activateTTS() {
    const banner = document.getElementById('ttsUnlockBanner');
    if (window.speechSynthesis) {
        const ss = window.speechSynthesis;
        ss.cancel();
        ss.resume();
        const unlock = new SpeechSynthesisUtterance('');
        unlock.volume = 0;
        ss.speak(unlock);
        ss.cancel();
        ss.resume();
        setTimeout(() => {
            const test = buildUtterance('Sprachausgabe aktiviert!', 'de', 1.0);
            ss.cancel();
            ss.resume();
            ss.speak(test);
        }, 200);
    }
    localStorage.setItem('ttsUnlocked', '1');
    if (banner) {
        banner.style.opacity = '0';
        banner.style.transform = 'translateY(-8px)';
        setTimeout(() => { banner.style.display = 'none'; }, 350);
    }
}
function saveApiKey() { geminiApiKey = document.getElementById('inpGeminiKey').value.trim(); localStorage.setItem('trainerGeminiKey', geminiApiKey); cachedGeminiModel = null; }
function saveDeeplKey() { deeplApiKey = document.getElementById('inpDeeplKey').value.trim(); localStorage.setItem('trainerDeeplKey', deeplApiKey); }

function saveElevenLabsKey() {
    elevenlabsApiKey = document.getElementById('inpElevenLabsKey').value.trim();
    localStorage.setItem('trainerElevenLabsKey', elevenlabsApiKey);
    if (elevenlabsApiKey) {
        loadElevenLabsVoices();
        loadElevenLabsSubscription();
    } else {
        elevenlabsVoices = [];
        updateVoiceDropdown();
    }
}

function saveElevenLabsVoiceLang(langKey) {
    const val = document.getElementById(`selElevenLabsVoice_${langKey}`)?.value || '';
    localStorage.setItem(`trainerElevenLabsVoice_${langKey}`, val);
}

function getDefaultElevenLabsVoiceId() {
    const adam = elevenlabsVoices.find(v => v.name === 'Adam');
    if (adam) return adam.voice_id;
    const rachel = elevenlabsVoices.find(v => v.name === 'Rachel');
    if (rachel) return rachel.voice_id;
    return elevenlabsVoices[0]?.voice_id || '';
}

function getElevenLabsVoiceForLang(langKey) {
    const stored = localStorage.getItem(`trainerElevenLabsVoice_${langKey}`);
    if (stored && elevenlabsVoices.some(v => v.voice_id === stored)) return stored;
    return elevenlabsVoiceId || getDefaultElevenLabsVoiceId();
}

function autoAssignLangVoices() {
    ['de', 'en', 'sv'].forEach(lang => {
        if (localStorage.getItem(`trainerElevenLabsVoice_${lang}`)) return;
        const langNames = { de: ['german', 'deutsch'], en: ['english', 'american', 'british'], sv: ['swedish', 'svenska'] };
        const hints = langNames[lang] || [];
        const match = elevenlabsVoices.find(v =>
            hints.some(h => (v.labels?.language || '').toLowerCase().includes(h) ||
                            (v.labels?.accent || '').toLowerCase().includes(h))
        );
        const fallback = lang === 'en' ? getDefaultElevenLabsVoiceId() : elevenlabsVoices[0]?.voice_id || '';
        const chosen = match?.voice_id || fallback;
        if (chosen) localStorage.setItem(`trainerElevenLabsVoice_${lang}`, chosen);
    });
}

async function loadElevenLabsVoices() {
    if (!elevenlabsApiKey) return;
    try {
        const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': elevenlabsApiKey }
        });
        if (!resp.ok) { logCustomError('loadElevenLabsVoices', resp.status); return; }
        const data = await resp.json();
        elevenlabsVoices = (data.voices || []).sort((a, b) => a.name.localeCompare(b.name));
        autoAssignLangVoices();
        updateElevenLabsLangDropdowns();
        updateVoiceDropdown();
    } catch(e) {
        logCustomError('loadElevenLabsVoices', e.message);
    }
}

function updateElevenLabsLangDropdowns() {
    const options = '<option value="">— Stimme wählen —</option>' +
        elevenlabsVoices.map(v => `<option value="${escapeHTML(v.voice_id)}">${escapeHTML(v.name)}</option>`).join('');
    ['de', 'en', 'sv'].forEach(lang => {
        const sel = document.getElementById(`selElevenLabsVoice_${lang}`);
        if (!sel) return;
        sel.innerHTML = options;
        const stored = localStorage.getItem(`trainerElevenLabsVoice_${lang}`) || '';
        if (stored && elevenlabsVoices.some(v => v.voice_id === stored)) sel.value = stored;
    });
}

async function loadElevenLabsSubscription() {
    if (!elevenlabsApiKey) return;
    const info = document.getElementById('elevenlabsSubInfo');
    if (!info) return;
    info.textContent = 'Lade Nutzungsdaten…';
    try {
        const resp = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
            headers: { 'xi-api-key': elevenlabsApiKey }
        });
        if (!resp.ok) { info.textContent = ''; return; }
        const d = await resp.json();
        const used = d.character_count || 0;
        const limit = d.character_limit || 0;
        const remaining = (limit - used).toLocaleString('de-DE');
        const total = limit.toLocaleString('de-DE');
        info.textContent = `Zeichen verfügbar: ${remaining} / ${total}`;
    } catch(e) {
        info.textContent = '';
        logCustomError('loadElevenLabsSubscription', e.message);
    }
}

async function speakElevenLabs(text, voiceId) {
    if (!elevenlabsApiKey || !voiceId || !text || !text.trim()) return;
    if (currentElevenLabsAudio) {
        currentElevenLabsAudio.pause();
        currentElevenLabsAudio = null;
    }
    try {
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: { 'xi-api-key': elevenlabsApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text.trim(),
                model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            logCustomError('speakElevenLabs', JSON.stringify(err));
            return;
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        await new Promise((resolve) => {
            const audio = new Audio(url);
            currentElevenLabsAudio = audio;
            audio.onended = () => { currentElevenLabsAudio = null; URL.revokeObjectURL(url); resolve(); };
            audio.onerror = () => { currentElevenLabsAudio = null; URL.revokeObjectURL(url); resolve(); };
            audio.play().catch(() => { currentElevenLabsAudio = null; URL.revokeObjectURL(url); resolve(); });
        });
    } catch(e) {
        logCustomError('speakElevenLabs', e.message);
    }
}

async function testApiKeys() {
    const box = document.getElementById('apiKeyTestResults');
    if (!box) return;
    box.style.display = 'block';
    box.innerHTML = '<span style="color:#94a3b8;">⏳ Teste Keys…</span>';

    const keys = geminiApiKey.split(',').map(k => k.trim()).filter(k => k);
    if (keys.length === 0) {
        box.innerHTML = '<span style="color:#f87171;">Kein Gemini API-Key eingetragen.</span>';
        return;
    }

    const minimalPayload = {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }]
    };

    let html = `<div style="color:#94a3b8;margin-bottom:6px;">Modelle: <b style="color:#e2e8f0;">${GEMINI_MODELS.join(', ')}</b></div>`;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const preview = '…' + key.slice(-6);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS[0]}:generateContent?key=${key}`;
        let status = '?', ok = false, detail = '';
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(minimalPayload)
            });
            status = resp.status;
            const d = await resp.json();
            if (d.error) {
                detail = d.error.message || JSON.stringify(d.error);
            } else if (d.candidates?.[0]?.content?.parts?.[0]?.text) {
                ok = true;
            } else {
                detail = 'Leere Antwort: ' + JSON.stringify(d).slice(0, 120);
            }
        } catch(e) {
            detail = 'Netzwerkfehler: ' + e.message;
        }

        const color  = ok ? '#4ade80' : '#f87171';
        const icon   = ok ? '✅' : '❌';
        const label  = ok ? 'OK' : `HTTP ${status}`;
        html += `<div style="padding:5px 0;border-bottom:1px solid #1e293b;">`;
        html += `<span style="color:${color};">${icon} Key ${i+1} <b>${escapeHTML(preview)}</b> — ${label}</span>`;
        if (detail) html += `<div style="color:#fbbf24;font-size:0.72rem;margin-top:2px;word-break:break-all;">${escapeHTML(detail)}</div>`;
        html += `</div>`;
    }

    // Also test DeepL if a key is present
    if (deeplApiKey.trim()) {
        const dk = deeplApiKey.trim();
        const dPreview = '…' + dk.slice(-6);
        let dOk = false, dDetail = '';
        try {
            const body = new URLSearchParams({ auth_key: dk, text: 'Hello', source_lang: 'EN', target_lang: 'DE' });
            const resp = await fetch(getDeeplUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });
            const d = await resp.json();
            if (d.translations?.[0]?.text) { dOk = true; }
            else { dDetail = d.message || JSON.stringify(d).slice(0, 120); }
        } catch(e) { dDetail = 'Netzwerkfehler: ' + e.message; }

        const dColor = dOk ? '#4ade80' : '#f87171';
        const dIcon  = dOk ? '✅' : '❌';
        html += `<div style="padding:5px 0;margin-top:6px;">`;
        html += `<span style="color:#94a3b8;">DeepL </span><span style="color:${dColor};">${dIcon} <b>${escapeHTML(dPreview)}</b> — ${dOk ? 'OK' : 'Fehler'}</span>`;
        if (dDetail) html += `<div style="color:#fbbf24;font-size:0.72rem;margin-top:2px;word-break:break-all;">${escapeHTML(dDetail)}</div>`;
        html += `</div>`;
    }

    box.innerHTML = html;
}

function showModelPanel(html) {
    let panel = document.getElementById('modelListPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'modelListPanel';
        panel.style.cssText = 'position:fixed;top:60px;right:12px;width:320px;max-width:94vw;background:#0f172a;color:#f8fafc;font-family:monospace;font-size:0.75rem;padding:14px 16px;border-radius:14px;border:2px solid #6366f1;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.6);max-height:75vh;overflow-y:auto;line-height:1.6;';
        document.body.appendChild(panel);
    }
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;position:sticky;top:0;background:#0f172a;padding-bottom:4px;border-bottom:1px solid #1e293b;"><strong style="color:#818cf8;">📋 Gemini Modelle</strong><button onclick="document.getElementById('modelListPanel').remove()" style="background:#6366f1;color:white;border:none;border-radius:8px;padding:3px 10px;cursor:pointer;font-weight:800;">✕</button></div>${html}`;
}

async function listGeminiModels() {
    const keys = geminiApiKey.split(',').map(k => k.trim()).filter(k => k);
    const box = document.getElementById('apiKeyTestResults');
    if (box) { box.style.display = 'block'; box.innerHTML = '<span style="color:#94a3b8;">⏳ Rufe Modellliste ab…</span>'; }
    if (!keys.length) {
        const msg = '<span style="color:#f87171;">Kein Gemini API-Key eingetragen.</span>';
        if (box) box.innerHTML = msg;
        showModelPanel(msg);
        return;
    }

    const key = keys[0];
    try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const d = await resp.json();
        if (d.error) {
            const errHtml = `<span style="color:#f87171;">❌ HTTP ${resp.status}</span><br><pre style="color:#fbbf24;white-space:pre-wrap;word-break:break-all;margin:4px 0 0;">${escapeHTML(JSON.stringify(d.error, null, 2))}</pre>`;
            if (box) box.innerHTML = errHtml;
            showModelPanel(errHtml);
            return;
        }
        const models = (d.models || []);
        let listHtml = `<div style="color:#94a3b8;margin-bottom:8px;">Key: …${escapeHTML(key.slice(-6))} &nbsp;|&nbsp; <b style="color:#e2e8f0;">${models.length}</b> Modelle</div>`;
        for (const m of models) {
            const canGenerate = (m.supportedGenerationMethods || []).includes('generateContent');
            const color = canGenerate ? '#4ade80' : '#64748b';
            const tag = canGenerate ? ' <span style="color:#818cf8;">[✓]</span>' : '';
            listHtml += `<div style="color:${color};padding:1px 0;word-break:break-all;">${escapeHTML(m.name)}${tag}</div>`;
        }
        if (models.length === 0) listHtml += '<div style="color:#fbbf24;">Keine Modelle zurückgegeben.</div>';
        if (box) box.innerHTML = listHtml;
        showModelPanel(listHtml);
    } catch(e) {
        const errHtml = `<span style="color:#f87171;">❌ Netzwerkfehler: ${escapeHTML(e.message)}</span>`;
        if (box) box.innerHTML = errHtml;
        showModelPanel(errHtml);
    }
}

function alertGeminiModels() {
    fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + document.querySelector('#inpGeminiKey').value.split(',')[0].trim())
        .then(r => r.json())
        .then(d => alert(d.models ? d.models.map(m => m.name).join('\n') : JSON.stringify(d)));
}

function showTab(n) {
    try {
        if(isLiveRecording) toggleLiveRecord();
        if(isChatSessionActive) toggleChatRecord();
        if(isAudioRunning && n !== 'audio') toggleAudioTrainer();

        // Hide all tabs
        const allTabIds = ['tabAdd','tabFlashcards','tabChat','tabLive','tabStudy','tabList','tabArcade','tabStory','tabRoleplay','tabAudio','tabHome','tabQuiz','tabSentences','tabAchievements'];
        allTabIds.forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
        const activeTab = document.getElementById('tab' + n.charAt(0).toUpperCase() + n.slice(1));
        if(activeTab) activeTab.style.display = 'block';

        // Bottom nav active state
        const section = TAB_TO_SECTION[n] || 'home';
        document.querySelectorAll('.bnav-btn').forEach(b=>b.classList.remove('active'));
        const bnavBtn = document.getElementById('bnav-'+section);
        if (bnavBtn) bnavBtn.classList.add('active');

        // Show correct subnav, update its active button
        ['subnavLearn','subnavPractice','subnavMore'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.classList.remove('visible'); el.querySelectorAll('button').forEach(b=>b.classList.remove('active')); }
        });
        const subnavId = SECTION_SUBNAVS[section];
        if (subnavId) {
            const subnav = document.getElementById(subnavId);
            if (subnav) {
                subnav.classList.add('visible');
                subnav.querySelectorAll('button').forEach(b => {
                    if ((b.getAttribute('onclick')||'').includes(`'${n}'`)) b.classList.add('active');
                });
            }
        }

        if(n === 'list') { document.getElementById('listSearch').value = ''; renderList(); }
        if(n === 'study') generateStudyList();
        if(n === 'flashcards' && fcPool.length === 0) initFlashcards(false);
        if(n === 'arcade') openMiniGame('Menu');
        if(n === 'home') renderDashboard();
        if(n === 'quiz') showQuizSetup();
        if(n === 'achievements') renderAchievements();
        recordDailyActivity();
    } catch(err) { logCustomError("Tab Navigation", err); }
}

function playSound(type) {
    try {
        const windowAudio = window.AudioContext || window.webkitAudioContext; if(!windowAudio) return;
        const ctx = new windowAudio(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.connect(gain); gain.connect(ctx.destination);
        if(type === 'success') { osc.type = 'sine'; osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1); gain.gain.setValueAtTime(0.1, ctx.currentTime); osc.start(); osc.stop(ctx.currentTime + 0.15); } 
        else if(type === 'error') { osc.type = 'sawtooth'; osc.frequency.setValueAtTime(300, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.2); gain.gain.setValueAtTime(0.1, ctx.currentTime); osc.start(); osc.stop(ctx.currentTime + 0.25); } 
    } catch(e){}
}

function fireConfetti() {
    const colors = ['#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#3B82F6'];
    for(let i=0; i<50; i++) { 
        const c = document.createElement('div'); c.className = 'confetti'; c.style.left = Math.random() * 100 + 'vw'; c.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)]; c.style.top = '-10px'; c.style.animationDuration = (Math.random() * 2 + 2) + 's'; 
        document.body.appendChild(c); setTimeout(() => c.remove(), 4000); 
    }
    playSound('success');
}

function speakInput(inputId, slot) { const text = document.getElementById(inputId).value; if(!text) return; const langKey = slot === 1 ? conf.l1 : (slot === 2 ? conf.l2 : conf.l3); speak(text, langKey); }
function checkStreak() { const today = new Date().toDateString(); if(lastActiveDate !== today) { const yesterday = new Date(Date.now() - 86400000).toDateString(); if(lastActiveDate === yesterday) { userStreak++; } else { userStreak = 1; } lastActiveDate = today; localStorage.setItem('trainerLastDate', today); localStorage.setItem('trainerStreak', userStreak); } updateStatsUI(); }
function addXP(amount) {
    userXP += amount;
    localStorage.setItem('trainerXP', userXP);
    // Track per-user weekly XP for family leaderboard
    const wap = JSON.parse(localStorage.getItem('weekActPerUser')||'{}');
    wap[currentCollIndex] = (wap[currentCollIndex]||0) + amount;
    localStorage.setItem('weekActPerUser', JSON.stringify(wap));
    updateStatsUI();
    checkAchievements();
}
function getUserLevel() { return Math.floor(userXP / 100) + 1; }
function updateStatsUI() { if(document.getElementById('uiStreak')) document.getElementById('uiStreak').innerText = userStreak; if(document.getElementById('uiXP')) document.getElementById('uiXP').innerText = userXP; if(document.getElementById('uiLevel')) document.getElementById('uiLevel').innerText = getUserLevel(); }
function updateQuests() { try { if(statsToday.learned >= 5) { const q1 = document.getElementById('q1'); if(q1) q1.classList.add('quest-done'); } if(statsToday.added >= 2) { const q2 = document.getElementById('q2'); if(q2) q2.classList.add('quest-done'); } } catch(e){} }
function loadUserLangs() { try { const saved = localStorage.getItem('trainerLangs_' + currentCollIndex); if(saved) conf = JSON.parse(saved); } catch(e){} updateUIForLangs(); }

function populateLangSelects() { 
    const opts = Object.keys(ALL_LANGS).map(k => `<option value="${k}">${ALL_LANGS[k].flag} ${ALL_LANGS[k].name}</option>`).join(''); 
    ['selL1','selL2','selL3','liveSrcLang','liveTgtLang','chatSrcLang','chatTgtLang'].forEach(id => { const el = document.getElementById(id); if(!el) return; el.innerHTML = opts; if(id === 'selL1') el.value = conf.l1; if(id === 'selL2') el.value = conf.l2; if(id === 'selL3') el.value = conf.l3; if(id === 'chatTgtLang') el.value = conf.l3; }); 
}
function langChanged() { conf.l1 = document.getElementById('selL1').value; conf.l2 = document.getElementById('selL2').value; conf.l3 = document.getElementById('selL3').value; localStorage.setItem('trainerLangs_' + currentCollIndex, JSON.stringify(conf)); updateUIForLangs(); populateLangSelects(); refreshData(); updateVoiceDropdown(); }
function updateUIForLangs() { 
    if(document.getElementById('lblL1')) document.getElementById('lblL1').innerText = ALL_LANGS[conf.l1].name; 
    if(document.getElementById('lblL2')) document.getElementById('lblL2').innerText = ALL_LANGS[conf.l2].name; 
    if(document.getElementById('lblL3')) document.getElementById('lblL3').innerText = ALL_LANGS[conf.l3].name; 
    ['vTitle1','vTitle2','vTitle3'].forEach((id, i) => { const el = document.getElementById(id); if(el) el.innerText = ALL_LANGS[conf['l'+(i+1)]].name; }); 
    const fcL1 = document.getElementById('fcLabelL1'); if(fcL1) fcL1.innerText = ALL_LANGS[conf.l1].name;
    const fcL3 = document.getElementById('fcLabelL3'); if(fcL3) fcL3.innerText = ALL_LANGS[conf.l3].name;
}
function renderRenameInputs() { if(!document.getElementById('renameContainer')) return; document.getElementById('renameContainer').innerHTML = userNames.map((n, i) => `<div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;"><span style="font-weight:bold; color:var(--primary); width:20px;">${i+1}.</span><input type="text" id="name${i}" value="${escapeHTML(n)}" onchange="saveName(${i})" style="padding: 10px;"></div>`).join(''); }
function updateUserDropdown() { if(!document.getElementById('selUser')) return; document.getElementById('selUser').innerHTML = userNames.map((n, i) => `<option value="${i}" ${i===currentCollIndex?'selected':''}>👤 ${escapeHTML(n)}</option>`).join(''); }
function saveName(idx) { const val = document.getElementById('name'+idx).value.trim(); if(val) { userNames[idx] = val; localStorage.setItem('trainerUserNames', JSON.stringify(userNames)); updateUserDropdown(); } }
function switchUser() { currentCollIndex = parseInt(document.getElementById('selUser').value); localStorage.setItem('trainerUserIdx', currentCollIndex); loadUserLangs(); populateLangSelects(); refreshData(); }

// ==========================================
// 5. DEEPL ÜBERSETZUNGS-ENGINE
// ==========================================

// Maps internal lang keys to DeepL language codes
const DEEPL_LANG_MAP = {
    de: 'DE', en: 'EN', sv: 'SV', fr: 'FR',
    es: 'ES', it: 'IT', no: 'NB'
};

function getDeeplLang(key) {
    return DEEPL_LANG_MAP[key] || key.toUpperCase();
}

// Returns the correct DeepL API base URL — free keys end with :fx
function getDeeplUrl() {
    return deeplApiKey.trim().endsWith(':fx')
        ? 'https://api-free.deepl.com/v2/translate'
        : 'https://api.deepl.com/v2/translate';
}

// Translates a single text with DeepL. Returns the translated string or null.
// Network/CORS errors fall back silently (console.warn only — no in-app log, no toast).
async function translateWithDeepL(text, sourceLangKey, targetLangKey) {
    if (!deeplApiKey.trim() || !text || !text.trim()) return null;
    try {
        const body = new URLSearchParams({
            auth_key: deeplApiKey.trim(),
            text: text.trim(),
            source_lang: getDeeplLang(sourceLangKey),
            target_lang: getDeeplLang(targetLangKey)
        });
        const resp = await fetch(getDeeplUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
        const d = await resp.json();
        if (d.message || d.error_code) {
            console.warn('DeepL API:', d.error_code || '', d.message || '');
            return null;
        }
        return d.translations?.[0]?.text || null;
    } catch(e) {
        // CORS and network errors are expected in browser — fall back silently to Gemini
        console.warn('DeepL network (falling back to Gemini):', e.message);
        return null;
    }
}

// Translates text into ALL configured languages at once using DeepL.
// sourceLangKey is the language of the input text.
// Returns { [conf.l1]: '...', [conf.l2]: '...', [conf.l3]: '...' } or null.
async function translateAllWithDeepL(text, sourceLangKey) {
    if (!deeplApiKey.trim()) return null;
    const targets = [conf.l1, conf.l2, conf.l3].filter(l => l !== sourceLangKey);
    const results = { [sourceLangKey]: text };
    for (const tgt of targets) {
        const t = await translateWithDeepL(text, sourceLangKey, tgt);
        if (t === null) return null; // any failure → fall back to Gemini
        results[tgt] = t;
    }
    return results;
}

// ==========================================
// 5b. GEMINI API ANBINDUNG
// ==========================================
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite-001'];

const AUDIO_TOPICS = [
    { value: 'general',    label: '🌍 Allgemein',           prompt: 'einem alltäglichen Thema (Einkaufen, Reisen, Arbeit, Freizeit, Essen, Wetter, Familie, Sport, Gesundheit, Verkehr)' },
    { value: 'work',       label: '💼 Beruf & Arbeit',       prompt: 'Beruf und Arbeit (Büro, Meetings, Kollegen, Bewerbung, Berufsalltag, Telefonate)' },
    { value: 'restaurant', label: '🍽️ Restaurant & Essen',   prompt: 'Restaurant und Essen (Bestellung, Speisekarte, Kellner, Bezahlen, Empfehlungen)' },
    { value: 'health',     label: '🏥 Arzt & Gesundheit',    prompt: 'Arzt und Gesundheit (Symptome, Behandlung, Apotheke, Termine, Krankheit)' },
    { value: 'shopping',   label: '🛒 Einkaufen',            prompt: 'Einkaufen (Supermarkt, Kleidung, Preise, Größen, Reklamation, Kasse)' },
    { value: 'travel',     label: '✈️ Reisen & Hotel',       prompt: 'Reisen und Hotel (Buchung, Check-in, Wegbeschreibung, Flughafen, Sehenswürdigkeiten)' },
    { value: 'family',     label: '👨‍👩‍👧 Familie & Zuhause',   prompt: 'Familie und Zuhause (Haushalt, Kinder, Verwandte, Tagesablauf, Wohnen)' },
    { value: 'school',     label: '🏫 Schule & Bildung',     prompt: 'Schule und Bildung (Unterricht, Prüfungen, Lehrer, Hausaufgaben, Klassenzimmer)' },
    { value: 'bank',       label: '🏦 Bank & Behörden',      prompt: 'Bank und Behörden (Konto, Überweisung, Antrag, Formulare, Ämter)' },
    { value: 'transport',  label: '🚗 Verkehr & Transport',  prompt: 'Verkehr und Transport (Bus, Bahn, Auto, Richtungen, Tickets, Haltestellen)' },
    { value: 'smalltalk',  label: '💬 Smalltalk & Begrüßung', prompt: 'Smalltalk und Begrüßung (Kennenlernen, Wetter, Wochenende, höfliche Phrasen)' },
    { value: 'leisure',    label: '🎭 Freizeit & Hobby',     prompt: 'Freizeit und Hobby (Sport, Musik, Kino, Ausgehen, Veranstaltungen, Interessen)' },
];

function showApiError(html) {
    let box = document.getElementById('apiErrorBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'apiErrorBox';
        box.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:92%;max-width:580px;background:#1e293b;color:#f8fafc;font-family:monospace;font-size:0.78rem;padding:14px 16px;border-radius:14px;border:2px solid #EF4444;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.5);max-height:70vh;overflow-y:auto;line-height:1.5;';
        box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;position:sticky;top:0;background:#1e293b;padding-bottom:4px;"><strong style="color:#EF4444;font-size:0.85rem;">⚠️ API-Fehler</strong><button onclick="document.getElementById('apiErrorBox').remove()" style="background:#EF4444;color:white;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;font-weight:800;">✕ Schließen</button></div><div id="apiErrorEntries"></div>`;
        document.body.appendChild(box);
    }
    const entries = document.getElementById('apiErrorEntries') || box;
    const ts = new Date().toLocaleTimeString('de-DE');
    const entry = document.createElement('div');
    entry.style.cssText = 'border-top:1px solid #334155;padding-top:8px;margin-top:8px;';
    entry.innerHTML = `<span style="color:#94a3b8;font-size:0.72rem;">${ts}</span><br>${html}`;
    entries.appendChild(entry);
    box.scrollTop = box.scrollHeight;
}

async function callGemini(prompt, imageBase64 = null, systemPrompt = null) {
    const keys = geminiApiKey.split(',').map(k => k.trim()).filter(k => k);
    if (keys.length === 0) {
        showToast("⚠️ Bitte hinterlege mindestens einen API-Key in den Einstellungen.", "error");
        return null;
    }

    const activeLoader = Array.from(document.querySelectorAll('.loader')).find(el => el.offsetWidth > 0);
    const originalLoaderText = activeLoader ? activeLoader.innerText : "";

    // Build payload once, reused across all model/key attempts
    let payload = { contents: [] };
    if (systemPrompt) {
        payload.contents.push({ role: "user",  parts: [{ text: "SYSTEM-ANWEISUNG: " + systemPrompt }] });
        payload.contents.push({ role: "model", parts: [{ text: "Verstanden." }] });
    }
    let userParts = [{ text: prompt }];
    if (imageBase64) {
        let mime = "image/jpeg";
        try { mime = imageBase64.match(/data:(.*?);/)[1]; } catch(e) {}
        const b64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
        userParts.push({ inlineData: { mimeType: mime, data: b64 } });
    }
    payload.contents.push({ role: "user", parts: userParts });

    if (activeLoader) activeLoader.innerText = `KI (${GEMINI_MODELS[0]})…`;

    const collectedErrors = [];
    for (let ki = 0; ki < keys.length; ki++) {
        const key = keys[(currentApiKeyIndex + ki) % keys.length];
        for (let i = 0; i < GEMINI_MODELS.length; i++) {
            const model = GEMINI_MODELS[i];
            if (activeLoader) activeLoader.innerText = `KI (${model})…`;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
            try {
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const d = await resp.json();
                if (d.error) {
                    const errJson = JSON.stringify(d.error, null, 2);
                    logCustomError(`callGemini`, errJson);
                    collectedErrors.push(`<b>Modell:</b> ${model}<br><b>Key (Ende):</b> …${key.slice(-6)}<br><b>HTTP-Status:</b> ${resp.status}<br><pre style="margin:6px 0 0;white-space:pre-wrap;word-break:break-all;">${escapeHTML(errJson)}</pre>`);
                    continue;
                }
                const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) {
                    const raw = JSON.stringify(d, null, 2);
                    collectedErrors.push(`<b>Modell:</b> ${model}<br><b>Key (Ende):</b> …${key.slice(-6)}<br><b>HTTP-Status:</b> ${resp.status}<br><b>Problem:</b> Leere Antwort vom Modell<br><pre style="margin:6px 0 0;white-space:pre-wrap;word-break:break-all;">${escapeHTML(raw)}</pre>`);
                    continue;
                }
                if (activeLoader) activeLoader.innerText = originalLoaderText;
                currentApiKeyIndex = (currentApiKeyIndex + ki) % keys.length;
                return text.trim();
            } catch(e) {
                logCustomError(`callGemini network`, e.message);
                collectedErrors.push(`<b>Modell:</b> ${model}<br><b>Key (Ende):</b> …${key.slice(-6)}<br><b>Problem:</b> Netzwerkfehler<br><pre style="margin:6px 0 0;">${escapeHTML(e.message)}</pre>`);
            }
        }
    }

    // Alle Keys und Modelle fehlgeschlagen — jetzt Fehler anzeigen
    collectedErrors.forEach(err => showApiError(err));
    if (activeLoader) activeLoader.innerText = originalLoaderText;
    return null;
}

// ==========================================
// 6. AUDIO-TRAINER (DIE NEUE LERN-FUNKTION)
// ==========================================
const sleepAsync = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── ROBUSTE TTS-ENGINE FÜR AUDIO-TRAINER ────────────────────────────────────
// speakAndWait() guarantees strict serialization: resolves only when onend
// fires OR the calculated timeout expires — whichever comes first.
// Pre-speak sequence: cancel → wait (400ms Android / 300ms desktop) →
// resume → 100ms → speak(). This prevents Chrome Android from swallowing
// utterances when synthesis is in an undefined state after cancel().

async function speakAndWait(text, langKey, rate) {
    if (cancelAudio || !text || !text.trim()) return;
    if (elevenlabsApiKey) {
        const voiceId = getElevenLabsVoiceForLang(langKey);
        if (voiceId) { await speakElevenLabs(text, voiceId); return; }
    }
    if (!('speechSynthesis' in window)) return;
    const ss = window.speechSynthesis;
    const r = parseFloat(rate) || 1.0;

    // Step 1: hard-cancel any running utterance
    ss.cancel();
    // Step 2: wait for Chrome to fully reset (longer on Android Chrome)
    await sleepAsync(isAndroidChrome ? 400 : 300);
    if (cancelAudio) return;
    // Step 3: resume in case synthesis was paused
    ss.resume();
    // Step 4: brief gap so Chrome registers the resume before speak()
    await sleepAsync(100);
    if (cancelAudio) return;

    await new Promise((resolve) => {
        currentUtterance = buildUtterance(text, langKey, r);

        let done = false;
        const finish = () => { if (!done) { done = true; currentUtterance = null; resolve(); } };

        currentUtterance.onend   = finish;
        currentUtterance.onerror = (e) => {
            if (e.error !== 'interrupted') logCustomError('speakAndWait', e.error || String(e));
            finish();
        };

        // Timeout: (chars / rate) * 80ms + 1500ms safety buffer, hard cap 30s
        const timeoutMs = Math.min(30000, Math.ceil((text.trim().length / r) * 80) + 1500);
        setTimeout(finish, timeoutMs);

        ss.speak(currentUtterance);
    });
}

function setAudioStep(text) {
    const el = document.getElementById('audioStep');
    if (el) el.textContent = text;
}

async function toggleAudioTrainer() {
    const btn = document.getElementById('btnStartAudio');
    if (isAudioRunning) {
        isAudioRunning = false; cancelAudio = true;
        if (currentElevenLabsAudio) { currentElevenLabsAudio.pause(); currentElevenLabsAudio = null; }
        if (!elevenlabsApiKey && window.speechSynthesis) window.speechSynthesis.cancel();
        stopSynthKeepAlive();
        btn.innerHTML = "▶️ Audio-Trainer starten"; btn.style.background = "linear-gradient(135deg, #a855f7, #ec4899)";
        document.getElementById('audioDisplayL1').innerText = "Pausiert.";
        document.getElementById('audioDisplayL3').innerText = "";
        setAudioStep('');
        return;
    }
    isAudioRunning = true; cancelAudio = false;
    if (!elevenlabsApiKey) startSynthKeepAlive();
    btn.innerHTML = "⏹️ Audio-Trainer stoppen"; btn.style.background = "#EF4444";
    audioTrainerLoop();
}

async function audioTrainerLoop() {
    while (isAudioRunning && !cancelAudio) {
        // ── Satz generieren ───────────────────────────────────────────
        setAudioStep('⏳ Generiere Satz...');
        document.getElementById('audioLoader').style.display = 'block';

        const diff        = document.getElementById('selAudioDiff').value;
        const tgtLangName = ALL_LANGS[conf.l3].name;
        const now = Date.now();
        audioHistory = audioHistory.filter(item => (now - item.ts) < 1800000);
        const avoidList   = audioHistory.map(i => i.text).join('", "');
        const avoidPrompt = avoidList ? `Verwende AUF KEINEN FALL diese Sätze oder ähnliche: ["${avoidList}"]. ` : "";
        const topicVal    = document.getElementById('selAudioTopic')?.value || 'general';
        const topicDef    = AUDIO_TOPICS.find(t => t.value === topicVal) || AUDIO_TOPICS[0];
        const randomSeed  = Math.floor(Math.random() * 10000);
        const prompt = `Du bist ein Sprachtrainer. Erstelle EINEN realistischen, typischen Alltagssatz auf Niveau ${diff} zum Thema ${topicDef.prompt} (ID: ${randomSeed}). ${avoidPrompt}Gib ihn auf Deutsch und auf ${tgtLangName} zurück. JSON-Format: {"l1": "Deutscher Satz", "l3": "Übersetzung in ${tgtLangName}"}`;

        const res = await callGemini(prompt);
        document.getElementById('audioLoader').style.display = 'none';
        if (!res || cancelAudio) { if (!cancelAudio) await sleepAsync(3000); continue; }

        let sentenceObj;
        try {
            let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim();
            const sIdx = cleanStr.indexOf('{'); const eIdx = cleanStr.lastIndexOf('}');
            if (sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1);
            sentenceObj = JSON.parse(cleanStr);
        } catch (e) { await sleepAsync(2000); continue; }

        const l1Text = sentenceObj.l1;
        const l3Text = sentenceObj.l3;
        if (!l1Text || !l3Text) continue;

        audioHistory.push({ text: l1Text, ts: Date.now() });
        currentAudioSentence = { l1: l1Text, l3: l3Text };
        document.getElementById('audioDisplayL1').innerText = l1Text;
        document.getElementById('audioDisplayL3').innerText = "";

        const slowRate = parseFloat(document.getElementById('selAudioSlow').value);
        const pauseMs  = parseInt(document.getElementById('selAudioPause').value) * 1000;
        const reps     = parseInt(document.getElementById('selAudioReps').value) || 1;
        const l1Name   = ALL_LANGS[conf.l1] ? ALL_LANGS[conf.l1].name : 'Deutsch';
        const l3Name   = ALL_LANGS[conf.l3] ? ALL_LANGS[conf.l3].name : tgtLangName;

        // ── SCHRITT 1: Deutsch ────────────────────────────────────────
        if (cancelAudio) break;
        setAudioStep(`🔊 ${l1Name}...`);
        await speakAndWait(l1Text, conf.l1, 1.0);

        if (cancelAudio) break;
        await sleepAsync(pauseMs);
        document.getElementById('audioDisplayL3').innerText = l3Text;

        // ── SCHRITT 2: Fremdsprache normal ────────────────────────────
        if (cancelAudio) break;
        setAudioStep(`🔊 ${l3Name} normal...`);
        await speakAndWait(l3Text, conf.l3, 1.0);

        if (cancelAudio) break;
        await sleepAsync(pauseMs);

        // ── SCHRITTE 3…(2+reps): Fremdsprache langsam ────────────────
        for (let i = 0; i < reps; i++) {
            if (cancelAudio) break;
            setAudioStep(`🐢 ${l3Name} langsam ${i + 1}/${reps}...`);
            await speakAndWait(l3Text, conf.l3, slowRate);
            if (cancelAudio) break;
            await sleepAsync(pauseMs);
        }

        // ── ABSCHLUSS: Fremdsprache normal ────────────────────────────
        if (cancelAudio) break;
        setAudioStep(`🔊 ${l3Name} normal...`);
        await speakAndWait(l3Text, conf.l3, 1.0);

        if (cancelAudio) break;
        setAudioStep('✅ Nächster Satz...');
        await sleepAsync(2000);
    }
    setAudioStep('');
}

function saveAudioSentence() {
    if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    if(!currentAudioSentence.l1 || !currentAudioSentence.l3) return showToast("Kein Satz zum Speichern da!", "error");
    
    let d = { [conf.l1]: currentAudioSentence.l1, [conf.l2]: "", [conf.l3]: currentAudioSentence.l3, ts: firebase.firestore.FieldValue.serverTimestamp(), level: 0, nextReview: getNextReviewTimestamp(0) };
    db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).add(d).then(() => { playSound('success'); showToast("✅ Satz in Karteikarten gespeichert!", "success"); refreshData(); }).catch(e => logCustomError("Speichern Audio-Satz", e));
}

// ==========================================
// 7. RESTLICHE FUNKTIONEN (SPIELE, KARTEN, LISTEN)
// ==========================================
function invalidateRpBuffer() { rpOptionsBuffer = null; }
function checkCustomTopic() { const sel = document.getElementById('selRpTopic').value; document.getElementById('customTopicRow').style.display = sel === 'custom' ? 'flex' : 'none'; invalidateRpBuffer(); }
async function fetchRpSentencesFromGemini() {
    const selTopic = document.getElementById('selRpTopic').value; let topic = selTopic === 'custom' ? document.getElementById('inpCustomTopic').value.trim() || "Allgemeines Gespräch" : selTopic; const tgtLangName = ALL_LANGS[conf.l3].name; const diffSelect = document.getElementById('selRpDifficulty'); const diffText = diffSelect.options[diffSelect.selectedIndex].text; const intentions = ["eine höfliche Formulierung", "eine zielgerichtete Frage", "eine typische Antwort", "eine Bitte", "eine kurze Feststellung", "eine alltägliche Interaktion"]; const intention = intentions[Math.floor(Math.random()*intentions.length)]; const randomSeed = Math.floor(Math.random() * 10000);
    const shortSentenceRule = diffText.includes('A1') ? ' WICHTIG bei A1: Maximal 4-6 Wörter pro Satz, sehr einfache Grammatik, nur Grundvokabular.' : '';
    const prompt = `Du bist ein professioneller Sprachtrainer. Erstelle für das Szenario/Thema "${topic}" exakt DREI völlig unterschiedliche, aber absolut realistische Antwortmöglichkeiten in ${tgtLangName}. Niveau: ${diffText}.${shortSentenceRule} Satz 1: Höflich. Satz 2: Kurz/informell. Satz 3: Frage. Aspekt: ${intention} (ID: ${randomSeed}). Antworte AUSSCHLIESSLICH im folgenden JSON-Format: [{"l3": "...", "l1": "..."}, {"l3": "...", "l1": "..."}, {"l3": "...", "l1": "..."}]`;
    const res = await callGemini(prompt);
    if(res) { try { let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const sIdx = cleanStr.indexOf('['); const eIdx = cleanStr.lastIndexOf(']'); if(sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1); return JSON.parse(cleanStr); } catch(e) { logCustomError("JSON Parsing Szenarien", e); return null; } } return null;
}
function prefetchRpSentences() { if (!rpFetchPromise) { rpFetchPromise = fetchRpSentencesFromGemini().then(options => { if (options) rpOptionsBuffer = options; rpFetchPromise = null; }); } }
async function startRoleplay() { document.getElementById('rpArea').style.display = 'block'; document.getElementById('rpFeedbackBox').style.display = 'none'; let topic = document.getElementById('selRpTopic').value; if(topic === 'custom') topic = document.getElementById('inpCustomTopic').value.trim() || "Allgemeines Gespräch"; document.getElementById('rpTopicDisplay').innerText = topic.toUpperCase(); await generateRpSentence(); }
async function generateRpSentence() {
    stopRpWordByWord();
    document.getElementById('rpFeedbackBox').style.display = 'none'; document.getElementById('rpOptionsContainer').innerHTML = ""; document.getElementById('btnRpRefresh').style.display = 'none'; document.getElementById('rpLoader').style.display = 'block';
    let options = null;
    if (rpOptionsBuffer) { options = rpOptionsBuffer; rpOptionsBuffer = null; } else if (rpFetchPromise) { await rpFetchPromise; options = rpOptionsBuffer; rpOptionsBuffer = null; } else { options = await fetchRpSentencesFromGemini(); }
    document.getElementById('rpLoader').style.display = 'none'; document.getElementById('btnRpRefresh').style.display = 'inline-block';
    if(options) { renderRpOptions(options); prefetchRpSentences(); } else { document.getElementById('rpOptionsContainer').innerHTML = `<div style="text-align:center; color:#EF4444; font-weight:bold;">⚠️ Konnte Sätze nicht laden. Bitte versuche es erneut.</div>`; }
}
function renderRpOptions(options) {
    let html = ''; options.forEach((opt, idx) => { const jsSafeL3 = safeJS(opt.l3); html += `<div class="rp-option"><div class="rp-option-text" id="rpOptText_${idx}">${escapeHTML(opt.l3)}</div><div class="rp-option-trans">${escapeHTML(opt.l1)}</div><div class="rp-option-actions"><button class="icon-btn" onclick="speakRpSentence('${jsSafeL3}')" style="font-size: 1rem;">🔊 Hören</button><button class="icon-btn" id="rpWbwBtn_${idx}" onclick="startRpWordByWord('${jsSafeL3}', ${idx})" style="font-size:1rem; border-color:#8B5CF6; color:#8B5CF6; font-weight:800;" title="Wort für Wort – tippe um weiterzugehen">👆 Wort f. Wort</button><button class="icon-btn" id="rpMicBtn_${idx}" onclick="recordRpSpeech('${jsSafeL3}', 'rpMicBtn_${idx}')" style="border-color:var(--primary); color:var(--primary); font-weight:800; font-size:1rem;">🎤 Üben</button></div></div>`; });
    document.getElementById('rpOptionsContainer').innerHTML = html;
}
function speakRpSentence(text) { const speed = parseFloat(document.getElementById('selRpSpeed').value); speak(text, conf.l3, speed); }

function startRpWordByWord(text, optIdx) {
    // Stop any running wbw session first
    stopRpWordByWord();
    const speed = parseFloat(document.getElementById('selRpSpeed').value);
    // Strip punctuation for individual word speaking but keep original for display
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return;
    rpWbwState = { active: true, words, index: 0, speed, optIdx };
    // Highlight first word, add overlay instruction
    renderRpWbwHighlight(optIdx, 0);
    // Speak first word immediately
    speakRpWbwWord();
    // Add tap-anywhere handler
    let rpWbwTouchPending = false;
    rpWbwState.handler = (e) => {
        if (e.target && e.target.id && e.target.id.startsWith('rpWbwBtn_')) return;
        if (!rpWbwState.active) return;
        if (e.type === 'touchstart') {
            rpWbwTouchPending = true;
            e.preventDefault();
        } else if (e.type === 'click') {
            if (rpWbwTouchPending) { rpWbwTouchPending = false; return; }
        }
        rpWbwState.index++;
        if (rpWbwState.index >= rpWbwState.words.length) {
            stopRpWordByWord();
            return;
        }
        renderRpWbwHighlight(rpWbwState.optIdx, rpWbwState.index);
        speakRpWbwWord();
    };
    document.addEventListener('click', rpWbwState.handler, { capture: true });
    document.addEventListener('touchstart', rpWbwState.handler, { capture: true, passive: false });
    showToast("👆 Tippe irgendwo um das nächste Wort zu hören", "info");
}

function speakRpWbwWord() {
    if (!rpWbwState.active) return;
    const word = rpWbwState.words[rpWbwState.index].replace(/[.,!?;:]/g, '');
    speak(word, conf.l3, rpWbwState.speed);
}

function renderRpWbwHighlight(optIdx, currentWordIdx) {
    const container = document.getElementById(`rpOptText_${optIdx}`);
    if (!container) return;
    const words = rpWbwState.words;
    const html = words.map((w, i) => {
        if (i === currentWordIdx) return `<span style="background:#DDD6FE; color:#5B21B6; border-radius:4px; padding:0 3px; font-weight:900;">${escapeHTML(w)}</span>`;
        if (i < currentWordIdx) return `<span style="opacity:0.45;">${escapeHTML(w)}</span>`;
        return escapeHTML(w);
    }).join(' ');
    container.innerHTML = html;
}

function stopRpWordByWord() {
    if (rpWbwState.handler) {
        document.removeEventListener('click', rpWbwState.handler, { capture: true });
        document.removeEventListener('touchstart', rpWbwState.handler, { capture: true });
    }
    // Restore original text in the option box
    if (rpWbwState.active && rpWbwState.optIdx !== undefined) {
        const container = document.getElementById(`rpOptText_${rpWbwState.optIdx}`);
        if (container) container.innerHTML = rpWbwState.words.map(w => escapeHTML(w)).join(' ');
    }
    rpWbwState = { active: false, words: [], index: 0, speed: 0.6, handler: null };
    window.speechSynthesis && window.speechSynthesis.cancel();
}

function initPictureQuiz() {
    if (allWords.length < 4) { document.getElementById('picQuizGrid').innerHTML = '<p style="text-align:center;color:#EF4444;font-weight:700;">Bitte mindestens 4 Wörter hinzufügen!</p>'; return; }
    picQuizState.answered = false;
    const pool = [...allWords].sort(() => Math.random() - 0.5).slice(0, 4);
    const correctIdx = Math.floor(Math.random() * pool.length);
    picQuizState.correct = pool[correctIdx];
    picQuizState.options = pool;
    const wordEl = document.getElementById('picQuizWord');
    if (wordEl) { wordEl.innerText = picQuizState.correct[conf.l1]; speak(picQuizState.correct[conf.l3], conf.l3, 0.8); }
    const feedbackEl = document.getElementById('picQuizFeedback');
    if (feedbackEl) feedbackEl.innerHTML = '';
    const grid = document.getElementById('picQuizGrid');
    if (!grid) return;
    grid.innerHTML = pool.map((w, i) => {
        const keyword = encodeURIComponent(w[conf.l2] || w[conf.l1]);
        const seed = Math.floor(Math.random() * 9000) + 1000;
        return `<div onclick="checkPictureQuiz(${i})" id="picCard_${i}" style="cursor:pointer;border-radius:16px;overflow:hidden;border:3px solid var(--border-soft);background:rgba(255,255,255,0.8);transition:border-color 0.2s;">
            <img src="https://loremflickr.com/320/200/${keyword}?lock=${seed}" style="width:100%;height:110px;object-fit:cover;display:block;" onerror="this.style.background='#E5E7EB';this.style.height='110px';">
            <div style="padding:6px 8px;text-align:center;font-weight:800;font-size:0.9rem;color:var(--primary);">${escapeHTML(w[conf.l3])}</div>
        </div>`;
    }).join('');
}

function checkPictureQuiz(idx) {
    if (picQuizState.answered) return;
    picQuizState.answered = true;
    const chosen = picQuizState.options[idx];
    const isCorrect = chosen === picQuizState.correct;
    picQuizState.options.forEach((w, i) => {
        const card = document.getElementById(`picCard_${i}`);
        if (!card) return;
        card.onclick = null;
        if (w === picQuizState.correct) card.style.borderColor = '#10B981';
        else if (i === idx) card.style.borderColor = '#EF4444';
    });
    const feedbackEl = document.getElementById('picQuizFeedback');
    if (isCorrect) {
        addXP(10);
        if (feedbackEl) feedbackEl.innerHTML = '<span style="color:#10B981;font-weight:900;font-size:1.1rem;">✅ Richtig! +10 XP</span>';
    } else {
        if (feedbackEl) feedbackEl.innerHTML = `<span style="color:#EF4444;font-weight:900;font-size:1.1rem;">❌ Falsch — Richtig wäre: <em>${escapeHTML(picQuizState.correct[conf.l3])}</em></span>`;
    }
    setTimeout(() => initPictureQuiz(), 2200);
}

function recordRpSpeech(targetSentence, btnId) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SpeechRecognition) return showToast("⚠️ Dein Browser unterstützt das Mikrofon leider nicht.", "error");
    try { const rec = new SpeechRecognition(); rec.lang = (ALL_LANGS[conf.l3] && ALL_LANGS[conf.l3].tts) ? ALL_LANGS[conf.l3].tts : 'sv-SE'; rec.continuous = true; rec.interimResults = true; const btn = document.getElementById(btnId); if(btn) btn.classList.add('mic-active'); activeRpSentenceForFeedback = targetSentence; rpCurrentTranscript = ""; document.getElementById('rpUserSaid').innerText = "..."; const waitTimeMs = parseInt(document.getElementById('selRpMicPatience').value) * 1000; const resetTimer = () => { clearTimeout(rpMicTimer); rpMicTimer = setTimeout(() => { rec.stop(); }, waitTimeMs); }; rec.onstart = () => { resetTimer(); }; rec.onresult = (e) => { let text = ""; for(let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript; rpCurrentTranscript = text; document.getElementById('rpUserSaid').innerText = rpCurrentTranscript; resetTimer(); }; rec.onerror = (e) => { clearTimeout(rpMicTimer); if(btn) btn.classList.remove('mic-active'); if (e.error === 'not-allowed') showToast("⚠️ Mikrofon-Zugriff blockiert.", "error"); logCustomError("Szenarien Mikrofon", e.error); }; rec.onend = async () => { clearTimeout(rpMicTimer); if(btn) btn.classList.remove('mic-active'); if (rpCurrentTranscript.trim().length > 0) { const textToEval = rpCurrentTranscript; rpCurrentTranscript = ""; fastEvaluateSpeech(textToEval, activeRpSentenceForFeedback, 'rpFeedbackBox', 'rpFeedbackText'); } else { document.getElementById('rpUserSaid').innerText = "Nichts gehört."; } }; rec.start(); } catch(err) { const btn = document.getElementById(btnId); if(btn) btn.classList.remove('mic-active'); logCustomError("Start recordRpSpeech", err); }
}
function fastEvaluateSpeech(spokenText, targetText, boxId, textId) {
    document.getElementById(boxId).style.display = 'none'; const cleanSpoken = spokenText.toLowerCase().replace(/[.,!?;:]/g, '').trim(); const cleanTarget = targetText.toLowerCase().replace(/[.,!?;:]/g, '').trim(); let feedback = "";
    if(cleanSpoken === cleanTarget || cleanTarget.includes(cleanSpoken) || cleanSpoken.includes(cleanTarget)) { feedback = "Perfekt! Sehr gut ausgesprochen. 🌟"; addXP(5); playSound('success'); } else { const targetWords = cleanTarget.split(' '); const spokenWords = cleanSpoken.split(' '); let matches = 0; targetWords.forEach(w => { if(spokenWords.includes(w)) matches++; }); const matchPercentage = matches / targetWords.length; if(matchPercentage > 0.6) { feedback = "Gute Arbeit! Die meisten Wörter waren richtig."; addXP(3); playSound('success'); } else if (matchPercentage > 0.3) { feedback = "Ich habe einige Wörter erkannt, aber der Satz war noch nicht ganz richtig."; playSound('error'); } else { feedback = "Das habe ich leider nicht verstanden. Bitte sprich etwas lauter."; playSound('error'); } }
    document.getElementById(textId).innerText = feedback; document.getElementById(boxId).style.display = 'block'; setTimeout(() => { document.getElementById(boxId).scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
}
function speakLiveResult() { const text = document.getElementById('liveResultText').value; const lang = document.getElementById('liveTgtLang').value; if(text) speak(text, lang); }
function saveLiveTranslation() {
    const srcLang = document.getElementById('liveSrcLang').value; const tgtLang = document.getElementById('liveTgtLang').value; const srcText = document.getElementById('liveSourceText').value.trim(); const tgtText = document.getElementById('liveResultText').value.trim();
    if(!srcText || !tgtText) return showToast("Bitte erst etwas übersetzen!", "error"); if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    let d = { [conf.l1]: "", [conf.l2]: "", [conf.l3]: "" }; if(srcLang === conf.l1) d[conf.l1] = srcText; else if(srcLang === conf.l2) d[conf.l2] = srcText; else if(srcLang === conf.l3) d[conf.l3] = srcText; if(tgtLang === conf.l1) d[conf.l1] = tgtText; else if(tgtLang === conf.l2) d[conf.l2] = tgtText; else if(tgtLang === conf.l3) d[conf.l3] = tgtText; if(!d[conf.l1]) d[conf.l1] = srcText; if(!d[conf.l3]) d[conf.l3] = tgtText;
    d.ts = firebase.firestore.FieldValue.serverTimestamp(); d.level = 0; d.nextReview = getNextReviewTimestamp(0);
    db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).add(d).then(() => { playSound('success'); showToast("✅ Vokabel gespeichert!", "success"); refreshData(); statsToday.added++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); if(statsToday.added === 2) { addXP(15); fireConfetti(); } }).catch(e => logCustomError("Speichern Live-Translation", e));
}
async function initFlashcards(useFilter = false) {
    if (!dataReady) {
        document.getElementById('fcCardArea').style.display = 'none';
        document.getElementById('fcDoneMessage').style.display = 'block';
        document.getElementById('fcDoneMessage').innerHTML = "<p style='text-align:center;font-size:1.5rem;'>⏳</p><p style='text-align:center;'>Wörter werden geladen…</p>";
        return;
    }
    if(allWords.length === 0) { document.getElementById('fcCardArea').style.display = 'none'; document.getElementById('fcDoneMessage').style.display = 'block'; document.getElementById('fcDoneMessage').innerHTML = "<p>Füge erst Wörter hinzu!</p>"; return; }
    let filteredWords = [...allWords]; const topicInput = document.getElementById('fcTopicInput'); const topic = useFilter && topicInput ? topicInput.value.trim() : "";
    if (topic) {
        document.getElementById('fcCardArea').style.display = 'none'; document.getElementById('fcDoneMessage').style.display = 'none'; document.getElementById('fcLoader').style.display = 'block'; const wordListL1 = allWords.map(w => w[conf.l1]).join(', ');
        const prompt = `Du bist ein intelligenter Filter. Hier ist eine Liste von Wörtern: [${wordListL1}]. Finde ALLE Wörter in dieser Liste, die thematisch in die Kategorie "${topic}" passen. Antworte AUSSCHLIESSLICH mit einem validen JSON-Array. Beispiel: ["Wort1"]`;
        const res = await callGemini(prompt); document.getElementById('fcLoader').style.display = 'none';
        if (res) { try { let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const sIdx = cleanStr.indexOf('['); const eIdx = cleanStr.lastIndexOf(']'); if (sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1); const matchedWords = JSON.parse(cleanStr); filteredWords = allWords.filter(w => matchedWords.includes(w[conf.l1])); if (filteredWords.length === 0) { showToast("Keine passenden Wörter zum Thema gefunden.", "info"); filteredWords = [...allWords]; topicInput.value = ""; } } catch(e) { showToast("⚠️ Fehler beim KI-Filtern.", "error"); filteredWords = [...allWords]; } } else { filteredWords = [...allWords]; }
    }
    // Prioritize low-level (weak) words by weighted shuffle
    filteredWords.sort((a, b) => {
        const wa = (6 - (a.level || 0)) + Math.random() * 2;
        const wb = (6 - (b.level || 0)) + Math.random() * 2;
        return wb - wa;
    });
    fcPool = filteredWords; fcIndex = 0; fcSessionHistory = { spaeter: [], nochmals: [], geuebt: [] }; updateFcHistoryCounts(); document.getElementById('fcHistoryList').style.display = 'none'; renderFc();
}
function renderFc() {
    document.getElementById('fcFeedbackBox').style.display = 'none';
    if(fcIndex >= fcPool.length) { fireConfetti(); document.getElementById('fcCardArea').style.display = 'none'; document.getElementById('fcDoneMessage').style.display = 'block'; document.getElementById('fcCount').innerText = "Fertig"; return; }
    document.getElementById('fcCardArea').style.display = 'block'; document.getElementById('fcDoneMessage').style.display = 'none';
    const w = fcPool[fcIndex]; document.getElementById('fcCard').classList.remove('flipped'); 
    const engWord = w[conf.l2] || w[conf.l1] || "object"; const imgUrl = `https://image.pollinations.ai/prompt/Realistic%20photography%20of%20${encodeURIComponent(engWord)}?width=600&height=300&nologo=true`;
    document.getElementById('fcImgFront').style.backgroundImage = `url('${imgUrl}')`; document.getElementById('fcImgBack').style.backgroundImage = `linear-gradient(to bottom, rgba(79, 70, 229, 0.7), rgba(79, 70, 229, 0.9)), url('${imgUrl}')`;
    setTimeout(() => { document.getElementById('fcFrontText').innerText = w[conf.l1] || "???"; document.getElementById('fcBackText').innerText = w[conf.l3] || "???"; document.getElementById('fcCount').innerText = `${fcIndex + 1} / ${fcPool.length}`; }, 150);
}
function flipFc() { document.getElementById('fcCard').classList.toggle('flipped'); }
function speakFc(e) { e.stopPropagation(); speak(fcPool[fcIndex][conf.l3], conf.l3); }
function recordFcSpeech(e) {
    e.stopPropagation(); const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SpeechRecognition) return showToast("⚠️ Dein Browser unterstützt das Mikrofon leider nicht.", "error");
    try { const rec = new SpeechRecognition(); rec.lang = (ALL_LANGS[conf.l3] && ALL_LANGS[conf.l3].tts) ? ALL_LANGS[conf.l3].tts : 'sv-SE'; const btn = document.getElementById('fcMicBtn'); btn.classList.add('mic-active'); const targetWord = fcPool[fcIndex][conf.l3]; document.getElementById('fcFeedbackBox').style.display = 'none'; rec.onresult = (e) => { const spokenText = e.results[0][0].transcript; btn.classList.remove('mic-active'); document.getElementById('fcUserSaid').innerText = spokenText; fastEvaluateSpeech(spokenText, targetWord, 'fcFeedbackBox', 'fcFeedbackText'); }; rec.onerror = (e) => { btn.classList.remove('mic-active'); if (e.error === 'not-allowed') showToast("⚠️ Mikrofon-Zugriff blockiert.", "error"); }; rec.onend = () => btn.classList.remove('mic-active'); rec.start(); } catch(err) { document.getElementById('fcMicBtn').classList.remove('mic-active'); }
}
function handleFc(action) {
    if(!currentUser || !db) return; const w = fcPool[fcIndex]; let lvl = w.level || 0; let oldLvl = lvl; let oldNextReview = w.nextReview;
    if(action === 'geuebt') { lvl = Math.min(5, lvl + 1); playSound('success'); addXP(2); w.level = lvl; w.nextReview = getNextReviewTimestamp(lvl); db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(w.id).update({level: lvl, nextReview: w.nextReview}); fcSessionHistory.geuebt.unshift({ word: w, oldLvl: oldLvl, oldNextReview: oldNextReview }); fcIndex++; renderFc(); } 
    else if (action === 'nochmals') { lvl = Math.max(0, lvl - 1); playSound('error'); w.level = lvl; w.nextReview = getNextReviewTimestamp(lvl); db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(w.id).update({level: lvl, nextReview: w.nextReview}); fcSessionHistory.nochmals.unshift({ word: w, oldLvl: oldLvl, oldNextReview: oldNextReview }); fcIndex++; renderFc(); } 
    else if (action === 'spaeter') { fcSessionHistory.spaeter.unshift({ word: w }); fcPool.push(fcPool.splice(fcIndex, 1)[0]); renderFc(); }
    updateFcHistoryCounts(); if(document.getElementById('fcHistoryList').style.display === 'flex') showFcList(currentFcListType);
}
function updateFcHistoryCounts() { document.getElementById('cntSpaeter').innerText = fcSessionHistory.spaeter.length; document.getElementById('cntNochmals').innerText = fcSessionHistory.nochmals.length; document.getElementById('cntGeuebt').innerText = fcSessionHistory.geuebt.length; }
function showFcList(type) { const listEl = document.getElementById('fcHistoryList'); if(currentFcListType === type && listEl.style.display === 'flex') { listEl.style.display = 'none'; return; } currentFcListType = type; listEl.style.display = 'flex'; if(fcSessionHistory[type].length === 0) { listEl.innerHTML = `<div style="text-align:center; color:var(--text-light); font-size:0.9rem;">Noch keine Karten hier abgelegt.</div>`; return; } const icons = { spaeter: '🔴', nochmals: '🟠', geuebt: '🟢' }; listEl.innerHTML = fcSessionHistory[type].map((item, idx) => `<div style="display:flex; justify-content:space-between; align-items:center; background:white; padding:10px; border-radius:12px; border:1px solid var(--border-soft);"><div style="font-weight:bold; color:var(--text); font-size:0.95rem;">${icons[type]} ${escapeHTML(item.word[conf.l1])} <span style="color:var(--text-light); font-weight:normal; font-size:0.8rem;">(${escapeHTML(item.word[conf.l3])})</span></div><button class="icon-btn" style="padding:6px 12px; font-size:0.85rem; border-color:var(--primary); color:var(--primary);" onclick="undoFc('${type}', ${idx})">↩️ Holen</button></div>`).join(''); }
function undoFc(type, historyIndex) { if(!currentUser || !db) return; const item = fcSessionHistory[type][historyIndex]; const w = item.word; if (type === 'geuebt' || type === 'nochmals') { w.level = item.oldLvl; w.nextReview = item.oldNextReview; db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(w.id).update({level: item.oldLvl, nextReview: item.oldNextReview}); } else if (type === 'spaeter') { const poolIdx = fcPool.findIndex(x => x.id === w.id); if(poolIdx > -1) fcPool.splice(poolIdx, 1); } fcSessionHistory[type].splice(historyIndex, 1); fcPool.splice(fcIndex, 0, w); updateFcHistoryCounts(); showFcList(type); renderFc(); }
function openMiniGame(game) {
    document.getElementById('arcadeMenu').style.display = game === 'Menu' ? 'grid' : 'none';
    ['gameRallye', 'gameHunt', 'gameDuel', 'gameAdventure', 'gamePicture'].forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
    if(game !== 'Menu') {
        document.getElementById('game' + game).style.display = 'block';
        if(game === 'Hunt') initHunt();
        if(game === 'Rallye') {
            currentRallyeCategory = RALLYE_CATEGORIES[Math.floor(Math.random() * RALLYE_CATEGORIES.length)];
            const catEl = document.getElementById('rallyeCategory'); if(catEl) catEl.innerText = currentRallyeCategory.label;
        }
        if(game === 'Duel') {
            const duelArea = document.getElementById('duelArea'); if(duelArea) duelArea.style.display = 'none';
            const btnStart = document.getElementById('btnStartDuel'); if(btnStart) btnStart.style.display = 'block';
            const res = document.getElementById('duelResult'); if(res) res.innerText = '';
        }
        if(game === 'Adventure') {
            const btnAdv = document.getElementById('btnStartAdv'); if(btnAdv) btnAdv.style.display = 'block';
            const advArea = document.getElementById('advArea'); if(advArea) advArea.style.display = 'none';
        }
        if(game === 'Picture') initPictureQuiz();
    }
}
function playRallyeRound() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SpeechRecognition) return showToast("Dein Browser unterstützt das Mikrofon leider nicht.", "error");
    const rec = new SpeechRecognition(); rec.lang = ALL_LANGS[conf.l3].tts;
    document.getElementById('btnRallyeMic').classList.add('mic-active');
    rec.onresult = async (e) => {
        const word = e.results[0][0].transcript;
        document.getElementById('rallyeLoader').style.display = 'block';
        const cat = currentRallyeCategory.prompt;
        const res = await callGemini(`Ist das Wort "${word}" in der Sprache ${ALL_LANGS[conf.l3].name} ${cat}? Antworte NUR mit JA oder NEIN.`);
        document.getElementById('rallyeLoader').style.display = 'none';
        if(res && res.toUpperCase().includes("JA")) {
            playSound('success'); addXP(15); showToast(`✅ Richtig! "${word}" ist ${cat}. +15 XP`, "success");
            currentRallyeCategory = RALLYE_CATEGORIES[Math.floor(Math.random() * RALLYE_CATEGORIES.length)];
            const catEl = document.getElementById('rallyeCategory'); if(catEl) catEl.innerText = currentRallyeCategory.label;
        } else { playSound('error'); showToast(`❌ KI hat "${word}" nicht als ${cat} erkannt.`, "error"); }
    };
    rec.onend = () => document.getElementById('btnRallyeMic').classList.remove('mic-active');
    rec.onerror = (e) => { document.getElementById('btnRallyeMic').classList.remove('mic-active'); logCustomError("Rallye Mikrofon", e.error); };
    rec.start();
}
function initHunt() { huntTarget = allWords.length ? allWords[Math.floor(Math.random()*allWords.length)][conf.l3] : "Apfel"; document.getElementById('huntTargetWord').innerText = huntTarget; document.getElementById('huntResult').innerText = ""; }
function checkHuntImage(input) { const file = input.files[0]; if(!file) return; document.getElementById('huntLoader').style.display = 'block'; const reader = new FileReader(); reader.onload = (e) => { const img = new Image(); img.onload = async () => { let finalImageBase64 = e.target.result; try { const canvas = document.createElement('canvas'); let w = img.width, h = img.height; const max = 800; if(w > h && w > max) { h = Math.round(h * max / w); w = max; } else if(h > max) { w = Math.round(w * max / h); h = max; } canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h); finalImageBase64 = canvas.toDataURL('image/jpeg', 0.7); } catch(canvasErr) {} const c = await callGemini(`Look at this image. Is this an image of a "${huntTarget}"? Answer STRICTLY with the word YES or NO and nothing else.`, finalImageBase64); document.getElementById('huntLoader').style.display = 'none'; if(c && c.toUpperCase().includes("YES")) { document.getElementById('huntResult').innerText = "✅ Richtig!"; playSound('success'); addXP(20); } else if (c) { document.getElementById('huntResult').innerText = "❌ Falsch. KI sagte: " + c; playSound('error'); } input.value = ""; }; img.src = e.target.result; }; reader.readAsDataURL(file); }
function startDuelRound() {
    if(!allWords.length) return showToast("Bitte erst Wörter hinzufügen!", "error");
    const duelArea = document.getElementById('duelArea'); if(duelArea) duelArea.style.display = 'flex';
    const btnStart = document.getElementById('btnStartDuel'); if(btnStart) btnStart.style.display = 'none';
    const res = document.getElementById('duelResult'); if(res) res.innerText = '';
    document.getElementById('duelWord').innerText = "Warten..."; duelCanTap = false;
    setTimeout(() => { duelWordObj = allWords[Math.floor(Math.random()*allWords.length)]; document.getElementById('duelWord').innerText = duelWordObj[conf.l1]; duelCanTap = true; }, 1500);
}
function duelTap(p) {
    if(!duelCanTap) return;
    duelCanTap = false;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SpeechRecognition) return showToast("⚠️ Mikrofon nicht unterstützt.", "error");
    const rec = new SpeechRecognition(); rec.lang = ALL_LANGS[conf.l3].tts;
    rec.onresult = (e) => {
        const s = e.results[0][0].transcript.toLowerCase();
        const target = (duelWordObj[conf.l3] || "").toLowerCase();
        const resultEl = document.getElementById('duelResult');
        if(s.includes(target) || target.includes(s)) {
            resultEl.innerText = `🎉 Punkt für ${p}! "${duelWordObj[conf.l3]}" war richtig.`; playSound('success'); addXP(10);
        } else {
            resultEl.innerText = `❌ Falsch. Richtig wäre: "${duelWordObj[conf.l3]}"`;  playSound('error');
        }
        setTimeout(() => { const btn = document.getElementById('btnStartDuel'); if(btn) { btn.style.display = 'block'; } const duelArea = document.getElementById('duelArea'); if(duelArea) duelArea.style.display = 'none'; }, 2000);
    };
    rec.onerror = (e) => { duelCanTap = true; logCustomError("Duel Mikrofon", e.error); };
    rec.start();
}
function startAdventure() { document.getElementById('btnStartAdv').style.display = 'none'; document.getElementById('advArea').style.display = 'block'; document.getElementById('advHistory').innerHTML = `<div class="chat-bubble bubble-ai">Du stehst in einem dunklen Wald. Vor dir ist eine geheimnisvolle Höhle. Was tust du? (Antworte auf ${ALL_LANGS[conf.l3].name})</div>`; }
function advTurn() { const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if(!SpeechRecognition) return; const rec = new SpeechRecognition(); rec.lang = ALL_LANGS[conf.l3].tts; document.getElementById('btnAdvMic').classList.add('mic-active'); rec.onresult = async (e) => { const txt = e.results[0][0].transcript; document.getElementById('advHistory').innerHTML += `<div class="chat-bubble bubble-user">${txt}</div>`; document.getElementById('advLoader').style.display = 'block'; const res = await callGemini(`Wir spielen ein Text-Adventure. Die Sprache ist ${ALL_LANGS[conf.l3].name}. Ich habe gesagt: "${txt}". Antworte kurz in max 2 Sätzen was passiert und frage, was ich als nächstes tue.`); document.getElementById('advLoader').style.display = 'none'; if(res) { document.getElementById('advHistory').innerHTML += `<div class="chat-bubble bubble-ai">${res}</div>`; speak(res, conf.l3); document.getElementById('advHistory').scrollTop = document.getElementById('advHistory').scrollHeight; addXP(5); } }; rec.onend = () => document.getElementById('btnAdvMic').classList.remove('mic-active'); rec.onerror = (e) => logCustomError("Adventure Mikrofon", e.error); rec.start(); }
function startTutorMic() { const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SpeechRecognition) return showToast("⚠️ Browser unterstützt keine Spracherkennung.", "error"); chatRec = new SpeechRecognition(); chatRec.lang = ALL_LANGS[document.getElementById('chatSrcLang').value].tts; chatRec.continuous = false; chatRec.onresult = async (e) => { const t = e.results[0][0].transcript; document.getElementById('chatHistory').innerHTML += `<div class="chat-bubble bubble-user">${t}</div>`; document.getElementById('loaderChat').style.display='block'; const tgtLang = document.getElementById('chatTgtLang').value; const prompt = `Du bist Sprachtutor für ${ALL_LANGS[tgtLang].name}. Antworte extrem kurz und natürlich. Max 2 Sätze auf ${ALL_LANGS[tgtLang].name}. Max 1 Satz kurzes Feedback auf Deutsch. Format: Antwort ||| Feedback`; const r = await callGemini(t, null, prompt); document.getElementById('loaderChat').style.display='none'; if(r) { const p = r.split('|||'); document.getElementById('chatHistory').innerHTML += `<div class="chat-bubble bubble-ai">${escapeHTML(p[0])}</div><div class="bubble-feedback">${escapeHTML(p[1]||'')}</div>`; document.getElementById('chatHistory').scrollTop = document.getElementById('chatHistory').scrollHeight; speak(p[0], tgtLang); } }; chatRec.onerror = (e) => logCustomError("Chat Tutor Mikrofon", e.error); chatRec.onend = () => { if(isChatSessionActive) { setTimeout(() => { try { chatRec.start(); } catch(err){} }, 500); } }; chatRec.start(); }
function toggleChatRecord() { if(isChatSessionActive) { isChatSessionActive = false; if(chatRec) { try { chatRec.abort(); } catch(e){} } document.getElementById('btnChatRecord').innerText = "🎤 Chat Starten"; document.getElementById('btnChatRecord').style.background = "var(--primary-gradient)"; } else { isChatSessionActive = true; document.getElementById('btnChatRecord').innerText = "⏹️ Chat beenden"; document.getElementById('btnChatRecord').style.background = "#EF4444"; startTutorMic(); } }
function clearChat() { document.getElementById('chatHistory').innerHTML = `<div class="chat-bubble bubble-ai" id="chatWelcomeMsg">Hej! Lass uns üben. 👋</div>`; }
async function generateStory() { if(allWords.length < 3) return showToast("Min. 3 Wörter im Wörterbuch nötig!", "error"); const words = allWords.sort(()=>0.5-Math.random()).slice(0,4).map(w=>w[conf.l3]).join(", "); document.getElementById('loaderStory').style.display='block'; const r = await callGemini(`Schreibe ein kurzes, absurdes Märchen (max 3 Sätze) auf ${ALL_LANGS[conf.l3].name}. Nutze diese Wörter: ${words}. Das Format MUSS sein: Geschichte --- Übersetzung auf Deutsch.`); document.getElementById('loaderStory').style.display='none'; if(r) { const p = r.split('---'); document.getElementById('storyContent').innerText = p[0]; document.getElementById('storyTranslation').innerText = p[1] || ""; document.getElementById('storyBox').style.display='block'; speak(p[0], conf.l3); } }
function speakStory() { const t = document.getElementById('storyContent').innerText; if(t) speak(t, conf.l3); }
async function toggleLiveRecord() { const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if(!SpeechRecognition) return; if(isLiveRecording) { isLiveRecording = false; document.getElementById('btnLiveRecord').innerText = "🎤 Start"; document.getElementById('btnLiveRecord').style.background = "var(--primary-gradient)"; if(liveRecObj) liveRecObj.stop(); return; } isLiveRecording = true; document.getElementById('btnLiveRecord').innerText = "⏹️ Stopp"; document.getElementById('btnLiveRecord').style.background = "#EF4444"; liveRecObj = new SpeechRecognition(); liveRecObj.lang = ALL_LANGS[document.getElementById('liveSrcLang').value].tts; liveRecObj.continuous = true; liveRecObj.interimResults = true; liveRecObj.onresult = async (e) => { let text = ""; for(let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript; document.getElementById('liveSourceText').value = text; if(e.results[e.results.length - 1].isFinal) { document.getElementById('loaderLive').style.display = 'block'; const srcLang = document.getElementById('liveSrcLang').value; const tgtLang = document.getElementById('liveTgtLang').value; let res = null; if (deeplApiKey.trim()) res = await translateWithDeepL(text, srcLang, tgtLang); if (!res) res = await callGemini(`Übersetze den Text streng in die Sprache ${ALL_LANGS[tgtLang].name}. Gib NUR die Übersetzung zurück: "${text}"`); document.getElementById('loaderLive').style.display = 'none'; if(res) document.getElementById('liveResultText').value = res; } }; liveRecObj.onerror = (e) => logCustomError("Live Übersetzung Mikrofon", e.error); liveRecObj.onend = () => { if(isLiveRecording) liveRecObj.start(); }; liveRecObj.start(); }
function handleImageScan(input) { const file = input.files[0]; if(!file) return; document.getElementById('loader').style.display = 'block'; const reader = new FileReader(); reader.onload = (e) => { const img = new Image(); img.onload = async () => { let finalImageBase64 = e.target.result; try { const canvas = document.createElement('canvas'); let w = img.width, h = img.height; const max = 800; if(w > h && w > max) { h = Math.round(h * max / w); w = max; } else if(h > max) { w = Math.round(w * max / h); h = max; } canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h); finalImageBase64 = canvas.toDataURL('image/jpeg', 0.7); } catch(err) {} // Step 1: Gemini identifies the object (always — it needs vision)
const prompt = `Look at this image. Identify the single main everyday object in it. Give its name in ${ALL_LANGS[conf.l1].name}. Respond with ONLY the word, nothing else.`;
const identified = await callGemini(prompt, finalImageBase64);
document.getElementById('loader').style.display = 'none';
if (identified) {
    const word = identified.trim();
    let obj = null;
    // Step 2: translate into all languages — DeepL first, Gemini fallback
    if (deeplApiKey.trim()) { setEngineBadge('loading_deepl'); obj = await translateAllWithDeepL(word, conf.l1); if (obj) setEngineBadge('done_deepl'); }
    if (!obj) {
        setEngineBadge('loading_gemini');
        try {
            const res2 = await callGemini(`Translate the word "${word}". Respond ONLY with a valid JSON object: {"${conf.l1}":"...", "${conf.l2}":"...", "${conf.l3}":"..."}`);
            if (res2) { let c = res2.replace(/`{3}json/gi,'').replace(/`{3}/g,'').trim(); const s=c.indexOf('{'),e2=c.lastIndexOf('}'); if(s!==-1&&e2!==-1)c=c.substring(s,e2+1); obj=JSON.parse(c); if (obj) setEngineBadge('done_gemini'); }
        } catch(err) { showToast("⚠️ Übersetzung fehlgeschlagen.", "error"); setEngineBadge('hidden'); }
    }
    if (obj) { document.getElementById('inDe').value = obj[conf.l1]||word; document.getElementById('inEn').value = obj[conf.l2]||""; document.getElementById('inSv').value = obj[conf.l3]||""; }
}
input.value = ""; }; img.src = e.target.result; }; reader.readAsDataURL(file); }
function setEngineBadge(state) {
    const b = document.getElementById('translateEngineBadge');
    if (!b) return;
    const styles = {
        loading_deepl:  { text: '🔵 DeepL…',  bg: '#1e3a5f', color: '#60a5fa', show: true },
        loading_gemini: { text: '🤖 Gemini…', bg: '#2d1b69', color: '#a78bfa', show: true },
        done_deepl:     { text: '🔵 DeepL',   bg: '#1e3a5f', color: '#60a5fa', show: true },
        done_gemini:    { text: '🤖 Gemini',  bg: '#2d1b69', color: '#a78bfa', show: true },
        hidden:         { show: false }
    };
    const s = styles[state] || styles.hidden;
    b.style.display = s.show ? 'inline-block' : 'none';
    if (s.show) { b.textContent = s.text; b.style.background = s.bg; b.style.color = s.color; }
}

async function handleSmartTranslate() {
    const txt = document.getElementById('inDe').value || document.getElementById('inEn').value || document.getElementById('inSv').value;
    if (!txt) return;
    const srcKey = document.getElementById('inDe').value ? conf.l1 : (document.getElementById('inEn').value ? conf.l2 : conf.l3);
    document.getElementById('loader').style.display = "block";
    let obj = null;
    // DeepL first
    if (deeplApiKey.trim()) {
        setEngineBadge('loading_deepl');
        obj = await translateAllWithDeepL(txt, srcKey);
        if (obj) setEngineBadge('done_deepl');
    }
    // Gemini fallback
    if (!obj) {
        setEngineBadge('loading_gemini');
        try {
            const res = await callGemini(`Übersetze das Wort "${txt}". Antworte NUR mit einem validen JSON Objekt: {"${conf.l1}":"...", "${conf.l2}":"...", "${conf.l3}":"..."}`);
            if (res) {
                let clean = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim();
                const s = clean.indexOf('{'), e2 = clean.lastIndexOf('}');
                if (s !== -1 && e2 !== -1) clean = clean.substring(s, e2 + 1);
                obj = JSON.parse(clean);
                if (obj) setEngineBadge('done_gemini');
            }
        } catch(e) { showToast("Übersetzung fehlgeschlagen.", "error"); setEngineBadge('hidden'); }
    }
    if (obj) {
        document.getElementById('inDe').value = obj[conf.l1] || "";
        document.getElementById('inEn').value = obj[conf.l2] || "";
        document.getElementById('inSv').value = obj[conf.l3] || "";
    } else {
        setEngineBadge('hidden');
    }
    document.getElementById('loader').style.display = "none";
}
function toggleVerbSection() { const vs = document.getElementById('verbSection'); vs.style.display = vs.style.display === 'block' ? 'none' : 'block'; }
async function fetchVerbForms() { const b = document.getElementById('inDe').value || document.getElementById('inEn').value; if(!b) return; document.getElementById('loader').style.display = "block"; const prompt = `Verb "${b}". JSON: {"l1P":"...", "l1F":"...", "l2P":"...", "l2F":"...", "l3P":"...", "l3F":"..."} for ${conf.l1}, ${conf.l2}, ${conf.l3}`; const res = await callGemini(prompt); document.getElementById('loader').style.display = "none"; if(res) { try { const cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const o = JSON.parse(cleanStr); document.getElementById('inDePast').value = o.l1P||""; document.getElementById('inDeFut').value = o.l1F||""; document.getElementById('inEnPast').value = o.l2P||""; document.getElementById('inEnFut').value = o.l2F||""; document.getElementById('inSvPast').value = o.l3P||""; document.getElementById('inSvFut').value = o.l3F||""} catch(e) {} } }
function listen(slot, targetId, btn) { const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SpeechRecognition) return showToast("⚠️ Browser unterstützt die integrierte Spracherkennung nicht.", "error"); try { const rec = new SpeechRecognition(); const langKey = slot === 1 ? conf.l1 : (slot === 2 ? conf.l2 : conf.l3); rec.lang = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) ? ALL_LANGS[langKey].tts : 'de-DE'; btn.classList.add('mic-active'); rec.onresult = (e) => { document.getElementById(targetId).value = e.results[0][0].transcript; }; rec.onerror = (e) => { btn.classList.remove('mic-active'); if (e.error === 'not-allowed') showToast("⚠️ Mikrofon-Zugriff verweigert.", "error"); }; rec.onend = () => btn.classList.remove('mic-active'); rec.start(); } catch(err) { btn.classList.remove('mic-active'); } }
function editWord(id) { const w = allWords.find(item => item.id === id); if(!w) return; document.getElementById('editId').value = id; document.getElementById('inDe').value = w[conf.l1] || ""; document.getElementById('inEn').value = w[conf.l2] || ""; document.getElementById('inSv').value = w[conf.l3] || ""; document.getElementById('addTitle').innerText = "✎ Bearbeiten"; document.getElementById('cancelBtn').style.display = "block"; showTab('add'); }
function resetAddForm() { document.getElementById('editId').value = ""; ['inDe','inEn','inSv'].forEach(id => document.getElementById(id).value = ""); document.getElementById('addTitle').innerText = "➕ Neues Wort"; document.getElementById('cancelBtn').style.display = "none"; }
function debouncedFilterListWords() { clearTimeout(listDebounceTimer); listDebounceTimer = setTimeout(renderList, 300); }
function renderList() { const q = document.getElementById('listSearch') ? document.getElementById('listSearch').value.toLowerCase().trim() : ""; const filtered = q ? allWords.filter(w => (w[conf.l1] && w[conf.l1].toLowerCase().includes(q)) || (w[conf.l3] && w[conf.l3].toLowerCase().includes(q))) : allWords; document.getElementById('listCont').innerHTML = filtered.map(w => `<div class="card" style="padding:15px; margin-bottom:10px; cursor:pointer;" onclick="openWordDetail('${w.id}')"><div class="word-item-actions"><button class="icon-btn" onclick="event.stopPropagation();editWord('${w.id}')" style="padding:8px; font-size:1rem;">✎</button><button class="icon-btn danger" onclick="event.stopPropagation();delWord('${w.id}')" style="padding:8px; font-size:1rem;">X</button></div><div style="font-weight:800; color:var(--primary); font-size:1.1rem; padding-right:80px;"><span class="level-dot lvl-${w.level||0}"></span>${escapeHTML(w[conf.l1])}</div><div style="color:var(--text-light); font-size:0.9rem; margin-top:5px; padding-left: 20px;">${escapeHTML(w[conf.l3])} | ${escapeHTML(w[conf.l2])}</div></div>`).join(''); }
async function delWord(id) { if(!db) return; if(confirm("Löschen?")) { await db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(id).delete(); refreshData(); } }
function getNextReviewTimestamp(level) { const daysToWait = [0, 1, 3, 7, 14, 30]; const nextDate = new Date(); nextDate.setDate(nextDate.getDate() + (daysToWait[level] || 0)); return nextDate.getTime(); }
function manualSave() { if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info"); const eid = document.getElementById('editId').value; const d = { [conf.l1]: document.getElementById('inDe').value, [conf.l2]: document.getElementById('inEn').value, [conf.l3]: document.getElementById('inSv').value }; if(!d[conf.l1]) return showToast("Bitte Feld 1 ausfüllen!", "error"); const ref = db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex); if(!eid) { d.ts = firebase.firestore.FieldValue.serverTimestamp(); d.level = 0; d.nextReview = getNextReviewTimestamp(0); } const promise = eid ? ref.doc(eid).update(d) : ref.add(d); promise.then(() => { if(!eid) { playSound('success'); addXP(10); statsToday.added++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); recordDailyActivity(); if(statsToday.added === 2) { addXP(15); fireConfetti(); } } resetAddForm(); refreshData(); if(!isFastInputMode) showTab('list'); else showToast("✅ Wort gespeichert!", "success"); }).catch(e => logCustomError("Wort speichern", e)); }
const DEFAULT_WORDS = [
  // Tiere
  {de:"Hund",en:"Dog",sv:"Hund"},{de:"Katze",en:"Cat",sv:"Katt"},{de:"Vogel",en:"Bird",sv:"Fågel"},
  {de:"Fisch",en:"Fish",sv:"Fisk"},{de:"Pferd",en:"Horse",sv:"Häst"},{de:"Kuh",en:"Cow",sv:"Ko"},
  {de:"Schwein",en:"Pig",sv:"Gris"},{de:"Schaf",en:"Sheep",sv:"Får"},{de:"Ziege",en:"Goat",sv:"Get"},
  {de:"Hase",en:"Hare",sv:"Hare"},{de:"Maus",en:"Mouse",sv:"Mus"},{de:"Bär",en:"Bear",sv:"Björn"},
  {de:"Wolf",en:"Wolf",sv:"Varg"},{de:"Fuchs",en:"Fox",sv:"Räv"},{de:"Elch",en:"Moose",sv:"Älg"},
  {de:"Hirsch",en:"Deer",sv:"Hjort"},{de:"Adler",en:"Eagle",sv:"Örn"},{de:"Ente",en:"Duck",sv:"Anka"},
  {de:"Eule",en:"Owl",sv:"Uggla"},{de:"Schlange",en:"Snake",sv:"Orm"},{de:"Frosch",en:"Frog",sv:"Groda"},
  {de:"Schildkröte",en:"Turtle",sv:"Sköldpadda"},{de:"Löwe",en:"Lion",sv:"Lejon"},{de:"Tiger",en:"Tiger",sv:"Tiger"},
  {de:"Elefant",en:"Elephant",sv:"Elefant"},{de:"Affe",en:"Monkey",sv:"Apa"},{de:"Krokodil",en:"Crocodile",sv:"Krokodil"},
  {de:"Delfin",en:"Dolphin",sv:"Delfin"},{de:"Hai",en:"Shark",sv:"Haj"},{de:"Spinne",en:"Spider",sv:"Spindel"},
  // Lebensmittel
  {de:"Brot",en:"Bread",sv:"Bröd"},{de:"Butter",en:"Butter",sv:"Smör"},{de:"Käse",en:"Cheese",sv:"Ost"},
  {de:"Ei",en:"Egg",sv:"Ägg"},{de:"Milch",en:"Milk",sv:"Mjölk"},{de:"Fleisch",en:"Meat",sv:"Kött"},
  {de:"Hühnchen",en:"Chicken",sv:"Kyckling"},{de:"Wurst",en:"Sausage",sv:"Korv"},{de:"Schinken",en:"Ham",sv:"Skinka"},
  {de:"Kartoffel",en:"Potato",sv:"Potatis"},{de:"Tomate",en:"Tomato",sv:"Tomat"},{de:"Gurke",en:"Cucumber",sv:"Gurka"},
  {de:"Karotte",en:"Carrot",sv:"Morot"},{de:"Zwiebel",en:"Onion",sv:"Lök"},{de:"Knoblauch",en:"Garlic",sv:"Vitlök"},
  {de:"Apfel",en:"Apple",sv:"Äpple"},{de:"Banane",en:"Banana",sv:"Banan"},{de:"Orange",en:"Orange",sv:"Apelsin"},
  {de:"Erdbeere",en:"Strawberry",sv:"Jordgubbe"},{de:"Reis",en:"Rice",sv:"Ris"},{de:"Nudeln",en:"Pasta",sv:"Pasta"},
  {de:"Suppe",en:"Soup",sv:"Soppa"},{de:"Salat",en:"Salad",sv:"Sallad"},{de:"Zucker",en:"Sugar",sv:"Socker"},
  {de:"Salz",en:"Salt",sv:"Salt"},{de:"Pfeffer",en:"Pepper",sv:"Peppar"},{de:"Mehl",en:"Flour",sv:"Mjöl"},
  {de:"Öl",en:"Oil",sv:"Olja"},{de:"Honig",en:"Honey",sv:"Honung"},{de:"Schokolade",en:"Chocolate",sv:"Choklad"},
  // Getränke
  {de:"Wasser",en:"Water",sv:"Vatten"},{de:"Kaffee",en:"Coffee",sv:"Kaffe"},{de:"Tee",en:"Tea",sv:"Te"},
  {de:"Saft",en:"Juice",sv:"Juice"},{de:"Bier",en:"Beer",sv:"Öl"},{de:"Wein",en:"Wine",sv:"Vin"},
  {de:"Limonade",en:"Lemonade",sv:"Läsk"},{de:"Cola",en:"Cola",sv:"Cola"},{de:"Mineralwasser",en:"Mineral water",sv:"Mineralvatten"},
  {de:"Smoothie",en:"Smoothie",sv:"Smoothie"},{de:"Kakao",en:"Hot chocolate",sv:"Varm choklad"},{de:"Tomatensaft",en:"Tomato juice",sv:"Tomatjuice"},
  {de:"Apfelsaft",en:"Apple juice",sv:"Äppeljuice"},{de:"Orangensaft",en:"Orange juice",sv:"Apelsinjuice"},{de:"Champagner",en:"Champagne",sv:"Champagne"},
  // Zahlen
  {de:"null",en:"zero",sv:"noll"},{de:"eins",en:"one",sv:"ett"},{de:"zwei",en:"two",sv:"två"},
  {de:"drei",en:"three",sv:"tre"},{de:"vier",en:"four",sv:"fyra"},{de:"fünf",en:"five",sv:"fem"},
  {de:"sechs",en:"six",sv:"sex"},{de:"sieben",en:"seven",sv:"sju"},{de:"acht",en:"eight",sv:"åtta"},
  {de:"neun",en:"nine",sv:"nio"},{de:"zehn",en:"ten",sv:"tio"},{de:"elf",en:"eleven",sv:"elva"},
  {de:"zwölf",en:"twelve",sv:"tolv"},{de:"dreizehn",en:"thirteen",sv:"tretton"},{de:"vierzehn",en:"fourteen",sv:"fjorton"},
  {de:"fünfzehn",en:"fifteen",sv:"femton"},{de:"sechzehn",en:"sixteen",sv:"sexton"},{de:"siebzehn",en:"seventeen",sv:"sjutton"},
  {de:"achtzehn",en:"eighteen",sv:"arton"},{de:"neunzehn",en:"nineteen",sv:"nitton"},{de:"zwanzig",en:"twenty",sv:"tjugo"},
  {de:"dreißig",en:"thirty",sv:"trettio"},{de:"vierzig",en:"forty",sv:"fyrtio"},{de:"fünfzig",en:"fifty",sv:"femtio"},
  {de:"sechzig",en:"sixty",sv:"sextio"},{de:"siebzig",en:"seventy",sv:"sjuttio"},{de:"achtzig",en:"eighty",sv:"åttio"},
  {de:"neunzig",en:"ninety",sv:"nittio"},{de:"hundert",en:"hundred",sv:"hundra"},{de:"tausend",en:"thousand",sv:"tusen"},
  // Farben
  {de:"rot",en:"red",sv:"röd"},{de:"blau",en:"blue",sv:"blå"},{de:"grün",en:"green",sv:"grön"},
  {de:"gelb",en:"yellow",sv:"gul"},{de:"lila",en:"purple",sv:"lila"},
  {de:"rosa",en:"pink",sv:"rosa"},{de:"weiß",en:"white",sv:"vit"},{de:"schwarz",en:"black",sv:"svart"},
  {de:"grau",en:"grey",sv:"grå"},{de:"braun",en:"brown",sv:"brun"},{de:"türkis",en:"turquoise",sv:"turkos"},
  {de:"silber",en:"silver",sv:"silver"},{de:"gold",en:"gold",sv:"guld"},{de:"beige",en:"beige",sv:"beige"},
  // Familie
  {de:"Mutter",en:"Mother",sv:"Mamma"},{de:"Vater",en:"Father",sv:"Pappa"},{de:"Bruder",en:"Brother",sv:"Bror"},
  {de:"Schwester",en:"Sister",sv:"Syster"},{de:"Oma",en:"Grandmother",sv:"Mormor"},{de:"Opa",en:"Grandfather",sv:"Morfar"},
  {de:"Onkel",en:"Uncle",sv:"Farbror"},{de:"Tante",en:"Aunt",sv:"Faster"},{de:"Cousin",en:"Cousin",sv:"Kusin"},
  {de:"Kind",en:"Child",sv:"Barn"},{de:"Baby",en:"Baby",sv:"Baby"},{de:"Ehemann",en:"Husband",sv:"Make"},
  {de:"Ehefrau",en:"Wife",sv:"Maka"},{de:"Eltern",en:"Parents",sv:"Föräldrar"},{de:"Geschwister",en:"Siblings",sv:"Syskon"},
  // Körperteile
  {de:"Kopf",en:"Head",sv:"Huvud"},{de:"Haare",en:"Hair",sv:"Hår"},{de:"Auge",en:"Eye",sv:"Öga"},
  {de:"Ohr",en:"Ear",sv:"Öra"},{de:"Nase",en:"Nose",sv:"Näsa"},{de:"Mund",en:"Mouth",sv:"Mun"},
  {de:"Zahn",en:"Tooth",sv:"Tand"},{de:"Hals",en:"Neck",sv:"Hals"},{de:"Schulter",en:"Shoulder",sv:"Axel"},
  {de:"Arm",en:"Arm",sv:"Arm"},{de:"Hand",en:"Hand",sv:"Hand"},{de:"Finger",en:"Finger",sv:"Finger"},
  {de:"Bauch",en:"Belly",sv:"Mage"},{de:"Rücken",en:"Back",sv:"Rygg"},{de:"Bein",en:"Leg",sv:"Ben"},
  {de:"Knie",en:"Knee",sv:"Knä"},{de:"Fuß",en:"Foot",sv:"Fot"},{de:"Zeh",en:"Toe",sv:"Tå"},
  {de:"Herz",en:"Heart",sv:"Hjärta"},{de:"Lunge",en:"Lung",sv:"Lunga"},
  // Kleidung
  {de:"T-Shirt",en:"T-shirt",sv:"T-shirt"},{de:"Hemd",en:"Shirt",sv:"Skjorta"},{de:"Hose",en:"Trousers",sv:"Byxor"},
  {de:"Jeans",en:"Jeans",sv:"Jeans"},{de:"Rock",en:"Skirt",sv:"Kjol"},{de:"Kleid",en:"Dress",sv:"Klänning"},
  {de:"Jacke",en:"Jacket",sv:"Jacka"},{de:"Mantel",en:"Coat",sv:"Kappa"},{de:"Pullover",en:"Sweater",sv:"Tröja"},
  {de:"Schuhe",en:"Shoes",sv:"Skor"},{de:"Socken",en:"Socks",sv:"Strumpor"},{de:"Stiefel",en:"Boots",sv:"Stövlar"},
  {de:"Mütze",en:"Hat",sv:"Mössa"},{de:"Schal",en:"Scarf",sv:"Halsduk"},{de:"Handschuhe",en:"Gloves",sv:"Handskar"},
  {de:"Gürtel",en:"Belt",sv:"Bälte"},{de:"Krawatte",en:"Tie",sv:"Slips"},{de:"Shorts",en:"Shorts",sv:"Shorts"},
  {de:"Unterwäsche",en:"Underwear",sv:"Underkläder"},{de:"Pyjama",en:"Pyjamas",sv:"Pyjamas"},
  // Wetter
  {de:"Sonne",en:"Sun",sv:"Sol"},{de:"Regen",en:"Rain",sv:"Regn"},{de:"Schnee",en:"Snow",sv:"Snö"},
  {de:"Wind",en:"Wind",sv:"Vind"},{de:"Wolke",en:"Cloud",sv:"Moln"},{de:"Gewitter",en:"Thunderstorm",sv:"Åska"},
  {de:"Nebel",en:"Fog",sv:"Dimma"},{de:"Eis",en:"Ice",sv:"Is"},{de:"warm",en:"warm",sv:"varm"},
  {de:"kalt",en:"cold",sv:"kall"},{de:"windig",en:"windy",sv:"blåsig"},{de:"bewölkt",en:"cloudy",sv:"molnig"},
  {de:"sonnig",en:"sunny",sv:"solig"},{de:"regnerisch",en:"rainy",sv:"regnig"},{de:"Frost",en:"Frost",sv:"Frost"},
  // Jahreszeiten
  {de:"Frühling",en:"Spring",sv:"Vår"},{de:"Sommer",en:"Summer",sv:"Sommar"},
  {de:"Herbst",en:"Autumn",sv:"Höst"},{de:"Winter",en:"Winter",sv:"Vinter"},
  // Monate
  {de:"Januar",en:"January",sv:"Januari"},{de:"Februar",en:"February",sv:"Februari"},{de:"März",en:"March",sv:"Mars"},
  {de:"April",en:"April",sv:"April"},{de:"Mai",en:"May",sv:"Maj"},{de:"Juni",en:"June",sv:"Juni"},
  {de:"Juli",en:"July",sv:"Juli"},{de:"August",en:"August",sv:"Augusti"},{de:"September",en:"September",sv:"September"},
  {de:"Oktober",en:"October",sv:"Oktober"},{de:"November",en:"November",sv:"November"},{de:"Dezember",en:"December",sv:"December"},
  // Wochentage
  {de:"Montag",en:"Monday",sv:"Måndag"},{de:"Dienstag",en:"Tuesday",sv:"Tisdag"},{de:"Mittwoch",en:"Wednesday",sv:"Onsdag"},
  {de:"Donnerstag",en:"Thursday",sv:"Torsdag"},{de:"Freitag",en:"Friday",sv:"Fredag"},
  {de:"Samstag",en:"Saturday",sv:"Lördag"},{de:"Sonntag",en:"Sunday",sv:"Söndag"},
  // Möbel
  {de:"Stuhl",en:"Chair",sv:"Stol"},{de:"Tisch",en:"Table",sv:"Bord"},{de:"Sofa",en:"Sofa",sv:"Soffa"},
  {de:"Bett",en:"Bed",sv:"Säng"},{de:"Schrank",en:"Wardrobe",sv:"Skåp"},{de:"Regal",en:"Shelf",sv:"Hylla"},
  {de:"Lampe",en:"Lamp",sv:"Lampa"},{de:"Teppich",en:"Carpet",sv:"Matta"},{de:"Vorhang",en:"Curtain",sv:"Gardin"},
  {de:"Spiegel",en:"Mirror",sv:"Spegel"},{de:"Schreibtisch",en:"Desk",sv:"Skrivbord"},{de:"Kommode",en:"Dresser",sv:"Byrå"},
  {de:"Bücherregal",en:"Bookshelf",sv:"Bokhylla"},{de:"Sessel",en:"Armchair",sv:"Fåtölj"},{de:"Couchtisch",en:"Coffee table",sv:"Soffbord"},
  // Haus
  {de:"Haus",en:"House",sv:"Hus"},{de:"Wohnung",en:"Apartment",sv:"Lägenheit"},{de:"Zimmer",en:"Room",sv:"Rum"},
  {de:"Küche",en:"Kitchen",sv:"Kök"},{de:"Badezimmer",en:"Bathroom",sv:"Badrum"},{de:"Schlafzimmer",en:"Bedroom",sv:"Sovrum"},
  {de:"Wohnzimmer",en:"Living room",sv:"Vardagsrum"},{de:"Flur",en:"Hallway",sv:"Hall"},{de:"Keller",en:"Basement",sv:"Källare"},
  {de:"Garten",en:"Garden",sv:"Trädgård"},{de:"Fenster",en:"Window",sv:"Fönster"},{de:"Tür",en:"Door",sv:"Dörr"},
  {de:"Treppe",en:"Stairs",sv:"Trappa"},{de:"Balkon",en:"Balcony",sv:"Balkong"},{de:"Dach",en:"Roof",sv:"Tak"},
  // Küche
  {de:"Topf",en:"Pot",sv:"Gryta"},{de:"Pfanne",en:"Pan",sv:"Stekpanna"},{de:"Messer",en:"Knife",sv:"Kniv"},
  {de:"Gabel",en:"Fork",sv:"Gaffel"},{de:"Löffel",en:"Spoon",sv:"Sked"},{de:"Teller",en:"Plate",sv:"Tallrik"},
  {de:"Glas",en:"Glass",sv:"Glas"},{de:"Tasse",en:"Cup",sv:"Kopp"},{de:"Schüssel",en:"Bowl",sv:"Skål"},
  {de:"Herd",en:"Stove",sv:"Spis"},{de:"Backofen",en:"Oven",sv:"Ugn"},{de:"Mikrowelle",en:"Microwave",sv:"Mikrovågsugn"},
  {de:"Kühlschrank",en:"Fridge",sv:"Kylskåp"},{de:"Wasserkocher",en:"Kettle",sv:"Vattenkokare"},{de:"Geschirrspüler",en:"Dishwasher",sv:"Diskmaskin"},
  // Badezimmer
  {de:"Dusche",en:"Shower",sv:"Dusch"},{de:"Badewanne",en:"Bathtub",sv:"Badkar"},{de:"Toilette",en:"Toilet",sv:"Toalett"},
  {de:"Waschbecken",en:"Sink",sv:"Handfat"},{de:"Seife",en:"Soap",sv:"Tvål"},{de:"Handtuch",en:"Towel",sv:"Handduk"},
  {de:"Shampoo",en:"Shampoo",sv:"Schampo"},{de:"Zahnbürste",en:"Toothbrush",sv:"Tandborste"},
  {de:"Zahnpasta",en:"Toothpaste",sv:"Tandkräm"},{de:"Rasierer",en:"Razor",sv:"Rakapparat"},
  // Schule
  {de:"Schule",en:"School",sv:"Skola"},{de:"Lehrer",en:"Teacher",sv:"Lärare"},{de:"Schüler",en:"Pupil",sv:"Elev"},
  {de:"Klasse",en:"Class",sv:"Klass"},{de:"Unterricht",en:"Lesson",sv:"Lektion"},{de:"Hausaufgaben",en:"Homework",sv:"Läxa"},
  {de:"Prüfung",en:"Exam",sv:"Prov"},{de:"Note",en:"Grade",sv:"Betyg"},{de:"Buch",en:"Book",sv:"Bok"},
  {de:"Heft",en:"Notebook",sv:"Häfte"},{de:"Stift",en:"Pen",sv:"Penna"},{de:"Bleistift",en:"Pencil",sv:"Blyertspenna"},
  {de:"Lineal",en:"Ruler",sv:"Linjal"},{de:"Rucksack",en:"Backpack",sv:"Ryggsäck"},{de:"Tafel",en:"Blackboard",sv:"Tavla"},
  {de:"Bibliothek",en:"Library",sv:"Bibliotek"},{de:"Mathematik",en:"Mathematics",sv:"Matematik"},{de:"Geschichte",en:"History",sv:"Historia"},
  {de:"Biologie",en:"Biology",sv:"Biologi"},{de:"Chemie",en:"Chemistry",sv:"Kemi"},
  // Arbeit & Berufe
  {de:"Arbeit",en:"Work",sv:"Arbete"},{de:"Büro",en:"Office",sv:"Kontor"},{de:"Chef",en:"Boss",sv:"Chef"},
  {de:"Kollege",en:"Colleague",sv:"Kollega"},{de:"Gehalt",en:"Salary",sv:"Lön"},{de:"Arzt",en:"Doctor",sv:"Läkare"},
  {de:"Krankenschwester",en:"Nurse",sv:"Sjuksköterska"},{de:"Ingenieur",en:"Engineer",sv:"Ingenjör"},{de:"Anwalt",en:"Lawyer",sv:"Advokat"},
  {de:"Polizist",en:"Police officer",sv:"Polis"},{de:"Feuerwehrmann",en:"Firefighter",sv:"Brandman"},{de:"Koch",en:"Cook",sv:"Kock"},
  {de:"Architekt",en:"Architect",sv:"Arkitekt"},{de:"Programmierer",en:"Programmer",sv:"Programmerare"},{de:"Journalist",en:"Journalist",sv:"Journalist"},
  {de:"Bäcker",en:"Baker",sv:"Bagare"},{de:"Mechaniker",en:"Mechanic",sv:"Mekaniker"},{de:"Pilot",en:"Pilot",sv:"Pilot"},
  {de:"Buchhalter",en:"Accountant",sv:"Revisor"},{de:"Verkäufer",en:"Salesperson",sv:"Säljare"},
  // Transport
  {de:"Auto",en:"Car",sv:"Bil"},{de:"Bus",en:"Bus",sv:"Buss"},{de:"Zug",en:"Train",sv:"Tåg"},
  {de:"U-Bahn",en:"Subway",sv:"Tunnelbana"},{de:"Flugzeug",en:"Airplane",sv:"Flygplan"},{de:"Fahrrad",en:"Bicycle",sv:"Cykel"},
  {de:"Motorrad",en:"Motorcycle",sv:"Motorcykel"},{de:"Schiff",en:"Ship",sv:"Skepp"},{de:"Taxi",en:"Taxi",sv:"Taxi"},
  {de:"Straßenbahn",en:"Tram",sv:"Spårvagn"},{de:"Hubschrauber",en:"Helicopter",sv:"Helikopter"},{de:"Tankstelle",en:"Gas station",sv:"Bensinstation"},
  {de:"Bahnhof",en:"Train station",sv:"Tågstation"},{de:"Flughafen",en:"Airport",sv:"Flygplats"},{de:"Hafen",en:"Port",sv:"Hamn"},
  // Stadt
  {de:"Straße",en:"Street",sv:"Gata"},{de:"Platz",en:"Square",sv:"Torg"},{de:"Park",en:"Park",sv:"Park"},
  {de:"Markt",en:"Market",sv:"Marknad"},{de:"Supermarkt",en:"Supermarket",sv:"Stormarknad"},{de:"Apotheke",en:"Pharmacy",sv:"Apotek"},
  {de:"Krankenhaus",en:"Hospital",sv:"Sjukhus"},{de:"Kirche",en:"Church",sv:"Kyrka"},{de:"Museum",en:"Museum",sv:"Museum"},
  {de:"Theater",en:"Theater",sv:"Teater"},{de:"Kino",en:"Cinema",sv:"Bio"},{de:"Restaurant",en:"Restaurant",sv:"Restaurang"},
  {de:"Café",en:"Café",sv:"Kafé"},{de:"Hotel",en:"Hotel",sv:"Hotell"},{de:"Rathaus",en:"Town hall",sv:"Stadshus"},
  // Natur
  {de:"Berg",en:"Mountain",sv:"Berg"},{de:"Meer",en:"Sea",sv:"Hav"},{de:"See",en:"Lake",sv:"Sjö"},
  {de:"Fluss",en:"River",sv:"Flod"},{de:"Wald",en:"Forest",sv:"Skog"},{de:"Wiese",en:"Meadow",sv:"Äng"},
  {de:"Blume",en:"Flower",sv:"Blomma"},{de:"Baum",en:"Tree",sv:"Träd"},{de:"Gras",en:"Grass",sv:"Gräs"},
  {de:"Stein",en:"Stone",sv:"Sten"},{de:"Himmel",en:"Sky",sv:"Himmel"},{de:"Stern",en:"Star",sv:"Stjärna"},
  {de:"Mond",en:"Moon",sv:"Måne"},{de:"Insel",en:"Island",sv:"Ö"},{de:"Wüste",en:"Desert",sv:"Öken"},
  // Sport
  {de:"Fußball",en:"Football",sv:"Fotboll"},{de:"Basketball",en:"Basketball",sv:"Basket"},{de:"Tennis",en:"Tennis",sv:"Tennis"},
  {de:"Schwimmen",en:"Swimming",sv:"Simning"},{de:"Laufen",en:"Running",sv:"Löpning"},{de:"Radfahren",en:"Cycling",sv:"Cykling"},
  {de:"Volleyball",en:"Volleyball",sv:"Volleyboll"},{de:"Handball",en:"Handball",sv:"Handboll"},{de:"Skifahren",en:"Skiing",sv:"Skidåkning"},
  {de:"Yoga",en:"Yoga",sv:"Yoga"},{de:"Boxen",en:"Boxing",sv:"Boxning"},{de:"Klettern",en:"Climbing",sv:"Klättring"},
  {de:"Golf",en:"Golf",sv:"Golf"},{de:"Hockey",en:"Hockey",sv:"Hockey"},{de:"Tanzen",en:"Dancing",sv:"Dans"},
  // Hobbys
  {de:"Lesen",en:"Reading",sv:"Läsning"},{de:"Musik",en:"Music",sv:"Musik"},{de:"Malen",en:"Painting",sv:"Målning"},
  {de:"Kochen",en:"Cooking",sv:"Matlagning"},{de:"Fotografie",en:"Photography",sv:"Fotografi"},{de:"Gärtnern",en:"Gardening",sv:"Trädgårdsarbete"},
  {de:"Backen",en:"Baking",sv:"Bakning"},{de:"Zeichnen",en:"Drawing",sv:"Teckning"},{de:"Spielen",en:"Gaming",sv:"Spelande"},
  {de:"Singen",en:"Singing",sv:"Sång"},{de:"Schreiben",en:"Writing",sv:"Skrivande"},{de:"Wandern",en:"Hiking",sv:"Vandring"},
  {de:"Sammeln",en:"Collecting",sv:"Samling"},{de:"Handarbeit",en:"Handicraft",sv:"Hantverk"},{de:"Reisen",en:"Traveling",sv:"Resande"},
  // Gefühle
  {de:"glücklich",en:"happy",sv:"glad"},{de:"traurig",en:"sad",sv:"ledsen"},{de:"wütend",en:"angry",sv:"arg"},
  {de:"ängstlich",en:"anxious",sv:"orolig"},{de:"überrascht",en:"surprised",sv:"förvånad"},{de:"aufgeregt",en:"excited",sv:"upprymd"},
  {de:"müde",en:"tired",sv:"trött"},{de:"hungrig",en:"hungry",sv:"hungrig"},{de:"verliebt",en:"in love",sv:"förälskad"},
  {de:"stolz",en:"proud",sv:"stolt"},{de:"eifersüchtig",en:"jealous",sv:"svartsjuk"},{de:"entspannt",en:"relaxed",sv:"avslappnad"},
  {de:"einsam",en:"lonely",sv:"ensam"},{de:"nervös",en:"nervous",sv:"nervös"},{de:"dankbar",en:"grateful",sv:"tacksam"},
  // Adjektive
  {de:"groß",en:"big",sv:"stor"},{de:"klein",en:"small",sv:"liten"},{de:"lang",en:"long",sv:"lång"},
  {de:"kurz",en:"short",sv:"kort"},{de:"schnell",en:"fast",sv:"snabb"},{de:"langsam",en:"slow",sv:"långsam"},
  {de:"neu",en:"new",sv:"ny"},{de:"alt",en:"old",sv:"gammal"},{de:"schön",en:"beautiful",sv:"vacker"},
  {de:"hässlich",en:"ugly",sv:"ful"},{de:"teuer",en:"expensive",sv:"dyr"},{de:"günstig",en:"cheap",sv:"billig"},
  {de:"schwer",en:"heavy",sv:"tung"},{de:"leicht",en:"light",sv:"lätt"},{de:"stark",en:"strong",sv:"stark"},
  {de:"schwach",en:"weak",sv:"svag"},{de:"laut",en:"loud",sv:"hög"},{de:"leise",en:"quiet",sv:"tyst"},
  {de:"nass",en:"wet",sv:"våt"},{de:"trocken",en:"dry",sv:"torr"},{de:"sauber",en:"clean",sv:"ren"},
  {de:"schmutzig",en:"dirty",sv:"smutsig"},{de:"offen",en:"open",sv:"öppen"},{de:"geschlossen",en:"closed",sv:"stängd"},
  {de:"voll",en:"full",sv:"full"},{de:"leer",en:"empty",sv:"tom"},{de:"rund",en:"round",sv:"rund"},
  {de:"gefährlich",en:"dangerous",sv:"farlig"},{de:"sicher",en:"safe",sv:"säker"},{de:"wichtig",en:"important",sv:"viktig"},
  // Verben
  {de:"gehen",en:"to go",sv:"att gå"},{de:"kommen",en:"to come",sv:"att komma"},
  {de:"stehen",en:"to stand",sv:"att stå"},{de:"sitzen",en:"to sit",sv:"att sitta"},{de:"schlafen",en:"to sleep",sv:"att sova"},
  {de:"essen",en:"to eat",sv:"att äta"},{de:"trinken",en:"to drink",sv:"att dricka"},{de:"sprechen",en:"to speak",sv:"att tala"},
  {de:"hören",en:"to hear",sv:"att höra"},{de:"sehen",en:"to see",sv:"att se"},{de:"kaufen",en:"to buy",sv:"att köpa"},
  
  {de:"arbeiten",en:"to work",sv:"att arbeta"},{de:"lernen",en:"to learn",sv:"att lära sig"},{de:"helfen",en:"to help",sv:"att hjälpa"},
  {de:"lieben",en:"to love",sv:"att älska"},{de:"mögen",en:"to like",sv:"att gilla"},{de:"öffnen",en:"to open",sv:"att öppna"},
  {de:"schließen",en:"to close",sv:"att stänga"},{de:"geben",en:"to give",sv:"att ge"},{de:"nehmen",en:"to take",sv:"att ta"},
  {de:"machen",en:"to do",sv:"att göra"},{de:"finden",en:"to find",sv:"att hitta"},{de:"verlieren",en:"to lose",sv:"att förlora"},
  {de:"wissen",en:"to know",sv:"att veta"},{de:"denken",en:"to think",sv:"att tänka"},{de:"fragen",en:"to ask",sv:"att fråga"},
  // Zeitwörter
  {de:"heute",en:"today",sv:"idag"},{de:"morgen",en:"tomorrow",sv:"imorgon"},{de:"gestern",en:"yesterday",sv:"igår"},
  {de:"jetzt",en:"now",sv:"nu"},{de:"später",en:"later",sv:"senare"},{de:"früher",en:"earlier",sv:"tidigare"},
  {de:"immer",en:"always",sv:"alltid"},{de:"nie",en:"never",sv:"aldrig"},{de:"manchmal",en:"sometimes",sv:"ibland"},
  {de:"oft",en:"often",sv:"ofta"},{de:"selten",en:"rarely",sv:"sällan"},{de:"bald",en:"soon",sv:"snart"},
  {de:"schon",en:"already",sv:"redan"},{de:"noch",en:"still",sv:"fortfarande"},{de:"heute Abend",en:"tonight",sv:"ikväll"},
  // Länder
  {de:"Deutschland",en:"Germany",sv:"Tyskland"},{de:"Schweden",en:"Sweden",sv:"Sverige"},{de:"Frankreich",en:"France",sv:"Frankrike"},
  {de:"Spanien",en:"Spain",sv:"Spanien"},{de:"Italien",en:"Italy",sv:"Italien"},{de:"England",en:"England",sv:"England"},
  {de:"USA",en:"USA",sv:"USA"},{de:"Österreich",en:"Austria",sv:"Österrike"},{de:"Schweiz",en:"Switzerland",sv:"Schweiz"},
  {de:"Niederlande",en:"Netherlands",sv:"Nederländerna"},{de:"Norwegen",en:"Norway",sv:"Norge"},{de:"Dänemark",en:"Denmark",sv:"Danmark"},
  {de:"Finnland",en:"Finland",sv:"Finland"},{de:"Polen",en:"Poland",sv:"Polen"},{de:"Russland",en:"Russia",sv:"Ryssland"},
  {de:"China",en:"China",sv:"Kina"},{de:"Japan",en:"Japan",sv:"Japan"},{de:"Australien",en:"Australia",sv:"Australien"},
  {de:"Kanada",en:"Canada",sv:"Kanada"},{de:"Brasilien",en:"Brazil",sv:"Brasilien"},
  // Einkaufen
  {de:"Laden",en:"Shop",sv:"Butik"},{de:"Kasse",en:"Checkout",sv:"Kassa"},{de:"Preis",en:"Price",sv:"Pris"},
  {de:"Rabatt",en:"Discount",sv:"Rabatt"},{de:"Quittung",en:"Receipt",sv:"Kvitto"},{de:"Tüte",en:"Bag",sv:"Påse"},
  {de:"Einkaufswagen",en:"Shopping cart",sv:"Kundvagn"},{de:"Angebot",en:"Special offer",sv:"Erbjudande"},
  {de:"Rückgabe",en:"Return",sv:"Retur"},{de:"Öffnungszeiten",en:"Opening hours",sv:"Öppettider"},
  // Restaurant
  {de:"Speisekarte",en:"Menu",sv:"Meny"},{de:"Kellner",en:"Waiter",sv:"Servitör"},{de:"Bestellung",en:"Order",sv:"Beställning"},
  {de:"Vorspeise",en:"Starter",sv:"Förrätt"},{de:"Hauptgericht",en:"Main course",sv:"Huvudrätt"},{de:"Dessert",en:"Dessert",sv:"Dessert"},
  {de:"Rechnung",en:"Bill",sv:"Nota"},{de:"Trinkgeld",en:"Tip",sv:"Dricks"},
  {de:"Reservierung",en:"Reservation",sv:"Reservation"},
  // Arzt
  {de:"Arztpraxis",en:"Doctor's office",sv:"Läkarmottagning"},{de:"Rezept",en:"Prescription",sv:"Recept"},
  {de:"Tablette",en:"Tablet",sv:"Tablett"},{de:"Schmerz",en:"Pain",sv:"Smärta"},{de:"Fieber",en:"Fever",sv:"Feber"},
  {de:"Erkältung",en:"Cold",sv:"Förkylning"},{de:"Allergie",en:"Allergy",sv:"Allergi"},{de:"Blutdruck",en:"Blood pressure",sv:"Blodtryck"},
  {de:"Operation",en:"Surgery",sv:"Operation"},{de:"Notaufnahme",en:"Emergency room",sv:"Akuten"},
  // Bank
  {de:"Konto",en:"Account",sv:"Konto"},{de:"Geld",en:"Money",sv:"Pengar"},{de:"Überweisung",en:"Transfer",sv:"Överföring"},
  {de:"Zinsen",en:"Interest",sv:"Ränta"},{de:"Bargeld",en:"Cash",sv:"Kontanter"},{de:"Geldautomat",en:"ATM",sv:"Bankomat"},
  {de:"Währung",en:"Currency",sv:"Valuta"},{de:"Sparkonto",en:"Savings account",sv:"Sparkonto"},
  {de:"Kredit",en:"Credit",sv:"Kredit"},{de:"Wechselkurs",en:"Exchange rate",sv:"Växelkurs"},
  // Post
  {de:"Brief",en:"Letter",sv:"Brev"},{de:"Paket",en:"Package",sv:"Paket"},{de:"Briefmarke",en:"Stamp",sv:"Frimärke"},
  {de:"Postfach",en:"PO box",sv:"Postbox"},{de:"Postleitzahl",en:"ZIP code",sv:"Postnummer"},
  // Hotel
  {de:"Einzelzimmer",en:"Single room",sv:"Enkelrum"},{de:"Doppelzimmer",en:"Double room",sv:"Dubbelrum"},
  {de:"Frühstück",en:"Breakfast",sv:"Frukost"},{de:"Rezeption",en:"Reception",sv:"Reception"},
  {de:"Check-in",en:"Check-in",sv:"Incheckning"},{de:"Check-out",en:"Check-out",sv:"Utcheckning"},
  {de:"Schlüssel",en:"Key",sv:"Nyckel"},{de:"Minibar",en:"Minibar",sv:"Minibar"},
  {de:"Zimmerservice",en:"Room service",sv:"Rumsservice"},{de:"Schwimmbad",en:"Swimming pool",sv:"Swimmingpool"},
  // Reisen
  {de:"Reise",en:"Trip",sv:"Resa"},{de:"Urlaub",en:"Holiday",sv:"Semester"},{de:"Pass",en:"Passport",sv:"Pass"},
  {de:"Visum",en:"Visa",sv:"Visum"},{de:"Koffer",en:"Suitcase",sv:"Resväska"},{de:"Ticket",en:"Ticket",sv:"Biljett"},
  {de:"Abflug",en:"Departure",sv:"Avgång"},{de:"Ankunft",en:"Arrival",sv:"Ankomst"},{de:"Gepäck",en:"Luggage",sv:"Bagage"},
  {de:"Reiseführer",en:"Travel guide",sv:"Reseguide"},{de:"Karte",en:"Map",sv:"Karta"},{de:"Tourist",en:"Tourist",sv:"Turist"},
  {de:"Sehenswürdigkeit",en:"Attraction",sv:"Sevärdhet"},{de:"Strand",en:"Beach",sv:"Strand"},{de:"Camping",en:"Camping",sv:"Camping"},
  // Mathematik
  {de:"Addition",en:"Addition",sv:"Addition"},{de:"Subtraktion",en:"Subtraction",sv:"Subtraktion"},{de:"Multiplikation",en:"Multiplication",sv:"Multiplikation"},
  {de:"Division",en:"Division",sv:"Division"},{de:"Gleichung",en:"Equation",sv:"Ekvation"},{de:"Zahl",en:"Number",sv:"Tal"},
  {de:"Bruch",en:"Fraction",sv:"Bråk"},{de:"Prozent",en:"Percentage",sv:"Procent"},{de:"Quadratwurzel",en:"Square root",sv:"Kvadratrot"},
  {de:"Geometrie",en:"Geometry",sv:"Geometri"},{de:"Algebra",en:"Algebra",sv:"Algebra"},{de:"Statistik",en:"Statistics",sv:"Statistik"},
  {de:"Wahrscheinlichkeit",en:"Probability",sv:"Sannolikhet"},{de:"Funktion",en:"Function",sv:"Funktion"},{de:"Rechner",en:"Calculator",sv:"Räknare"},
  // Wissenschaft
  {de:"Physik",en:"Physics",sv:"Fysik"},
  {de:"Astronomie",en:"Astronomy",sv:"Astronomi"},{de:"Geographie",en:"Geography",sv:"Geografi"},{de:"Geologie",en:"Geology",sv:"Geologi"},
  {de:"Ökologie",en:"Ecology",sv:"Ekologi"},{de:"Evolution",en:"Evolution",sv:"Evolution"},{de:"Atom",en:"Atom",sv:"Atom"},
  {de:"Molekül",en:"Molecule",sv:"Molekyl"},{de:"Energie",en:"Energy",sv:"Energi"},{de:"Kraft",en:"Force",sv:"Kraft"},
  {de:"Masse",en:"Mass",sv:"Massa"},{de:"Experiment",en:"Experiment",sv:"Experiment"},{de:"Labor",en:"Laboratory",sv:"Laboratorium"},
  // Technologie
  {de:"Technologie",en:"Technology",sv:"Teknologi"},{de:"Roboter",en:"Robot",sv:"Robot"},{de:"Künstliche Intelligenz",en:"Artificial intelligence",sv:"Artificiell intelligens"},
  {de:"Software",en:"Software",sv:"Programvara"},{de:"Hardware",en:"Hardware",sv:"Hårdvara"},{de:"Algorithmus",en:"Algorithm",sv:"Algoritm"},
  {de:"Daten",en:"Data",sv:"Data"},{de:"Cloud",en:"Cloud",sv:"Moln"},{de:"Sensor",en:"Sensor",sv:"Sensor"},
  {de:"Automatisierung",en:"Automation",sv:"Automatisering"},{de:"Innovation",en:"Innovation",sv:"Innovation"},{de:"Digital",en:"Digital",sv:"Digital"},
  {de:"Analog",en:"Analog",sv:"Analog"},{de:"Programm",en:"Program",sv:"Program"},{de:"System",en:"System",sv:"System"},
  // Computer
  {de:"Computer",en:"Computer",sv:"Dator"},{de:"Laptop",en:"Laptop",sv:"Laptop"},{de:"Tastatur",en:"Keyboard",sv:"Tangentbord"},
  {de:"Bildschirm",en:"Monitor",sv:"Bildskärm"},{de:"Prozessor",en:"Processor",sv:"Processor"},
  {de:"Speicher",en:"Memory",sv:"Minne"},{de:"Festplatte",en:"Hard drive",sv:"Hårddisk"},{de:"Drucker",en:"Printer",sv:"Skrivare"},
  {de:"Betriebssystem",en:"Operating system",sv:"Operativsystem"},{de:"Datei",en:"File",sv:"Fil"},{de:"Ordner",en:"Folder",sv:"Mapp"},
  {de:"USB-Stick",en:"USB stick",sv:"USB-minne"},{de:"Passwort",en:"Password",sv:"Lösenord"},
  // Internet
  {de:"Internet",en:"Internet",sv:"Internet"},{de:"Webseite",en:"Website",sv:"Webbplats"},{de:"Browser",en:"Browser",sv:"Webbläsare"},
  {de:"E-Mail",en:"Email",sv:"E-post"},{de:"Herunterladen",en:"Download",sv:"Nedladdning"},{de:"Hochladen",en:"Upload",sv:"Uppladdning"},
  {de:"Soziale Medien",en:"Social media",sv:"Sociala medier"},{de:"App",en:"App",sv:"App"},{de:"WLAN",en:"Wi-Fi",sv:"Wi-Fi"},
  {de:"Server",en:"Server",sv:"Server"},{de:"Netzwerk",en:"Network",sv:"Nätverk"},{de:"Suchmaschine",en:"Search engine",sv:"Sökmotor"},
  {de:"Link",en:"Link",sv:"Länk"},{de:"Streaming",en:"Streaming",sv:"Streaming"},
  // Musik
  {de:"Lied",en:"Song",sv:"Låt"},{de:"Melodie",en:"Melody",sv:"Melodi"},{de:"Rhythmus",en:"Rhythm",sv:"Rytm"},
  {de:"Takt",en:"Beat",sv:"Takt"},{de:"Akkord",en:"Chord",sv:"Ackord"},{de:"Konzert",en:"Concert",sv:"Konsert"},
  {de:"Orchester",en:"Orchestra",sv:"Orkester"},{de:"Band",en:"Band",sv:"Band"},{de:"Sänger",en:"Singer",sv:"Sångare"},
  {de:"Komponist",en:"Composer",sv:"Kompositör"},{de:"Album",en:"Album",sv:"Album"},{de:"Text",en:"Lyrics",sv:"Låttext"},
  {de:"Klang",en:"Sound",sv:"Ljud"},{de:"Harmonie",en:"Harmony",sv:"Harmoni"},{de:"Bühne",en:"Stage",sv:"Scen"},
  // Instrumente
  {de:"Gitarre",en:"Guitar",sv:"Gitarr"},{de:"Klavier",en:"Piano",sv:"Piano"},{de:"Geige",en:"Violin",sv:"Fiol"},
  {de:"Schlagzeug",en:"Drums",sv:"Trummor"},{de:"Flöte",en:"Flute",sv:"Flöjt"},{de:"Trompete",en:"Trumpet",sv:"Trumpet"},
  {de:"Saxofon",en:"Saxophone",sv:"Saxofon"},{de:"Cello",en:"Cello",sv:"Cello"},{de:"Bass",en:"Bass",sv:"Bas"},
  {de:"Harfe",en:"Harp",sv:"Harpa"},{de:"Akkordeon",en:"Accordion",sv:"Dragspel"},{de:"Klarinette",en:"Clarinet",sv:"Klarinett"},
  {de:"Posaune",en:"Trombone",sv:"Trombon"},{de:"Orgel",en:"Organ",sv:"Orgel"},{de:"Keyboard",en:"Keyboard",sv:"Keyboard"},
  // Kunst
  {de:"Kunst",en:"Art",sv:"Konst"},{de:"Gemälde",en:"Painting",sv:"Målning"},{de:"Skulptur",en:"Sculpture",sv:"Skulptur"},
  {de:"Ausstellung",en:"Exhibition",sv:"Utställning"},{de:"Leinwand",en:"Canvas",sv:"Kanvas"},{de:"Pinsel",en:"Brush",sv:"Pensel"},
  {de:"Farbe",en:"Color",sv:"Färg"},{de:"Galerie",en:"Gallery",sv:"Galleri"},{de:"Künstler",en:"Artist",sv:"Konstnär"},
  {de:"Porträt",en:"Portrait",sv:"Porträtt"},{de:"Landschaft",en:"Landscape",sv:"Landskap"},{de:"Abstrakt",en:"Abstract",sv:"Abstrakt"},
  {de:"Stil",en:"Style",sv:"Stil"},{de:"Technik",en:"Technique",sv:"Teknik"},{de:"Meisterwerk",en:"Masterpiece",sv:"Mästerverk"},
  // Literatur
  {de:"Roman",en:"Novel",sv:"Roman"},{de:"Gedicht",en:"Poem",sv:"Dikt"},
  {de:"Autor",en:"Author",sv:"Författare"},{de:"Figur",en:"Character",sv:"Karaktär"},{de:"Kapitel",en:"Chapter",sv:"Kapitel"},
  {de:"Handlung",en:"Plot",sv:"Handling"},{de:"Genre",en:"Genre",sv:"Genre"},{de:"Metapher",en:"Metaphor",sv:"Metafor"},
  {de:"Erzähler",en:"Narrator",sv:"Berättare"},{de:"Verlag",en:"Publisher",sv:"Förlag"},{de:"Redakteur",en:"Editor",sv:"Redaktör"},
  {de:"Essay",en:"Essay",sv:"Essä"},{de:"Drama",en:"Drama",sv:"Drama"},{de:"Biografie",en:"Biography",sv:"Biografi"},
  // Geschichte
  {de:"Krieg",en:"War",sv:"Krig"},{de:"Revolution",en:"Revolution",sv:"Revolution"},{de:"Kaiserreich",en:"Empire",sv:"Imperium"},
  {de:"Königreich",en:"Kingdom",sv:"Kungadöme"},{de:"Demokratie",en:"Democracy",sv:"Demokrati"},{de:"Antike",en:"Ancient",sv:"Antiken"},
  {de:"Mittelalter",en:"Medieval",sv:"Medeltiden"},{de:"Neuzeit",en:"Modern era",sv:"Modern tid"},{de:"Denkmal",en:"Monument",sv:"Monument"},
  {de:"Artefakt",en:"Artifact",sv:"Artefakt"},{de:"Zivilisation",en:"Civilization",sv:"Civilisation"},{de:"Kolonie",en:"Colony",sv:"Koloni"},
  {de:"Handel",en:"Trade",sv:"Handel"},{de:"Expedition",en:"Expedition",sv:"Expedition"},{de:"Sklaverei",en:"Slavery",sv:"Slaveri"},
  // Politik
  {de:"Politik",en:"Politics",sv:"Politik"},{de:"Regierung",en:"Government",sv:"Regering"},{de:"Parlament",en:"Parliament",sv:"Parlament"},
  {de:"Wahl",en:"Election",sv:"Val"},{de:"Partei",en:"Party",sv:"Parti"},{de:"Präsident",en:"President",sv:"President"},
  {de:"Minister",en:"Minister",sv:"Minister"},{de:"Gesetz",en:"Law",sv:"Lag"},{de:"Verfassung",en:"Constitution",sv:"Grundlag"},
  {de:"Protest",en:"Protest",sv:"Protest"},{de:"Stimme",en:"Vote",sv:"Röst"},{de:"Vertrag",en:"Treaty",sv:"Fördrag"},
  {de:"Diplomat",en:"Diplomat",sv:"Diplomat"},{de:"Opposition",en:"Opposition",sv:"Opposition"},{de:"Koalition",en:"Coalition",sv:"Koalition"},
  // Religion
  {de:"Religion",en:"Religion",sv:"Religion"},{de:"Moschee",en:"Mosque",sv:"Moské"},{de:"Tempel",en:"Temple",sv:"Tempel"},
  {de:"Gebet",en:"Prayer",sv:"Bön"},{de:"Bibel",en:"Bible",sv:"Bibeln"},{de:"Gott",en:"God",sv:"Gud"},
  {de:"Glaube",en:"Faith",sv:"Tro"},{de:"Zeremonie",en:"Ceremony",sv:"Ceremoni"},{de:"Priester",en:"Priest",sv:"Präst"},
  {de:"Mönch",en:"Monk",sv:"Munk"},{de:"Heiliger",en:"Saint",sv:"Helgon"},{de:"Ritual",en:"Ritual",sv:"Ritual"},
  {de:"Meditation",en:"Meditation",sv:"Meditation"},{de:"Seele",en:"Soul",sv:"Själ"},{de:"Taufe",en:"Baptism",sv:"Dop"},
  // Philosophie
  {de:"Philosophie",en:"Philosophy",sv:"Filosofi"},{de:"Ethik",en:"Ethics",sv:"Etik"},{de:"Logik",en:"Logic",sv:"Logik"},
  {de:"Bewusstsein",en:"Consciousness",sv:"Medvetande"},{de:"Freiheit",en:"Freedom",sv:"Frihet"},{de:"Wahrheit",en:"Truth",sv:"Sanning"},
  {de:"Moral",en:"Morality",sv:"Moral"},{de:"Metaphysik",en:"Metaphysics",sv:"Metafysik"},
  {de:"Existenz",en:"Existence",sv:"Existens"},
  // Psychologie
  {de:"Psychologie",en:"Psychology",sv:"Psykologi"},{de:"Verhalten",en:"Behavior",sv:"Beteende"},{de:"Emotion",en:"Emotion",sv:"Emotion"},
  {de:"Persönlichkeit",en:"Personality",sv:"Personlighet"},{de:"Trauma",en:"Trauma",sv:"Trauma"},{de:"Therapie",en:"Therapy",sv:"Terapi"},
  {de:"Angst",en:"Anxiety",sv:"Ångest"},{de:"Depression",en:"Depression",sv:"Depression"},{de:"Motivation",en:"Motivation",sv:"Motivation"},
  // Medizin
  {de:"Medizin",en:"Medicine",sv:"Medicin"},{de:"Chirurgie",en:"Surgery",sv:"Kirurgi"},{de:"Diagnose",en:"Diagnosis",sv:"Diagnos"},
  {de:"Behandlung",en:"Treatment",sv:"Behandling"},{de:"Impfstoff",en:"Vaccine",sv:"Vaccin"},{de:"Anatomie",en:"Anatomy",sv:"Anatomi"},
  {de:"Organ",en:"Organ",sv:"Organ"},{de:"Blut",en:"Blood",sv:"Blod"},{de:"Skelett",en:"Skeleton",sv:"Skelett"},
  {de:"Nerv",en:"Nerve",sv:"Nerv"},{de:"Muskel",en:"Muscle",sv:"Muskel"},{de:"Hormon",en:"Hormone",sv:"Hormon"},
  {de:"Immunsystem",en:"Immune system",sv:"Immunsystem"},{de:"Genetik",en:"Genetics",sv:"Genetik"},{de:"Röntgen",en:"X-ray",sv:"Röntgen"},
  // Krankheiten
  {de:"Grippe",en:"Flu",sv:"Influensa"},{de:"Kopfschmerzen",en:"Headache",sv:"Huvudvärk"},{de:"Diabetes",en:"Diabetes",sv:"Diabetes"},
  {de:"Krebs",en:"Cancer",sv:"Cancer"},{de:"Infektion",en:"Infection",sv:"Infektion"},{de:"Entzündung",en:"Inflammation",sv:"Inflammation"},
  {de:"Knochenbruch",en:"Fracture",sv:"Fraktur"},{de:"Schlaganfall",en:"Stroke",sv:"Stroke"},{de:"Herzinfarkt",en:"Heart attack",sv:"Hjärtinfarkt"},
  {de:"Asthma",en:"Asthma",sv:"Astma"},{de:"Anämie",en:"Anemia",sv:"Anemi"},{de:"Virus",en:"Virus",sv:"Virus"},
  {de:"Bakterie",en:"Bacterium",sv:"Bakterie"},{de:"Migräne",en:"Migraine",sv:"Migrän"},{de:"Arthritis",en:"Arthritis",sv:"Artrit"},
  // Medikamente
  {de:"Medikament",en:"Medication",sv:"Läkemedel"},{de:"Antibiotikum",en:"Antibiotic",sv:"Antibiotika"},{de:"Schmerzmittel",en:"Painkiller",sv:"Smärtstillande"},
  {de:"Vitamin",en:"Vitamin",sv:"Vitamin"},{de:"Injektion",en:"Injection",sv:"Injektion"},{de:"Kapsel",en:"Capsule",sv:"Kapsel"},
  {de:"Creme",en:"Cream",sv:"Kräm"},{de:"Tropfen",en:"Drops",sv:"Droppar"},{de:"Sirup",en:"Syrup",sv:"Sirap"},
  {de:"Salbe",en:"Ointment",sv:"Salva"},
  // Rechtssystem
  {de:"Gerechtigkeit",en:"Justice",sv:"Rättvisa"},{de:"Gericht",en:"Court",sv:"Domstol"},{de:"Richter",en:"Judge",sv:"Domare"},
  {de:"Verbrechen",en:"Crime",sv:"Brott"},{de:"Urteil",en:"Sentence",sv:"Dom"},{de:"Gefängnis",en:"Prison",sv:"Fängelse"},
  {de:"Zeuge",en:"Witness",sv:"Vittne"},{de:"Verteidigung",en:"Defense",sv:"Försvar"},{de:"Klage",en:"Lawsuit",sv:"Stämning"},
  {de:"Rechte",en:"Rights",sv:"Rättigheter"},
  // Wirtschaft
  {de:"Wirtschaft",en:"Economy",sv:"Ekonomi"},{de:"Export",en:"Export",sv:"Export"},{de:"Import",en:"Import",sv:"Import"},
  {de:"Produktion",en:"Production",sv:"Produktion"},{de:"Konsum",en:"Consumption",sv:"Konsumtion"},{de:"Inflation",en:"Inflation",sv:"Inflation"},
  {de:"Arbeitslosigkeit",en:"Unemployment",sv:"Arbetslöshet"},{de:"Unternehmen",en:"Company",sv:"Företag"},{de:"Industrie",en:"Industry",sv:"Industri"},
  {de:"Investition",en:"Investment",sv:"Investering"},{de:"Kapital",en:"Capital",sv:"Kapital"},{de:"Gewinn",en:"Profit",sv:"Vinst"},
  {de:"Verlust",en:"Loss",sv:"Förlust"},{de:"Wachstum",en:"Growth",sv:"Tillväxt"},{de:"Bruttoinlandsprodukt",en:"GDP",sv:"BNP"},
  // Finanzen
  {de:"Finanzen",en:"Finance",sv:"Finans"},{de:"Budget",en:"Budget",sv:"Budget"},{de:"Steuer",en:"Tax",sv:"Skatt"},
  {de:"Einnahmen",en:"Revenue",sv:"Intäkt"},{de:"Ausgaben",en:"Expenses",sv:"Utgifter"},{de:"Versicherung",en:"Insurance",sv:"Försäkring"},
  {de:"Rente",en:"Pension",sv:"Pension"},{de:"Aktie",en:"Stock",sv:"Aktie"},{de:"Anleihe",en:"Bond",sv:"Obligation"},
  {de:"Dividende",en:"Dividend",sv:"Utdelning"},{de:"Portfolio",en:"Portfolio",sv:"Portfölj"},{de:"Vermögen",en:"Asset",sv:"Tillgång"},
  {de:"Schulden",en:"Debt",sv:"Skuld"},{de:"Revision",en:"Audit",sv:"Revision"},{de:"Hypothek",en:"Mortgage",sv:"Bolån"},
  // Immobilien
  {de:"Immobilien",en:"Real estate",sv:"Fastighet"},{de:"Grundstück",en:"Property",sv:"Tomt"},{de:"Miete",en:"Rent",sv:"Hyra"},
  {de:"Makler",en:"Agent",sv:"Mäklare"},{de:"Vermieter",en:"Landlord",sv:"Hyresvärd"},{de:"Mieter",en:"Tenant",sv:"Hyresgäst"},
  {de:"Wert",en:"Value",sv:"Värde"},{de:"Kaufpreis",en:"Purchase price",sv:"Köpesumma"},{de:"Nebenkosten",en:"Additional costs",sv:"Driftskostnader"},
  {de:"Eigentümer",en:"Owner",sv:"Ägare"},
  // Bauwesen
  {de:"Bauwesen",en:"Construction",sv:"Bygge"},{de:"Gebäude",en:"Building",sv:"Byggnad"},{de:"Fundament",en:"Foundation",sv:"Grund"},
  {de:"Wand",en:"Wall",sv:"Vägg"},{de:"Decke",en:"Ceiling",sv:"Tak"},{de:"Fußboden",en:"Floor",sv:"Golv"},
  {de:"Aufzug",en:"Elevator",sv:"Hiss"},{de:"Beton",en:"Concrete",sv:"Betong"},{de:"Stahl",en:"Steel",sv:"Stål"},
  {de:"Ziegel",en:"Brick",sv:"Tegel"},
  // Landwirtschaft
  {de:"Landwirtschaft",en:"Agriculture",sv:"Jordbruk"},{de:"Bauernhof",en:"Farm",sv:"Gård"},{de:"Feld",en:"Field",sv:"Åker"},
  {de:"Ernte",en:"Harvest",sv:"Skörd"},{de:"Saat",en:"Seed",sv:"Frö"},{de:"Erde",en:"Soil",sv:"Jord"},
  {de:"Dünger",en:"Fertilizer",sv:"Gödsel"},{de:"Traktor",en:"Tractor",sv:"Traktor"},{de:"Bewässerung",en:"Irrigation",sv:"Bevattning"},
  {de:"Vieh",en:"Livestock",sv:"Boskap"},{de:"Gewächshaus",en:"Greenhouse",sv:"Växthus"},{de:"Bio",en:"Organic",sv:"Ekologisk"},
  {de:"Pestizid",en:"Pesticide",sv:"Bekämpningsmedel"},{de:"Bauer",en:"Farmer",sv:"Bonde"},{de:"Weide",en:"Pasture",sv:"Betesmark"},
  // Wilde Tiere
  {de:"Gorilla",en:"Gorilla",sv:"Gorilla"},{de:"Zebra",en:"Zebra",sv:"Zebra"},{de:"Giraffe",en:"Giraffe",sv:"Giraff"},
  {de:"Leopard",en:"Leopard",sv:"Leopard"},{de:"Gepard",en:"Cheetah",sv:"Gepard"},{de:"Nashorn",en:"Rhinoceros",sv:"Noshörning"},
  {de:"Nilpferd",en:"Hippopotamus",sv:"Flodhäst"},{de:"Jaguar",en:"Jaguar",sv:"Jaguar"},{de:"Puma",en:"Puma",sv:"Puma"},
  {de:"Luchs",en:"Lynx",sv:"Lodjur"},{de:"Wildschwein",en:"Wild boar",sv:"Vildsvin"},{de:"Bison",en:"Bison",sv:"Bison"},
  {de:"Rentier",en:"Reindeer",sv:"Ren"},{de:"Lemur",en:"Lemur",sv:"Lemur"},{de:"Gürteltier",en:"Armadillo",sv:"Bältdjur"},
  // Haustiere
  {de:"Hamster",en:"Hamster",sv:"Hamster"},{de:"Meerschweinchen",en:"Guinea pig",sv:"Marsvin"},{de:"Papagei",en:"Parrot",sv:"Papegoja"},
  {de:"Goldfisch",en:"Goldfish",sv:"Guldfisk"},{de:"Frettchen",en:"Ferret",sv:"Iller"},{de:"Eidechse",en:"Lizard",sv:"Ödla"},
  {de:"Wellensittich",en:"Budgie",sv:"Undulat"},{de:"Chinchilla",en:"Chinchilla",sv:"Chinchilla"},{de:"Kaninchen",en:"Rabbit",sv:"Kanin"},
  // Meerestiere
  {de:"Wal",en:"Whale",sv:"Val"},{de:"Tintenfisch",en:"Octopus",sv:"Bläckfisk"},{de:"Qualle",en:"Jellyfish",sv:"Manet"},
  {de:"Seestern",en:"Starfish",sv:"Sjöstjärna"},{de:"Krabbe",en:"Crab",sv:"Krabba"},{de:"Hummer",en:"Lobster",sv:"Hummer"},
  {de:"Garnele",en:"Shrimp",sv:"Räka"},{de:"Seepferdchen",en:"Seahorse",sv:"Sjöhäst"},{de:"Robbe",en:"Seal",sv:"Säl"},
  {de:"Walross",en:"Walrus",sv:"Valross"},{de:"Otter",en:"Otter",sv:"Utter"},{de:"Aal",en:"Eel",sv:"Ål"},
  {de:"Thunfisch",en:"Tuna",sv:"Tonfisk"},{de:"Lachs",en:"Salmon",sv:"Lax"},{de:"Seehund",en:"Harbor seal",sv:"Knubbsäl"},
  // Vögel
  {de:"Rotkehlchen",en:"Robin",sv:"Rödhake"},{de:"Sperling",en:"Sparrow",sv:"Sparv"},{de:"Taube",en:"Pigeon",sv:"Duva"},
  {de:"Krähe",en:"Crow",sv:"Kråka"},{de:"Möwe",en:"Seagull",sv:"Mås"},{de:"Storch",en:"Stork",sv:"Stork"},
  {de:"Pelikan",en:"Pelican",sv:"Pelikan"},{de:"Flamingo",en:"Flamingo",sv:"Flamingo"},{de:"Specht",en:"Woodpecker",sv:"Hackspett"},
  {de:"Schwalbe",en:"Swallow",sv:"Svala"},{de:"Nachtigall",en:"Nightingale",sv:"Näktergal"},{de:"Pfau",en:"Peacock",sv:"Påfågel"},
  {de:"Pinguin",en:"Penguin",sv:"Pingvin"},{de:"Albatros",en:"Albatross",sv:"Albatross"},{de:"Rabe",en:"Raven",sv:"Korp"},
  // Insekten
  {de:"Biene",en:"Bee",sv:"Bi"},{de:"Wespe",en:"Wasp",sv:"Geting"},{de:"Schmetterling",en:"Butterfly",sv:"Fjäril"},
  {de:"Ameise",en:"Ant",sv:"Myra"},{de:"Fliege",en:"Fly",sv:"Fluga"},{de:"Mücke",en:"Mosquito",sv:"Mygga"},
  {de:"Käfer",en:"Beetle",sv:"Skalbagge"},{de:"Heuschrecke",en:"Grasshopper",sv:"Gräshoppa"},{de:"Raupe",en:"Caterpillar",sv:"Larv"},
  {de:"Libelle",en:"Dragonfly",sv:"Trollslända"},{de:"Kakerlake",en:"Cockroach",sv:"Kackerlacka"},{de:"Zecke",en:"Tick",sv:"Fästing"},
  // Pflanzen
  {de:"Pflanze",en:"Plant",sv:"Växt"},{de:"Kaktus",en:"Cactus",sv:"Kaktus"},{de:"Farn",en:"Fern",sv:"Ormbunke"},
  {de:"Moos",en:"Moss",sv:"Mossa"},{de:"Efeu",en:"Ivy",sv:"Murgröna"},{de:"Bambus",en:"Bamboo",sv:"Bambu"},
  {de:"Palme",en:"Palm",sv:"Palm"},{de:"Alge",en:"Seaweed",sv:"Tång"},{de:"Pilz",en:"Mushroom",sv:"Svamp"},
  {de:"Distel",en:"Thistle",sv:"Tistel"},
  // Blumen
  {de:"Rose",en:"Rose",sv:"Ros"},{de:"Tulpe",en:"Tulip",sv:"Tulpan"},{de:"Sonnenblume",en:"Sunflower",sv:"Solros"},
  {de:"Gänseblümchen",en:"Daisy",sv:"Tusensköna"},{de:"Lilie",en:"Lily",sv:"Lilja"},{de:"Orchidee",en:"Orchid",sv:"Orkidé"},
  {de:"Lavendel",en:"Lavender",sv:"Lavendel"},{de:"Veilchen",en:"Violet",sv:"Viol"},{de:"Mohn",en:"Poppy",sv:"Vallmo"},
  {de:"Hyazinthe",en:"Hyacinth",sv:"Hyacint"},{de:"Narzisse",en:"Daffodil",sv:"Påsklilja"},{de:"Chrysantheme",en:"Chrysanthemum",sv:"Krysantemum"},
  // Bäume
  {de:"Eiche",en:"Oak",sv:"Ek"},{de:"Kiefer",en:"Pine",sv:"Tall"},{de:"Birke",en:"Birch",sv:"Björk"},
  {de:"Ahorn",en:"Maple",sv:"Lönn"},{de:"Fichte",en:"Spruce",sv:"Gran"},
  {de:"Lärche",en:"Larch",sv:"Lärk"},{de:"Kastanie",en:"Chestnut",sv:"Kastanj"},{de:"Walnuss",en:"Walnut",sv:"Valnöt"},
  {de:"Buche",en:"Beech",sv:"Bok"},{de:"Esche",en:"Ash tree",sv:"Ask"},{de:"Kirschbaum",en:"Cherry tree",sv:"Körsbärsträd"},
  // Gemüse
  {de:"Spinat",en:"Spinach",sv:"Spenat"},{de:"Kohl",en:"Cabbage",sv:"Kål"},
  {de:"Brokkoli",en:"Broccoli",sv:"Broccoli"},{de:"Blumenkohl",en:"Cauliflower",sv:"Blomkål"},{de:"Erbsen",en:"Peas",sv:"Ärtor"},
  {de:"Bohnen",en:"Beans",sv:"Bönor"},{de:"Mais",en:"Corn",sv:"Majs"},{de:"Kürbis",en:"Pumpkin",sv:"Pumpa"},
  {de:"Zucchini",en:"Zucchini",sv:"Zucchini"},{de:"Aubergine",en:"Eggplant",sv:"Aubergine"},{de:"Spargel",en:"Asparagus",sv:"Sparris"},
  {de:"Sellerie",en:"Celery",sv:"Selleri"},{de:"Radieschen",en:"Radish",sv:"Rädisa"},{de:"Artischocke",en:"Artichoke",sv:"Kronärtskocka"},
  // Obst
  {de:"Zitrone",en:"Lemon",sv:"Citron"},{de:"Limette",en:"Lime",sv:"Lime"},{de:"Traube",en:"Grape",sv:"Druva"},
  {de:"Wassermelone",en:"Watermelon",sv:"Vattenmelon"},{de:"Melone",en:"Melon",sv:"Melon"},{de:"Pfirsich",en:"Peach",sv:"Persika"},
  {de:"Birne",en:"Pear",sv:"Päron"},{de:"Kirsche",en:"Cherry",sv:"Körsbär"},{de:"Mango",en:"Mango",sv:"Mango"},
  {de:"Ananas",en:"Pineapple",sv:"Ananas"},{de:"Kiwi",en:"Kiwi",sv:"Kiwi"},{de:"Pflaume",en:"Plum",sv:"Plommon"},
  {de:"Aprikose",en:"Apricot",sv:"Aprikos"},{de:"Kokosnuss",en:"Coconut",sv:"Kokosnöt"},{de:"Himbeere",en:"Raspberry",sv:"Hallon"},
  // Gewürze
  {de:"Zimt",en:"Cinnamon",sv:"Kanel"},{de:"Kreuzkümmel",en:"Cumin",sv:"Spiskummin"},{de:"Kurkuma",en:"Turmeric",sv:"Gurkmeja"},
  {de:"Oregano",en:"Oregano",sv:"Oregano"},{de:"Thymian",en:"Thyme",sv:"Timjan"},{de:"Basilikum",en:"Basil",sv:"Basilika"},
  {de:"Rosmarin",en:"Rosemary",sv:"Rosmarin"},{de:"Ingwer",en:"Ginger",sv:"Ingefära"},{de:"Nelke",en:"Clove",sv:"Kryddnejlika"},
  {de:"Muskatnuss",en:"Nutmeg",sv:"Muskot"},{de:"Lorbeerblatt",en:"Bay leaf",sv:"Lagerblad"},{de:"Chili",en:"Chili",sv:"Chili"},
  // Backwaren
  {de:"Kuchen",en:"Cake",sv:"Tårta"},{de:"Keks",en:"Cookie",sv:"Kaka"},{de:"Croissant",en:"Croissant",sv:"Croissant"},
  {de:"Muffin",en:"Muffin",sv:"Muffin"},{de:"Baguette",en:"Baguette",sv:"Baguette"},{de:"Brezel",en:"Pretzel",sv:"Kringla"},
  {de:"Waffel",en:"Waffle",sv:"Våffla"},{de:"Donut",en:"Donut",sv:"Munk"},{de:"Torte",en:"Tart",sv:"Paj"},
  {de:"Brötchen",en:"Roll",sv:"Fralla"},
  // Fleisch
  {de:"Rindfleisch",en:"Beef",sv:"Nötkött"},{de:"Schweinefleisch",en:"Pork",sv:"Fläsk"},{de:"Lammfleisch",en:"Lamb",sv:"Lammkött"},
  {de:"Kalbfleisch",en:"Veal",sv:"Kalvkött"},{de:"Pute",en:"Turkey",sv:"Kalkon"},{de:"Wildfleisch",en:"Venison",sv:"Viltkött"},
  {de:"Hackfleisch",en:"Minced meat",sv:"Köttfärs"},{de:"Filet",en:"Fillet",sv:"Filé"},{de:"Speck",en:"Bacon",sv:"Bacon"},
  {de:"Leber",en:"Liver",sv:"Lever"},
  // Fisch
  {de:"Kabeljau",en:"Cod",sv:"Torsk"},{de:"Hering",en:"Herring",sv:"Sill"},{de:"Forelle",en:"Trout",sv:"Forell"},
  {de:"Barsch",en:"Perch",sv:"Abborre"},{de:"Hecht",en:"Pike",sv:"Gädda"},{de:"Sardine",en:"Sardine",sv:"Sardin"},
  {de:"Makrele",en:"Mackerel",sv:"Makrill"},{de:"Flunder",en:"Flounder",sv:"Flundra"},{de:"Seelachs",en:"Coalfish",sv:"Sej"},
  {de:"Karpfen",en:"Carp",sv:"Karp"},
  // Milchprodukte
  {de:"Joghurt",en:"Yogurt",sv:"Yoghurt"},{de:"Sahne",en:"Cream",sv:"Grädde"},{de:"Sauerrahm",en:"Sour cream",sv:"Gräddfil"},
  {de:"Quark",en:"Quark",sv:"Kvarg"},{de:"Schlagsahne",en:"Whipped cream",sv:"Vispgrädde"},
  {de:"Frischkäse",en:"Cream cheese",sv:"Färskost"},{de:"Kefir",en:"Kefir",sv:"Kefir"},{de:"Kondensmilch",en:"Condensed milk",sv:"Kondenserad mjölk"},
  {de:"Mozzarella",en:"Mozzarella",sv:"Mozzarella"},
  // Getreide
  {de:"Weizen",en:"Wheat",sv:"Vete"},{de:"Roggen",en:"Rye",sv:"Råg"},{de:"Hafer",en:"Oats",sv:"Havre"},
  {de:"Gerste",en:"Barley",sv:"Korn"},{de:"Hirse",en:"Millet",sv:"Hirs"},{de:"Buchweizen",en:"Buckwheat",sv:"Bovete"},
  {de:"Quinoa",en:"Quinoa",sv:"Quinoa"},{de:"Dinkel",en:"Spelt",sv:"Dinkel"},
  // Süßigkeiten
  {de:"Bonbon",en:"Candy",sv:"Godis"},{de:"Gummibärchen",en:"Gummy bears",sv:"Gummibjörnar"},{de:"Lutscher",en:"Lollipop",sv:"Slickepinne"},
  {de:"Karamell",en:"Caramel",sv:"Kola"},{de:"Nougat",en:"Nougat",sv:"Nougat"},{de:"Marshmallow",en:"Marshmallow",sv:"Marshmallow"},
  {de:"Praline",en:"Praline",sv:"Pralin"},{de:"Marzipan",en:"Marzipan",sv:"Marsipan"},{de:"Lakritze",en:"Licorice",sv:"Lakrits"},
  {de:"Kaugummi",en:"Chewing gum",sv:"Tuggummi"},
  // Fastfood
  {de:"Hamburger",en:"Hamburger",sv:"Hamburgare"},{de:"Hotdog",en:"Hot dog",sv:"Varmkorv"},{de:"Pizza",en:"Pizza",sv:"Pizza"},
  {de:"Pommes",en:"French fries",sv:"Pommes frites"},{de:"Kebab",en:"Kebab",sv:"Kebab"},{de:"Sandwich",en:"Sandwich",sv:"Smörgås"},
  {de:"Wrap",en:"Wrap",sv:"Wrap"},{de:"Nuggets",en:"Nuggets",sv:"Nuggets"},{de:"Nachos",en:"Nachos",sv:"Nachos"},
  {de:"Milchshake",en:"Milkshake",sv:"Milkshake"},
  // Werkzeuge
  {de:"Hammer",en:"Hammer",sv:"Hammare"},{de:"Schraubenzieher",en:"Screwdriver",sv:"Skruvmejsel"},{de:"Schraubenschlüssel",en:"Wrench",sv:"Skiftnyckel"},
  {de:"Zange",en:"Pliers",sv:"Tång"},{de:"Bohrer",en:"Drill",sv:"Borr"},{de:"Säge",en:"Saw",sv:"Såg"},
  {de:"Meißel",en:"Chisel",sv:"Mejsel"},{de:"Wasserwaage",en:"Level",sv:"Vattenpass"},{de:"Maßband",en:"Tape measure",sv:"Måttband"},
  {de:"Sandpapier",en:"Sandpaper",sv:"Sandpapper"},{de:"Feile",en:"File",sv:"Fil"},{de:"Klemme",en:"Clamp",sv:"Klämma"},
  // Maschinen
  {de:"Motor",en:"Engine",sv:"Motor"},{de:"Pumpe",en:"Pump",sv:"Pump"},{de:"Kompressor",en:"Compressor",sv:"Kompressor"},
  {de:"Generator",en:"Generator",sv:"Generator"},{de:"Kran",en:"Crane",sv:"Kran"},{de:"Bagger",en:"Excavator",sv:"Grävmaskin"},
  {de:"Gabelstapler",en:"Forklift",sv:"Gaffeltruck"},{de:"Fließband",en:"Conveyor belt",sv:"Löpande band"},{de:"Turbine",en:"Turbine",sv:"Turbin"},
  {de:"Getriebe",en:"Gearbox",sv:"Växellåda"},
  // Elektrogeräte
  {de:"Fernseher",en:"Television",sv:"Television"},{de:"Radio",en:"Radio",sv:"Radio"},{de:"Staubsauger",en:"Vacuum cleaner",sv:"Dammsugare"},
  {de:"Waschmaschine",en:"Washing machine",sv:"Tvättmaskin"},{de:"Trockner",en:"Dryer",sv:"Torktumlare"},{de:"Bügeleisen",en:"Iron",sv:"Strykjärn"},
  {de:"Haartrockner",en:"Hair dryer",sv:"Hårtork"},{de:"Toaster",en:"Toaster",sv:"Brödrost"},{de:"Kaffeemaschine",en:"Coffee maker",sv:"Kaffebryggare"},
  {de:"Mixer",en:"Mixer",sv:"Mixer"},{de:"Klimaanlage",en:"Air conditioner",sv:"Luftkonditionering"},{de:"Ventilator",en:"Fan",sv:"Fläkt"},
  // Möbel detailliert
  {de:"Garderobe",en:"Wardrobe",sv:"Garderob"},{de:"Nachtschrank",en:"Nightstand",sv:"Nattduksbord"},{de:"Bettsofa",en:"Sofa bed",sv:"Bäddsoffa"},
  {de:"Hocker",en:"Ottoman",sv:"Puff"},{de:"Bank",en:"Bench",sv:"Bänk"},{de:"Hängematte",en:"Hammock",sv:"Hängmatta"},
  {de:"Schaukelstuhl",en:"Rocking chair",sv:"Gungstol"},{de:"Vitrine",en:"Display cabinet",sv:"Vitrinskåp"},{de:"Kleiderhaken",en:"Coat hook",sv:"Klädhängare"},
  {de:"Wandregal",en:"Wall shelf",sv:"Vägghy lla"},
  // Textilien
  {de:"Baumwolle",en:"Cotton",sv:"Bomull"},{de:"Wolle",en:"Wool",sv:"Ull"},{de:"Seide",en:"Silk",sv:"Siden"},
  {de:"Leinen",en:"Linen",sv:"Lin"},{de:"Polyester",en:"Polyester",sv:"Polyester"},{de:"Leder",en:"Leather",sv:"Läder"},
  {de:"Samt",en:"Velvet",sv:"Sammet"},{de:"Denim",en:"Denim",sv:"Denim"},{de:"Satin",en:"Satin",sv:"Satin"},
  {de:"Nylon",en:"Nylon",sv:"Nylon"},
  // Schmuck
  {de:"Ring",en:"Ring",sv:"Ring"},{de:"Halskette",en:"Necklace",sv:"Halsband"},{de:"Ohrringe",en:"Earrings",sv:"Örhängen"},
  {de:"Armband",en:"Bracelet",sv:"Armband"},{de:"Uhr",en:"Watch",sv:"Klocka"},{de:"Brosche",en:"Brooch",sv:"Brosch"},
  {de:"Kette",en:"Chain",sv:"Kedja"},{de:"Diamant",en:"Diamond",sv:"Diamant"},{de:"Perle",en:"Pearl",sv:"Pärla"},
  {de:"Edelstein",en:"Gemstone",sv:"Ädelsten"},
  // Kosmetik
  {de:"Lippenstift",en:"Lipstick",sv:"Läppstift"},{de:"Mascara",en:"Mascara",sv:"Mascara"},{de:"Foundation",en:"Foundation",sv:"Foundation"},
  {de:"Lidschatten",en:"Eyeshadow",sv:"Ögonskugga"},{de:"Parfüm",en:"Perfume",sv:"Parfym"},{de:"Nagellack",en:"Nail polish",sv:"Nagellack"},
  {de:"Rouge",en:"Blush",sv:"Rouge"},{de:"Eyeliner",en:"Eyeliner",sv:"Eyeliner"},{de:"Concealer",en:"Concealer",sv:"Concealer"},
  {de:"Highlighter",en:"Highlighter",sv:"Highlighter"},
  // Hygiene
  {de:"Deodorant",en:"Deodorant",sv:"Deodorant"},{de:"Rasierschaum",en:"Shaving cream",sv:"Rakskum"},{de:"Wattestäbchen",en:"Cotton swab",sv:"Bomullspinne"},
  {de:"Zahnseide",en:"Dental floss",sv:"Tandtråd"},{de:"Mundwasser",en:"Mouthwash",sv:"Munskölj"},{de:"Sonnencreme",en:"Sunscreen",sv:"Solkräm"},
  {de:"Lotion",en:"Lotion",sv:"Lotion"},{de:"Verband",en:"Bandage",sv:"Förband"},{de:"Taschentücher",en:"Tissues",sv:"Näsdukar"},
  {de:"Feuchttücher",en:"Wet wipes",sv:"Våtservetter"},
  // Reinigung
  {de:"Besen",en:"Broom",sv:"Kvast"},{de:"Mopp",en:"Mop",sv:"Mopp"},{de:"Eimer",en:"Bucket",sv:"Hink"},
  {de:"Schwamm",en:"Sponge",sv:"Svamp"},{de:"Reinigungsmittel",en:"Detergent",sv:"Rengöringsmedel"},{de:"Bleichmittel",en:"Bleach",sv:"Blekmedel"},
  {de:"Kehrblech",en:"Dustpan",sv:"Skyffel"},{de:"Lappen",en:"Cloth",sv:"Trasa"},{de:"Mülltüte",en:"Trash bag",sv:"Soppåse"},
  {de:"Wischmopp",en:"Floor mop",sv:"Golvmopp"},
  // Garten
  {de:"Schaufel",en:"Shovel",sv:"Spade"},{de:"Rechen",en:"Rake",sv:"Kratta"},{de:"Gießkanne",en:"Watering can",sv:"Vattenkanna"},
  {de:"Rasenmäher",en:"Lawnmower",sv:"Gräsklippare"},{de:"Schlauch",en:"Hose",sv:"Slang"},{de:"Blumentopf",en:"Flower pot",sv:"Kruka"},
  {de:"Kompost",en:"Compost",sv:"Kompost"},{de:"Zaun",en:"Fence",sv:"Staket"},{de:"Hecke",en:"Hedge",sv:"Häck"},
  {de:"Saatgut",en:"Seeds",sv:"Utsäde"},
  // Camping
  {de:"Zelt",en:"Tent",sv:"Tält"},{de:"Schlafsack",en:"Sleeping bag",sv:"Sovsäck"},{de:"Lagerfeuer",en:"Campfire",sv:"Lägereld"},
  {de:"Taschenlampe",en:"Flashlight",sv:"Ficklampa"},{de:"Kompass",en:"Compass",sv:"Kompass"},{de:"Thermoskanne",en:"Thermos",sv:"Termos"},
  {de:"Campingkocher",en:"Camp stove",sv:"Campingkök"},{de:"Seil",en:"Rope",sv:"Rep"},{de:"Isomatte",en:"Sleeping mat",sv:"Liggunderlag"},
  {de:"Schweizer Messer",en:"Swiss army knife",sv:"Schweizisk armékniv"},
  // Angeln
  {de:"Angelrute",en:"Fishing rod",sv:"Fiskespö"},{de:"Angelhaken",en:"Fish hook",sv:"Fiskkrok"},{de:"Köder",en:"Bait",sv:"Bete"},
  {de:"Netz",en:"Net",sv:"Nät"},{de:"Angelrolle",en:"Fishing reel",sv:"Fiskerulle"},{de:"Angelleine",en:"Fishing line",sv:"Fiskelina"},
  {de:"Pose",en:"Float",sv:"Flöte"},{de:"Angelschein",en:"Fishing license",sv:"Fisketillstånd"},
  // Jagd
  {de:"Jagd",en:"Hunting",sv:"Jakt"},{de:"Gewehr",en:"Rifle",sv:"Gevär"},{de:"Pfeil",en:"Arrow",sv:"Pil"},
  {de:"Bogen",en:"Bow",sv:"Båge"},{de:"Falle",en:"Trap",sv:"Fälla"},{de:"Spur",en:"Track",sv:"Spår"},
  {de:"Lockruf",en:"Decoy",sv:"Lockbete"},{de:"Jagdhund",en:"Hunting dog",sv:"Jakthund"},
  // Fotografie
  {de:"Kamera",en:"Camera",sv:"Kamera"},{de:"Objektiv",en:"Lens",sv:"Lins"},{de:"Blitz",en:"Flash",sv:"Blixt"},
  {de:"Stativ",en:"Tripod",sv:"Stativ"},{de:"Belichtung",en:"Exposure",sv:"Exponering"},{de:"Fokus",en:"Focus",sv:"Fokus"},
  {de:"Verschluss",en:"Shutter",sv:"Slutare"},{de:"Auflösung",en:"Resolution",sv:"Upplösning"},{de:"Filter",en:"Filter",sv:"Filter"},
  {de:"Fotoalbum",en:"Photo album",sv:"Fotoalbum"},
  // Film
  {de:"Film",en:"Movie",sv:"Film"},{de:"Regisseur",en:"Director",sv:"Regissör"},{de:"Schauspieler",en:"Actor",sv:"Skådespelare"},
  {de:"Drehbuch",en:"Screenplay",sv:"Manus"},{de:"Szene",en:"Scene",sv:"Scen"},{de:"Zeichentrick",en:"Animation",sv:"Animationsfilm"},
  {de:"Dokumentarfilm",en:"Documentary",sv:"Dokumentär"},{de:"Soundtrack",en:"Soundtrack",sv:"Soundtrack"},{de:"Trailer",en:"Trailer",sv:"Trailer"},
  {de:"Premiere",en:"Premiere",sv:"Premiär"},
  // Theater
  {de:"Aufführung",en:"Performance",sv:"Föreställning"},{de:"Kostüm",en:"Costume",sv:"Kostym"},
  {de:"Bühnenbild",en:"Set design",sv:"Scenografi"},{de:"Publikum",en:"Audience",sv:"Publik"},
  {de:"Probe",en:"Rehearsal",sv:"Repetition"},{de:"Applaus",en:"Applause",sv:"Applåd"},
  // Zirkus
  {de:"Zirkus",en:"Circus",sv:"Cirkus"},{de:"Akrobat",en:"Acrobat",sv:"Akrobat"},{de:"Clown",en:"Clown",sv:"Clown"},
  {de:"Jongleur",en:"Juggler",sv:"Jonglör"},{de:"Trapez",en:"Trapeze",sv:"Trapets"},{de:"Zauberer",en:"Magician",sv:"Trollkonstnär"},
  {de:"Manege",en:"Ring",sv:"Manege"},{de:"Kunststück",en:"Trick",sv:"Konststycke"},
  // Sport detailliert
  {de:"Training",en:"Training",sv:"Träning"},{de:"Wettkampf",en:"Competition",sv:"Tävling"},{de:"Meister",en:"Champion",sv:"Mästare"},
  {de:"Medaille",en:"Medal",sv:"Medalj"},{de:"Rekord",en:"Record",sv:"Rekord"},{de:"Trainer",en:"Coach",sv:"Tränare"},
  {de:"Mannschaft",en:"Team",sv:"Lag"},{de:"Schiedsrichter",en:"Referee",sv:"Domare"},{de:"Strafe",en:"Penalty",sv:"Straff"},
  {de:"Stadion",en:"Stadium",sv:"Stadion"},
  // Olympia
  {de:"Olympische Spiele",en:"Olympic Games",sv:"Olympiska spelen"},{de:"Athlet",en:"Athlete",sv:"Idrottare"},{de:"Goldmedaille",en:"Gold medal",sv:"Guldmedalj"},
  {de:"Silbermedaille",en:"Silver medal",sv:"Silvermedalj"},{de:"Bronzemedaille",en:"Bronze medal",sv:"Bronsmedalj"},{de:"Marathon",en:"Marathon",sv:"Maraton"},
  {de:"Sprint",en:"Sprint",sv:"Sprint"},{de:"Staffel",en:"Relay",sv:"Stafett"},
  // Fußball
  {de:"Tor",en:"Goal",sv:"Mål"},{de:"Torwart",en:"Goalkeeper",sv:"Målvakt"},{de:"Abseits",en:"Offside",sv:"Offside"},
  {de:"Ecke",en:"Corner",sv:"Hörna"},{de:"Foul",en:"Foul",sv:"Foul"},{de:"Freistoß",en:"Free kick",sv:"Frispark"},
  {de:"Gelbe Karte",en:"Yellow card",sv:"Gult kort"},{de:"Rote Karte",en:"Red card",sv:"Rött kort"},{de:"Hattrick",en:"Hat trick",sv:"Hat-trick"},
  {de:"Elfmeter",en:"Penalty kick",sv:"Straffkick"},
  // Tennis
  {de:"Schläger",en:"Racket",sv:"Racket"},{de:"Tennisball",en:"Tennis ball",sv:"Tennisboll"},{de:"Tennisplatz",en:"Court",sv:"Tennisbana"},
  {de:"Satz",en:"Set",sv:"Set"},{de:"Aufschlag",en:"Service",sv:"Serve"},
  {de:"Ass",en:"Ace",sv:"Äss"},{de:"Volley",en:"Volley",sv:"Volley"},
  // Schwimmen
  {de:"Brustschwimmen",en:"Breaststroke",sv:"Bröstsim"},{de:"Rückenschwimmen",en:"Backstroke",sv:"Ryggsim"},
  {de:"Freistil",en:"Freestyle",sv:"Crawl"},{de:"Schwimmbahn",en:"Lane",sv:"Simningsbana"},{de:"Schwimmbrille",en:"Goggles",sv:"Simglasögon"},
  {de:"Badeanzug",en:"Swimsuit",sv:"Baddräkt"},{de:"Schwimmflossen",en:"Flippers",sv:"Simfötter"},
  // Leichtathletik
  {de:"Weitsprung",en:"Long jump",sv:"Längdhopp"},{de:"Hochsprung",en:"High jump",sv:"Höjdhopp"},{de:"Kugelstoßen",en:"Shot put",sv:"Kulstötning"},
  {de:"Diskuswurf",en:"Discus",sv:"Diskuskastning"},{de:"Speerwerfen",en:"Javelin",sv:"Spjutkastning"},{de:"Stabhochsprung",en:"Pole vault",sv:"Stavhopp"},
  {de:"Hürdenlauf",en:"Hurdles",sv:"Häcklöpning"},{de:"Zehnkampf",en:"Decathlon",sv:"Tiokamp"},
  // Kampfsport
  {de:"Karate",en:"Karate",sv:"Karate"},{de:"Judo",en:"Judo",sv:"Judo"},{de:"Ringen",en:"Wrestling",sv:"Brottning"},
  {de:"Kick",en:"Kick",sv:"Spark"},{de:"Schlag",en:"Punch",sv:"Slag"},
  {de:"Dojo",en:"Dojo",sv:"Dojo"},{de:"Taekwondo",en:"Taekwondo",sv:"Taekwondo"},
  // Wintersport
  {de:"Ski",en:"Ski",sv:"Skida"},{de:"Snowboard",en:"Snowboard",sv:"Snowboard"},{de:"Schlittschuhlaufen",en:"Ice skating",sv:"Skridskoåkning"},
  {de:"Schlitten",en:"Sledge",sv:"Kälke"},{de:"Curling",en:"Curling",sv:"Curling"},{de:"Biathlon",en:"Biathlon",sv:"Skidskytte"},
  {de:"Skispringen",en:"Ski jumping",sv:"Backhoppning"},{de:"Langlauf",en:"Cross-country skiing",sv:"Längdskidåkning"},
  // Wassersport
  {de:"Surfen",en:"Surfing",sv:"Surfning"},{de:"Segeln",en:"Sailing",sv:"Segling"},{de:"Rudern",en:"Rowing",sv:"Rodd"},
  {de:"Kajak",en:"Kayak",sv:"Kajak"},{de:"Tauchen",en:"Diving",sv:"Dykning"},{de:"Schnorcheln",en:"Snorkeling",sv:"Snorkling"},
  {de:"Windsurfen",en:"Windsurfing",sv:"Vindsurfing"},{de:"Wasserball",en:"Water polo",sv:"Vattenpolo"},
  // Reiten
  {de:"Sattel",en:"Saddle",sv:"Sadel"},{de:"Zaumzeug",en:"Bridle",sv:"Betsel"},{de:"Steigbügel",en:"Stirrup",sv:"Stigbygel"},
  {de:"Kanter",en:"Canter",sv:"Kanter"},{de:"Galopp",en:"Gallop",sv:"Galopp"},{de:"Trab",en:"Trot",sv:"Trav"},
  {de:"Sprung",en:"Jump",sv:"Hopp"},{de:"Reitplatz",en:"Riding arena",sv:"Ridbana"},
  // Golf
  {de:"Golfschläger",en:"Golf club",sv:"Golfklubba"},{de:"Golfball",en:"Golf ball",sv:"Golfboll"},{de:"Loch",en:"Hole",sv:"Hål"},
  {de:"Green",en:"Green",sv:"Green"},{de:"Fairway",en:"Fairway",sv:"Fairway"},{de:"Caddie",en:"Caddy",sv:"Caddie"},
  {de:"Par",en:"Par",sv:"Par"},{de:"Birdie",en:"Birdie",sv:"Birdie"},
  // Formen
  {de:"Kreis",en:"Circle",sv:"Cirkel"},{de:"Quadrat",en:"Square",sv:"Kvadrat"},{de:"Dreieck",en:"Triangle",sv:"Triangel"},
  {de:"Rechteck",en:"Rectangle",sv:"Rektangel"},{de:"Oval",en:"Oval",sv:"Oval"},
  {de:"Herzform",en:"Heart shape",sv:"Hjärtform"},{de:"Würfel",en:"Cube",sv:"Kub"},{de:"Kugel",en:"Sphere",sv:"Sfär"},
  {de:"Kegel",en:"Cone",sv:"Kon"},{de:"Zylinder",en:"Cylinder",sv:"Cylinder"},{de:"Pyramide",en:"Pyramid",sv:"Pyramid"},
  {de:"Raute",en:"Diamond shape",sv:"Romb"},{de:"Spirale",en:"Spiral",sv:"Spiral"},{de:"Linie",en:"Line",sv:"Linje"},
  // Präpositionen
  {de:"in",en:"in",sv:"i"},{de:"auf",en:"on",sv:"på"},{de:"unter",en:"under",sv:"under"},
  {de:"über",en:"above",sv:"över"},{de:"neben",en:"next to",sv:"bredvid"},{de:"vor",en:"in front of",sv:"framför"},
  {de:"hinter",en:"behind",sv:"bakom"},{de:"zwischen",en:"between",sv:"mellan"},{de:"durch",en:"through",sv:"genom"},
  {de:"mit",en:"with",sv:"med"},{de:"ohne",en:"without",sv:"utan"},{de:"für",en:"for",sv:"för"},
  {de:"gegen",en:"against",sv:"mot"},{de:"um",en:"around",sv:"runt"},{de:"bei",en:"near",sv:"hos/vid"},
  {de:"seit",en:"since",sv:"sedan"},{de:"bis",en:"until",sv:"till"},{de:"nach",en:"after/to",sv:"efter/till"},
  {de:"von",en:"from",sv:"från"},{de:"zu",en:"to",sv:"till"},
  // Pronomen
  {de:"ich",en:"I",sv:"jag"},{de:"du",en:"you",sv:"du"},{de:"er",en:"he",sv:"han"},
  {de:"sie",en:"she",sv:"hon"},{de:"wir",en:"we",sv:"vi"},{de:"ihr",en:"you (plural)",sv:"ni"},
  {de:"sie (pl.)",en:"they",sv:"de"},{de:"mein",en:"my",sv:"min"},{de:"dein",en:"your",sv:"din"},
  {de:"sein",en:"his",sv:"hans"},{de:"ihr (poss.)",en:"her",sv:"hennes"},{de:"unser",en:"our",sv:"vår"},
  {de:"euer",en:"your (pl.)",sv:"er"},{de:"dieser",en:"this",sv:"denna/det här"},{de:"jener",en:"that",sv:"den/det"},
  // Konjunktionen
  {de:"und",en:"and",sv:"och"},{de:"oder",en:"or",sv:"eller"},{de:"aber",en:"but",sv:"men"},
  {de:"weil",en:"because",sv:"eftersom"},{de:"wenn",en:"if/when",sv:"om/när"},{de:"dass",en:"that",sv:"att"},
  {de:"obwohl",en:"although",sv:"även om"},{de:"damit",en:"so that",sv:"för att"},{de:"während",en:"while",sv:"medan"},
  {de:"bevor",en:"before",sv:"innan"},{de:"nachdem",en:"after",sv:"efter att"},{de:"sowohl als auch",en:"both and",sv:"både och"},
  {de:"entweder oder",en:"either or",sv:"antingen eller"},{de:"weder noch",en:"neither nor",sv:"varken eller"},{de:"trotzdem",en:"nevertheless",sv:"ändå"},
  // Weitere Adjektive
  {de:"breit",en:"wide",sv:"bred"},{de:"eng",en:"narrow",sv:"smal"},{de:"tief",en:"deep",sv:"djup"},
  {de:"flach",en:"flat",sv:"platt"},{de:"spitz",en:"pointed",sv:"spetsig"},{de:"stumpf",en:"blunt",sv:"trubbig"},
  {de:"weich",en:"soft",sv:"mjuk"},{de:"hart",en:"hard",sv:"hård"},{de:"glatt",en:"smooth",sv:"slät"},
  {de:"rau",en:"rough",sv:"grov"},{de:"dünn",en:"thin",sv:"tunn"},{de:"dick",en:"thick",sv:"tjock"},
  {de:"hoch",en:"high/tall",sv:"hög"},{de:"niedrig",en:"low",sv:"låg"},{de:"jung",en:"young",sv:"ung"},
  {de:"reif",en:"mature",sv:"mogen"},{de:"klug",en:"clever",sv:"klok"},{de:"dumm",en:"stupid",sv:"dum"},
  {de:"lustig",en:"funny",sv:"rolig"},{de:"langweilig",en:"boring",sv:"tråkig"},{de:"interessant",en:"interesting",sv:"intressant"},
  {de:"schwierig",en:"difficult",sv:"svår"},{de:"einfach",en:"simple",sv:"enkel"},{de:"möglich",en:"possible",sv:"möjlig"},
  {de:"unmöglich",en:"impossible",sv:"omöjlig"},{de:"notwendig",en:"necessary",sv:"nödvändig"},{de:"genug",en:"enough",sv:"tillräcklig"},
  {de:"ähnlich",en:"similar",sv:"liknande"},{de:"verschieden",en:"different",sv:"olika"},{de:"gleich",en:"same",sv:"samma"},
  {de:"freundlich",en:"friendly",sv:"vänlig"},{de:"höflich",en:"polite",sv:"artig"},{de:"grob",en:"rude",sv:"ohövlig"},
  {de:"ehrlich",en:"honest",sv:"ärlig"},{de:"faul",en:"lazy",sv:"lat"},{de:"fleißig",en:"hardworking",sv:"flitig"},
  {de:"mutig",en:"brave",sv:"modig"},{de:"feige",en:"cowardly",sv:"feg"},{de:"großzügig",en:"generous",sv:"generös"},
  {de:"geizig",en:"stingy",sv:"snål"},{de:"gesund",en:"healthy",sv:"frisk"},{de:"krank",en:"ill",sv:"sjuk"},
  // Weitere Verben
  {de:"beginnen",en:"to begin",sv:"att börja"},{de:"enden",en:"to end",sv:"att sluta"},{de:"warten",en:"to wait",sv:"att vänta"},
  {de:"zeigen",en:"to show",sv:"att visa"},{de:"bezahlen",en:"to pay",sv:"att betala"},
  {de:"waschen",en:"to wash",sv:"att tvätta"},{de:"putzen",en:"to clean",sv:"att städa"},
  {de:"bauen",en:"to build",sv:"att bygga"},{de:"reparieren",en:"to repair",sv:"att reparera"},{de:"brechen",en:"to break",sv:"att bryta"},
  {de:"wählen",en:"to choose",sv:"att välja"},{de:"erklären",en:"to explain",sv:"att förklara"},{de:"verstehen",en:"to understand",sv:"att förstå"},
  {de:"vergessen",en:"to forget",sv:"att glömma"},{de:"erinnern",en:"to remember",sv:"att komma ihåg"},{de:"träumen",en:"to dream",sv:"att drömma"},
  {de:"lächeln",en:"to smile",sv:"att le"},{de:"lachen",en:"to laugh",sv:"att skratta"},{de:"weinen",en:"to cry",sv:"att gråta"},
  {de:"schreien",en:"to scream",sv:"att skrika"},{de:"flüstern",en:"to whisper",sv:"att viska"},
  {de:"springen",en:"to jump",sv:"att hoppa"},{de:"fallen",en:"to fall",sv:"att falla"},
  {de:"steigen",en:"to climb",sv:"att klättra"},{de:"fahren",en:"to drive",sv:"att köra"},
  {de:"fliegen",en:"to fly",sv:"att flyga"},{de:"schicken",en:"to send",sv:"att skicka"},{de:"empfangen",en:"to receive",sv:"att ta emot"},
  {de:"teilen",en:"to share",sv:"att dela"},{de:"benutzen",en:"to use",sv:"att använda"},
  {de:"ändern",en:"to change",sv:"att ändra"},{de:"versuchen",en:"to try",sv:"att försöka"},{de:"gewinnen",en:"to win",sv:"att vinna"},
  {de:"verlassen",en:"to leave",sv:"att lämna"},{de:"ankommen",en:"to arrive",sv:"att anlända"},
  // Berufe erweitert
  {de:"Zahnarzt",en:"Dentist",sv:"Tandläkare"},{de:"Tierarzt",en:"Veterinarian",sv:"Veterinär"},{de:"Apotheker",en:"Pharmacist",sv:"Apotekare"},
  {de:"Psychologe",en:"Psychologist",sv:"Psykolog"},{de:"Physiker",en:"Physicist",sv:"Fysiker"},{de:"Biologe",en:"Biologist",sv:"Biolog"},
  {de:"Chemiker",en:"Chemist",sv:"Kemist"},{de:"Mathematiker",en:"Mathematician",sv:"Matematiker"},{de:"Astronom",en:"Astronomer",sv:"Astronom"},
  {de:"Historiker",en:"Historian",sv:"Historiker"},{de:"Bibliothekar",en:"Librarian",sv:"Bibliotekarie"},{de:"Übersetzer",en:"Translator",sv:"Översättare"},
  {de:"Dolmetscher",en:"Interpreter",sv:"Tolk"},{de:"Schriftsteller",en:"Writer",sv:"Skribent"},{de:"Designer",en:"Designer",sv:"Designer"},
  {de:"Fotograf",en:"Photographer",sv:"Fotograf"},{de:"Elektriker",en:"Electrician",sv:"Elektriker"},{de:"Klempner",en:"Plumber",sv:"Rörmokare"},
  {de:"Gärtner",en:"Gardener",sv:"Trädgårdsmästare"},{de:"Taxifahrer",en:"Taxi driver",sv:"Taxichaufför"},
  {de:"Matrose",en:"Sailor",sv:"Matros"},{de:"Soldat",en:"Soldier",sv:"Soldat"},
  {de:"Politiker",en:"Politician",sv:"Politiker"},
  // Sportausrüstung
  {de:"Ball",en:"Ball",sv:"Boll"},
  {de:"Helm",en:"Helmet",sv:"Hjälm"},{de:"Schutzausrüstung",en:"Protective gear",sv:"Skyddsutrustning"},
  {de:"Trikot",en:"Jersey",sv:"Tröja"},
  {de:"Schienen",en:"Shin guards",sv:"Benskydd"},{de:"Sprungmatte",en:"Trampoline",sv:"Studsmatta"},{de:"Gewichte",en:"Weights",sv:"Vikter"},
  {de:"Springseile",en:"Jump rope",sv:"Hopprep"},{de:"Hanteln",en:"Dumbbells",sv:"Hantlar"},{de:"Matte",en:"Mat",sv:"Matta"},
  {de:"Puck",en:"Puck",sv:"Puck"},{de:"Frisbee",en:"Frisbee",sv:"Frisbee"},
  {de:"Pfeil und Bogen",en:"Bow and arrow",sv:"Pilbåge"},{de:"Stopwatch",en:"Stopwatch",sv:"Stoppur"},
  // Körper erweitert
  {de:"Stirn",en:"Forehead",sv:"Panna"},{de:"Wange",en:"Cheek",sv:"Kind"},{de:"Kinn",en:"Chin",sv:"Haka"},
  {de:"Lippen",en:"Lips",sv:"Läppar"},{de:"Zunge",en:"Tongue",sv:"Tunga"},
  {de:"Nacken",en:"Nape",sv:"Nacke"},{de:"Brust",en:"Chest",sv:"Bröst"},{de:"Rippe",en:"Rib",sv:"Revben"},
  {de:"Hüfte",en:"Hip",sv:"Höft"},{de:"Oberschenkel",en:"Thigh",sv:"Lår"},{de:"Wade",en:"Calf",sv:"Vad"},
  {de:"Knöchel",en:"Ankle",sv:"Fotled"},{de:"Ferse",en:"Heel",sv:"Häl"},{de:"Daumen",en:"Thumb",sv:"Tumme"},
  {de:"Nagel",en:"Nail",sv:"Nagel"},{de:"Gelenk",en:"Joint",sv:"Led"},{de:"Ader",en:"Vein",sv:"Åder"},
  {de:"Knochen",en:"Bone",sv:"Ben"},{de:"Gehirn",en:"Brain",sv:"Hjärna"},
  // Gesundheit & Wohlbefinden
  {de:"Arzttermin",en:"Doctor's appointment",sv:"Läkarbesök"},{de:"Krankenversicherung",en:"Health insurance",sv:"Sjukförsäkring"},{de:"Erste Hilfe",en:"First aid",sv:"Första hjälpen"},
  {de:"Blutgruppe",en:"Blood type",sv:"Blodgrupp"},{de:"Puls",en:"Pulse",sv:"Puls"},{de:"Körpergewicht",en:"Body weight",sv:"Kroppsvikt"},
  {de:"Körpergröße",en:"Height",sv:"Längd"},{de:"Schlaf",en:"Sleep",sv:"Sömn"},{de:"Ernährung",en:"Nutrition",sv:"Näring"},
  {de:"Bewegung",en:"Exercise",sv:"Motion"},{de:"Stress",en:"Stress",sv:"Stress"},{de:"Erholung",en:"Recovery",sv:"Återhämtning"},
  {de:"Physiotherapie",en:"Physiotherapy",sv:"Fysioterapi"},{de:"Ambulanz",en:"Ambulance",sv:"Ambulans"},
  {de:"Notarzt",en:"Emergency doctor",sv:"Jourhavande läkare"},{de:"Krankenakte",en:"Medical record",sv:"Journal"},{de:"Symptom",en:"Symptom",sv:"Symptom"},
  {de:"Untersuchung",en:"Examination",sv:"Undersökning"},{de:"Heilung",en:"Healing",sv:"Läkning"},
  // Soziale Ausdrücke
  {de:"Hallo",en:"Hello",sv:"Hej"},{de:"Auf Wiedersehen",en:"Goodbye",sv:"Hejdå"},{de:"Danke",en:"Thank you",sv:"Tack"},
  {de:"Bitte",en:"Please",sv:"Snälla/Var god"},{de:"Entschuldigung",en:"Excuse me",sv:"Ursäkta"},{de:"Es tut mir leid",en:"I am sorry",sv:"Förlåt"},
  {de:"Wie geht es dir",en:"How are you",sv:"Hur mår du"},{de:"Gut",en:"Good",sv:"Bra"},{de:"Schlecht",en:"Bad",sv:"Dåligt"},
  {de:"Ja",en:"Yes",sv:"Ja"},{de:"Nein",en:"No",sv:"Nej"},{de:"Vielleicht",en:"Maybe",sv:"Kanske"},
  {de:"Natürlich",en:"Of course",sv:"Självklart"},{de:"Genau",en:"Exactly",sv:"Precis"},{de:"Ich verstehe nicht",en:"I don't understand",sv:"Jag förstår inte"},
  {de:"Sprechen Sie Englisch",en:"Do you speak English",sv:"Talar du engelska"},{de:"Hilfe",en:"Help",sv:"Hjälp"},{de:"Prost",en:"Cheers",sv:"Skål"},
  {de:"Herzlichen Glückwunsch",en:"Congratulations",sv:"Grattis"},{de:"Gute Nacht",en:"Good night",sv:"God natt"},
  // Zeit & Datum
  {de:"Minute",en:"Minute",sv:"Minut"},{de:"Stunde",en:"Hour",sv:"Timme"},{de:"Tag",en:"Day",sv:"Dag"},
  {de:"Woche",en:"Week",sv:"Vecka"},{de:"Monat",en:"Month",sv:"Månad"},{de:"Jahr",en:"Year",sv:"År"},
  {de:"Jahrzehnt",en:"Decade",sv:"Decennium"},{de:"Jahrhundert",en:"Century",sv:"Sekel"},{de:"Jahrtausend",en:"Millennium",sv:"Millennium"},
  {de:"Sekunde",en:"Second",sv:"Sekund"},{de:"Uhrzeit",en:"Time",sv:"Tid"},{de:"Datum",en:"Date",sv:"Datum"},
  {de:"Feiertag",en:"Holiday",sv:"Helgdag"},{de:"Geburtstag",en:"Birthday",sv:"Födelsedag"},{de:"Jubiläum",en:"Anniversary",sv:"Jubileum"},
  {de:"Weihnachten",en:"Christmas",sv:"Jul"},{de:"Ostern",en:"Easter",sv:"Påsk"},{de:"Silvester",en:"New Year's Eve",sv:"Nyårsafton"},
  {de:"morgens",en:"in the morning",sv:"på morgonen"},{de:"mittags",en:"at noon",sv:"vid lunchtid"},
  {de:"abends",en:"in the evening",sv:"på kvällen"},{de:"nachts",en:"at night",sv:"på natten"},{de:"Mitternacht",en:"Midnight",sv:"Midnatt"},
  {de:"Sonnenaufgang",en:"Sunrise",sv:"Soluppgång"},{de:"Sonnenuntergang",en:"Sunset",sv:"Solnedgång"},
  // Richtungen & Position
  {de:"links",en:"left",sv:"vänster"},{de:"rechts",en:"right",sv:"höger"},{de:"geradeaus",en:"straight ahead",sv:"rakt fram"},
  {de:"oben",en:"above",sv:"uppe"},{de:"unten",en:"below",sv:"nere"},{de:"vorne",en:"in front",sv:"framtill"},
  {de:"hinten",en:"behind",sv:"baktill"},{de:"innen",en:"inside",sv:"inuti"},{de:"außen",en:"outside",sv:"utanför"},
  {de:"Norden",en:"North",sv:"Norr"},{de:"Süden",en:"South",sv:"Söder"},{de:"Osten",en:"East",sv:"Öster"},
  {de:"Westen",en:"West",sv:"Väster"},{de:"Mitte",en:"Middle",sv:"Mitten"},
  {de:"nah",en:"near",sv:"nära"},{de:"weit",en:"far",sv:"långt"},{de:"hier",en:"here",sv:"här"},
  {de:"dort",en:"there",sv:"där"},{de:"überall",en:"everywhere",sv:"överallt"},
  // Maße & Gewichte
  {de:"Meter",en:"Meter",sv:"Meter"},{de:"Kilometer",en:"Kilometer",sv:"Kilometer"},{de:"Zentimeter",en:"Centimeter",sv:"Centimeter"},
  {de:"Millimeter",en:"Millimeter",sv:"Millimeter"},{de:"Kilogramm",en:"Kilogram",sv:"Kilogram"},{de:"Gramm",en:"Gram",sv:"Gram"},
  {de:"Tonne",en:"Ton",sv:"Ton"},{de:"Liter",en:"Liter",sv:"Liter"},{de:"Milliliter",en:"Milliliter",sv:"Milliliter"},
  {de:"Grad",en:"Degree",sv:"Grad"},{de:"Fläche",en:"Area",sv:"Yta"},{de:"Volumen",en:"Volume",sv:"Volym"},
  {de:"Geschwindigkeit",en:"Speed",sv:"Hastighet"},{de:"Temperatur",en:"Temperature",sv:"Temperatur"},{de:"Gewicht",en:"Weight",sv:"Vikt"},
  // Materialien
  {de:"Holz",en:"Wood",sv:"Trä"},{de:"Metall",en:"Metal",sv:"Metall"},{de:"Kunststoff",en:"Plastic",sv:"Plast"},
  {de:"Ton",en:"Clay",sv:"Lera"},
  {de:"Sand",en:"Sand",sv:"Sand"},{de:"Papier",en:"Paper",sv:"Papper"},{de:"Karton",en:"Cardboard",sv:"Kartong"},
  {de:"Gummi",en:"Rubber",sv:"Gummi"},{de:"Keramik",en:"Ceramic",sv:"Keramik"},{de:"Marmor",en:"Marble",sv:"Marmor"},
  {de:"Bronze",en:"Bronze",sv:"Brons"},{de:"Kupfer",en:"Copper",sv:"Koppar"},{de:"Eisen",en:"Iron",sv:"Järn"},
  {de:"Aluminium",en:"Aluminum",sv:"Aluminium"},{de:"Silizium",en:"Silicon",sv:"Kisel"},{de:"Kohle",en:"Coal",sv:"Kol"},
  {de:"Gas",en:"Gas",sv:"Gas"},
  // Gefühle erweitert
  {de:"Freude",en:"Joy",sv:"Glädje"},{de:"Trauer",en:"Grief",sv:"Sorg"},{de:"Wut",en:"Rage",sv:"Raseri"},
  {de:"Liebe",en:"Love",sv:"Kärlek"},{de:"Hass",en:"Hate",sv:"Hat"},
  {de:"Hoffnung",en:"Hope",sv:"Hopp"},{de:"Verzweiflung",en:"Despair",sv:"Förtvivlan"},{de:"Überraschung",en:"Surprise",sv:"Överraskning"},
  {de:"Enttäuschung",en:"Disappointment",sv:"Besvikelse"},{de:"Scham",en:"Shame",sv:"Skam"},{de:"Schuld",en:"Guilt",sv:"Skuld"},
  {de:"Eifersucht",en:"Jealousy",sv:"Avundsjuka"},{de:"Neid",en:"Envy",sv:"Avund"},{de:"Begeisterung",en:"Enthusiasm",sv:"Entusiasm"},
  {de:"Geduld",en:"Patience",sv:"Tålamod"},{de:"Ungeduld",en:"Impatience",sv:"Otålighet"},{de:"Neugierde",en:"Curiosity",sv:"Nyfikenhet"},
  {de:"Vertrauen",en:"Trust",sv:"Förtroende"},{de:"Misstrauen",en:"Distrust",sv:"Misstro"},
  // Abstraktbegriffe
  {de:"Idee",en:"Idea",sv:"Idé"},{de:"Konzept",en:"Concept",sv:"Koncept"},{de:"Theorie",en:"Theory",sv:"Teori"},
  {de:"Praxis",en:"Practice",sv:"Praktik"},{de:"Bedeutung",en:"Meaning",sv:"Betydelse"},
  {de:"Ziel",en:"Goal",sv:"Mål"},{de:"Zweck",en:"Purpose",sv:"Syfte"},{de:"Ergebnis",en:"Result",sv:"Resultat"},
  {de:"Grund",en:"Reason",sv:"Orsak"},{de:"Ursache",en:"Cause",sv:"Orsak"},{de:"Wirkung",en:"Effect",sv:"Effekt"},
  {de:"Regel",en:"Rule",sv:"Regel"},{de:"Ausnahme",en:"Exception",sv:"Undantag"},{de:"Beispiel",en:"Example",sv:"Exempel"},
  {de:"Problem",en:"Problem",sv:"Problem"},{de:"Lösung",en:"Solution",sv:"Lösning"},{de:"Frage",en:"Question",sv:"Fråga"},
  {de:"Antwort",en:"Answer",sv:"Svar"},{de:"Meinung",en:"Opinion",sv:"Åsikt"},
  // Nationalitäten
  {de:"deutsch",en:"German",sv:"tysk"},{de:"schwedisch",en:"Swedish",sv:"svensk"},{de:"englisch",en:"English",sv:"engelsk"},
  {de:"französisch",en:"French",sv:"fransk"},{de:"spanisch",en:"Spanish",sv:"spansk"},{de:"italienisch",en:"Italian",sv:"italiensk"},
  {de:"amerikanisch",en:"American",sv:"amerikansk"},{de:"chinesisch",en:"Chinese",sv:"kinesisk"},{de:"japanisch",en:"Japanese",sv:"japansk"},
  {de:"russisch",en:"Russian",sv:"rysk"},{de:"portugiesisch",en:"Portuguese",sv:"portugisisk"},{de:"arabisch",en:"Arabic",sv:"arabisk"},
  {de:"türkisch",en:"Turkish",sv:"turkisk"},{de:"polnisch",en:"Polish",sv:"polsk"},{de:"niederländisch",en:"Dutch",sv:"nederländsk"},
  {de:"norwegisch",en:"Norwegian",sv:"norsk"},{de:"dänisch",en:"Danish",sv:"dansk"},{de:"finnisch",en:"Finnish",sv:"finsk"},
  {de:"griechisch",en:"Greek",sv:"grekisk"},{de:"brasilianisch",en:"Brazilian",sv:"brasiliansk"},
  // Weitere Länder
  {de:"Mexiko",en:"Mexico",sv:"Mexiko"},{de:"Argentinien",en:"Argentina",sv:"Argentina"},{de:"Indien",en:"India",sv:"Indien"},
  {de:"Südafrika",en:"South Africa",sv:"Sydafrika"},{de:"Nigeria",en:"Nigeria",sv:"Nigeria"},{de:"Ägypten",en:"Egypt",sv:"Egypten"},
  {de:"Marokko",en:"Morocco",sv:"Marocko"},{de:"Türkei",en:"Turkey",sv:"Turkiet"},{de:"Südkorea",en:"South Korea",sv:"Sydkorea"},
  {de:"Thailand",en:"Thailand",sv:"Thailand"},{de:"Vietnam",en:"Vietnam",sv:"Vietnam"},{de:"Indonesien",en:"Indonesia",sv:"Indonesien"},
  {de:"Neuseeland",en:"New Zealand",sv:"Nya Zeeland"},{de:"Israel",en:"Israel",sv:"Israel"},{de:"Saudi-Arabien",en:"Saudi Arabia",sv:"Saudiarabien"},
  {de:"Belgien",en:"Belgium",sv:"Belgien"},{de:"Tschechien",en:"Czech Republic",sv:"Tjeckien"},{de:"Ungarn",en:"Hungary",sv:"Ungern"},
  {de:"Rumänien",en:"Romania",sv:"Rumänien"},{de:"Ukraine",en:"Ukraine",sv:"Ukraina"},
  // Stadtleben
  {de:"Fußgängerzone",en:"Pedestrian zone",sv:"Gångfartszon"},{de:"Ampel",en:"Traffic light",sv:"Trafikljus"},{de:"Kreuzung",en:"Intersection",sv:"Korsning"},
  {de:"Brücke",en:"Bridge",sv:"Bro"},{de:"Tunnel",en:"Tunnel",sv:"Tunnel"},{de:"Parkhaus",en:"Parking garage",sv:"Parkeringshus"},
  {de:"Bushaltestelle",en:"Bus stop",sv:"Busshållplats"},{de:"Zebrastreifen",en:"Crosswalk",sv:"Övergångsställe"},{de:"Bürgersteig",en:"Sidewalk",sv:"Trottoar"},
  {de:"Laterne",en:"Street lamp",sv:"Gatlykta"},{de:"Briefkasten",en:"Mailbox",sv:"Brevlåda"},{de:"Schaufenster",en:"Shop window",sv:"Skyltfönster"},
  {de:"Werbung",en:"Advertisement",sv:"Reklam"},{de:"Plakat",en:"Poster",sv:"Affisch"},
  {de:"Brunnen",en:"Fountain",sv:"Fontän"},{de:"Spielplatz",en:"Playground",sv:"Lekplats"},{de:"Sportplatz",en:"Sports ground",sv:"Idrottsplats"},
  {de:"Einkaufszentrum",en:"Shopping center",sv:"Köpcentrum"},{de:"Marktplatz",en:"Market square",sv:"Torg"},
  // Sprache & Kommunikation
  {de:"Sprache",en:"Language",sv:"Språk"},{de:"Wort",en:"Word",sv:"Ord"},
  {de:"Grammatik",en:"Grammar",sv:"Grammatik"},{de:"Vokabular",en:"Vocabulary",sv:"Ordförråd"},{de:"Aussprache",en:"Pronunciation",sv:"Uttal"},
  {de:"Akzent",en:"Accent",sv:"Accent"},{de:"Dialekt",en:"Dialect",sv:"Dialekt"},{de:"Übersetzung",en:"Translation",sv:"Översättning"},
  {de:"Alphabet",en:"Alphabet",sv:"Alfabet"},{de:"Buchstabe",en:"Letter",sv:"Bokstav"},{de:"Silbe",en:"Syllable",sv:"Stavelse"},
  {de:"Konsonant",en:"Consonant",sv:"Konsonant"},{de:"Vokal",en:"Vowel",sv:"Vokal"},{de:"Substantiv",en:"Noun",sv:"Substantiv"},
  {de:"Verb",en:"Verb",sv:"Verb"},{de:"Adjektiv",en:"Adjective",sv:"Adjektiv"},{de:"Adverb",en:"Adverb",sv:"Adverb"},
  {de:"Zeichen",en:"Sign",sv:"Tecken"},{de:"Symbol",en:"Symbol",sv:"Symbol"},
  // Musik erweitert
  {de:"Oper",en:"Opera",sv:"Opera"},{de:"Jazz",en:"Jazz",sv:"Jazz"},
  {de:"Pop",en:"Pop",sv:"Pop"},{de:"Klassik",en:"Classical",sv:"Klassisk"},{de:"Hip-Hop",en:"Hip-hop",sv:"Hip-hop"},
  {de:"Reggae",en:"Reggae",sv:"Reggae"},{de:"Blues",en:"Blues",sv:"Blues"},{de:"Folk",en:"Folk",sv:"Folk"},
  {de:"Noten",en:"Sheet music",sv:"Noter"},{de:"Taktart",en:"Time signature",sv:"Taktart"},{de:"Dur",en:"Major",sv:"Dur"},
  {de:"Moll",en:"Minor",sv:"Moll"},{de:"Improvisation",en:"Improvisation",sv:"Improvisation"},
  // Kochen & Küche
  {de:"schneiden",en:"to cut",sv:"att skära"},{de:"braten",en:"to fry",sv:"att steka"},
  {de:"mischen",en:"to mix",sv:"att blanda"},{de:"rühren",en:"to stir",sv:"att röra"},
  {de:"marinieren",en:"to marinate",sv:"att marinera"},{de:"würzen",en:"to season",sv:"att krydda"},{de:"abschmecken",en:"to taste",sv:"att smaka"},
  {de:"servieren",en:"to serve",sv:"att servera"},{de:"erhitzen",en:"to heat",sv:"att värma"},{de:"abkühlen",en:"to cool",sv:"att kyla"},
  {de:"schälen",en:"to peel",sv:"att skala"},{de:"reiben",en:"to grate",sv:"att riva"},{de:"kneten",en:"to knead",sv:"att knåda"},
  // Wissenschaft erweitert
  {de:"Hypothese",en:"Hypothesis",sv:"Hypotes"},{de:"Beweis",en:"Proof",sv:"Bevis"},
  {de:"Forschung",en:"Research",sv:"Forskning"},{de:"Entdeckung",en:"Discovery",sv:"Upptäckt"},{de:"Erfindung",en:"Invention",sv:"Uppfinning"},
  {de:"Methode",en:"Method",sv:"Metod"},{de:"Messung",en:"Measurement",sv:"Mätning"},
  {de:"Analyse",en:"Analysis",sv:"Analys"},{de:"Synthese",en:"Synthesis",sv:"Syntes"},{de:"Reaktion",en:"Reaction",sv:"Reaktion"},
  {de:"Magnetismus",en:"Magnetism",sv:"Magnetism"},{de:"Gravitation",en:"Gravity",sv:"Gravitation"},{de:"Strahlung",en:"Radiation",sv:"Strålning"},
  // Astronomie
  {de:"Planet",en:"Planet",sv:"Planet"},
  {de:"Galaxie",en:"Galaxy",sv:"Galax"},{de:"Universum",en:"Universe",sv:"Universum"},
  {de:"Komet",en:"Comet",sv:"Komet"},{de:"Asteroid",en:"Asteroid",sv:"Asteroid"},{de:"Meteor",en:"Meteor",sv:"Meteor"},
  {de:"Raumschiff",en:"Spaceship",sv:"Rymdskepp"},{de:"Astronaut",en:"Astronaut",sv:"Astronaut"},{de:"Teleskop",en:"Telescope",sv:"Teleskop"},
  {de:"Orbit",en:"Orbit",sv:"Omloppsbana"},{de:"Schwerkraft",en:"Gravity",sv:"Tyngdkraft"},{de:"Vakuum",en:"Vacuum",sv:"Vakuum"},
  // Umwelt & Natur
  {de:"Klimawandel",en:"Climate change",sv:"Klimatförändring"},{de:"Recycling",en:"Recycling",sv:"Återvinning"},{de:"Nachhaltigkeit",en:"Sustainability",sv:"Hållbarhet"},
  {de:"Emission",en:"Emission",sv:"Utsläpp"},{de:"Ozonschicht",en:"Ozone layer",sv:"Ozonskikt"},{de:"Artenvielfalt",en:"Biodiversity",sv:"Biologisk mångfald"},
  {de:"Umweltverschmutzung",en:"Pollution",sv:"Föroreningar"},{de:"Naturschutz",en:"Conservation",sv:"Naturvård"},{de:"Erosion",en:"Erosion",sv:"Erosion"},
  {de:"Dürre",en:"Drought",sv:"Torka"},{de:"Überschwemmung",en:"Flood",sv:"Översvämning"},{de:"Erdbeben",en:"Earthquake",sv:"Jordbävning"},
  // Gebäude & Architektur
  {de:"Turm",en:"Tower",sv:"Torn"},
  
  {de:"Terrasse",en:"Terrace",sv:"Terrass"},{de:"Garage",en:"Garage",sv:"Garage"},
  // Fahrzeuge
  {de:"Lastwagen",en:"Truck",sv:"Lastbil"},
  {de:"Segelboot",en:"Sailboat",sv:"Segelbåt"},{de:"U-Boot",en:"Submarine",sv:"Ubåt"},
  {de:"Schulbus",en:"School bus",sv:"Skolbuss"},{de:"Feuerwehrauto",en:"Fire truck",sv:"Brandbil"},
  {de:"Krankenwagen",en:"Ambulance",sv:"Ambulans"},{de:"Polizeiauto",en:"Police car",sv:"Polisbil"},
  // Elektronik & Medien
  {de:"Kopfhörer",en:"Headphones",sv:"Hörlurar"},{de:"Lautsprecher",en:"Speaker",sv:"Högtalare"},{de:"Mikrofon",en:"Microphone",sv:"Mikrofon"},
  
  {de:"Scanner",en:"Scanner",sv:"Scanner"},
  // Schule & Büro
  {de:"Radiergummi",en:"Eraser",sv:"Suddgummi"},
  {de:"Schere",en:"Scissors",sv:"Sax"},{de:"Klebeband",en:"Tape",sv:"Tejp"},
  {de:"Hefter",en:"Stapler",sv:"Häftapparat"},{de:"Kalender",en:"Calendar",sv:"Kalender"},
  {de:"Notizblock",en:"Notepad",sv:"Anteckningsblock"},{de:"Taschenrechner",en:"Calculator",sv:"Räknare"},{de:"Briefumschlag",en:"Envelope",sv:"Kuvert"},
  // Zusätzliche Verben
  
  {de:"aufwachen",en:"to wake up",sv:"att vakna"},{de:"atmen",en:"to breathe",sv:"att andas"},
  {de:"kämpfen",en:"to fight",sv:"att slåss"},
  {de:"üben",en:"to practice",sv:"att öva"},{de:"unterrichten",en:"to teach",sv:"att undervisa"},
  
  {de:"antworten",en:"to answer",sv:"att svara"},{de:"entscheiden",en:"to decide",sv:"att bestämma"},
  // Natur & Wetter erweitert
  {de:"Donner",en:"Thunder",sv:"Åska"},
  {de:"Sturm",en:"Storm",sv:"Storm"},{de:"Hurrikan",en:"Hurricane",sv:"Orkan"},{de:"Tornado",en:"Tornado",sv:"Tornado"},
  {de:"Regenbogen",en:"Rainbow",sv:"Regnbåge"},
  {de:"Gletscher",en:"Glacier",sv:"Glaciär"},{de:"Lawine",en:"Avalanche",sv:"Lavin"},{de:"Vulkan",en:"Volcano",sv:"Vulkan"},
  // Lebensmittelgeschäft & Preise
  
  {de:"Pfand",en:"Deposit",sv:"Pant"},{de:"Kassierer",en:"Cashier",sv:"Kassör"},
  // Körperpflege & Schönheit
  
  {de:"Haarschnitt",en:"Haircut",sv:"Klippning"},{de:"Rasieren",en:"Shaving",sv:"Rakning"},{de:"Wimpern",en:"Eyelashes",sv:"Ögonfransar"},
  // Haushalt & Reinigung
  {de:"Waschmittel",en:"Detergent",sv:"Tvättmedel"},{de:"Mop",en:"Mop",sv:"Mopp"},
  {de:"Putztuch",en:"Cloth",sv:"Trasa"},
  // Medizin & Gesundheit erweitert
  {de:"Impfung",en:"Vaccination",sv:"Vaccination"},
  // Reise & Tourismus
  {de:"Reisepass",en:"Passport",sv:"Pass"},
  {de:"Reiseleiter",en:"Tour guide",sv:"Reseledare"},{de:"Souvenirgeschäft",en:"Souvenir shop",sv:"Souvenirbutik"},
  // Tiere Laute
  {de:"bellen",en:"to bark",sv:"att skälla"},{de:"miauen",en:"to meow",sv:"att jama"},{de:"brüllen",en:"to roar",sv:"att ryta"},
  {de:"zwitschern",en:"to chirp",sv:"att kvittra"},{de:"summen",en:"to hum",sv:"att surra"},{de:"quaken",en:"to quack",sv:"att kvacka"},
  // Weitere nützliche Wörter
  {de:"kostenlos",en:"free",sv:"gratis"},
  {de:"modern",en:"modern",sv:"modern"},
  {de:"traditionell",en:"traditional",sv:"traditionell"},{de:"beliebt",en:"popular",sv:"populär"},
  {de:"häufig",en:"frequent",sv:"frekvent"},
  {de:"freiwillig",en:"voluntary",sv:"frivillig"},
  // IT & Programmierung
  {de:"Datenbank",en:"Database",sv:"Databas"},{de:"Variable",en:"Variable",sv:"Variabel"},
  {de:"Schleife",en:"Loop",sv:"Loop"},{de:"Bedingung",en:"Condition",sv:"Villkor"},
  {de:"Fehler",en:"Bug",sv:"Bugg"},{de:"Debuggen",en:"Debugging",sv:"Felsökning"},{de:"Kompilieren",en:"Compiling",sv:"Kompilering"},
  {de:"Quellcode",en:"Source code",sv:"Källkod"},{de:"Objekt",en:"Object",sv:"Objekt"},
  {de:"Schnittstelle",en:"Interface",sv:"Gränssnitt"},
  {de:"Framework",en:"Framework",sv:"Ramverk"},{de:"Deployment",en:"Deployment",sv:"Driftsättning"},
  {de:"Client",en:"Client",sv:"Klient"},{de:"API",en:"API",sv:"API"},
  // Social Media & Kommunikation
  {de:"Follower",en:"Follower",sv:"Följare"},{de:"Beitrag",en:"Post",sv:"Inlägg"},{de:"Kommentar",en:"Comment",sv:"Kommentar"},
  {de:"Liken",en:"Like",sv:"Gilla"},{de:"Hashtag",en:"Hashtag",sv:"Hashtag"},
  {de:"Profil",en:"Profile",sv:"Profil"},{de:"Benachrichtigung",en:"Notification",sv:"Avisering"},{de:"Direktnachricht",en:"Direct message",sv:"Direktmeddelande"},
  {de:"Livestream",en:"Livestream",sv:"Direktsändning"},{de:"Abonnent",en:"Subscriber",sv:"Prenumerant"},{de:"Inhalt",en:"Content",sv:"Innehåll"},
  {de:"Influencer",en:"Influencer",sv:"Influencer"},{de:"Viral",en:"Viral",sv:"Viral"},{de:"Trend",en:"Trend",sv:"Trend"},
  // Energie & Umwelt
  {de:"Solarenergie",en:"Solar energy",sv:"Solenergi"},{de:"Windkraft",en:"Wind power",sv:"Vindkraft"},{de:"Wasserkraft",en:"Hydropower",sv:"Vattenkraft"},
  {de:"Kernenergie",en:"Nuclear energy",sv:"Kärnenergi"},{de:"Erdöl",en:"Oil",sv:"Olja"},
  {de:"Erdgas",en:"Natural gas",sv:"Naturgas"},{de:"Batterie",en:"Battery",sv:"Batteri"},{de:"Steckdose",en:"Socket",sv:"Uttag"},
  {de:"Stromleitung",en:"Power line",sv:"Kraftledning"},{de:"Kraftwerk",en:"Power plant",sv:"Kraftverk"},{de:"CO2-Ausstoß",en:"CO2 emission",sv:"CO2-utsläpp"},
  {de:"Treibhausgas",en:"Greenhouse gas",sv:"Växthusgas"},{de:"Biokraftstoff",en:"Biofuel",sv:"Biobränsle"},{de:"Elektroauto",en:"Electric car",sv:"Elbil"},
  // Bildung & Universität
  {de:"Vorlesung",en:"Lecture",sv:"Föreläsning"},{de:"Seminar",en:"Seminar",sv:"Seminarium"},{de:"Hausarbeit",en:"Essay",sv:"Uppsats"},
  {de:"Abschluss",en:"Degree",sv:"Examen"},{de:"Bachelor",en:"Bachelor",sv:"Kandidat"},{de:"Master",en:"Master",sv:"Master"},
  {de:"Doktorat",en:"Doctorate",sv:"Doktorat"},{de:"Stipendium",en:"Scholarship",sv:"Stipendium"},{de:"Studiengebühren",en:"Tuition fees",sv:"Studieavgifter"},
  {de:"Campus",en:"Campus",sv:"Campus"},{de:"Mensa",en:"Canteen",sv:"Matsal"},{de:"Bibliothekskarte",en:"Library card",sv:"Bibliotekskort"},
  {de:"Zeugnis",en:"Certificate",sv:"Betyg"},{de:"Lehrplan",en:"Curriculum",sv:"Läroplan"},
  // Karriere & Arbeit
  {de:"Bewerbung",en:"Application",sv:"Ansökan"},{de:"Lebenslauf",en:"CV",sv:"CV"},{de:"Vorstellungsgespräch",en:"Job interview",sv:"Jobbintervju"},
  {de:"Kündigung",en:"Resignation",sv:"Uppsägning"},{de:"Beförderung",en:"Promotion",sv:"Befordran"},
  {de:"Überstunden",en:"Overtime",sv:"Övertid"},{de:"Homeoffice",en:"Home office",sv:"Hemmakontor"},{de:"Teilzeit",en:"Part-time",sv:"Deltid"},
  {de:"Vollzeit",en:"Full-time",sv:"Heltid"},{de:"Selbstständig",en:"Freelance",sv:"Frilans"},
  {de:"Vorgesetzter",en:"Supervisor",sv:"Chef"},{de:"Mitarbeiter",en:"Employee",sv:"Anställd"},{de:"Besprechung",en:"Meeting",sv:"Möte"},
  // Medien & Presse
  {de:"Zeitung",en:"Newspaper",sv:"Tidning"},{de:"Zeitschrift",en:"Magazine",sv:"Tidskrift"},{de:"Artikel",en:"Article",sv:"Artikel"},
  {de:"Schlagzeile",en:"Headline",sv:"Rubrik"},
  {de:"Interview",en:"Interview",sv:"Intervju"},{de:"Reportage",en:"Report",sv:"Reportage"},{de:"Bericht",en:"Report",sv:"Rapport"},
  {de:"Nachrichten",en:"News",sv:"Nyheter"},{de:"Sendung",en:"Broadcast",sv:"Sändning"},{de:"Moderator",en:"Presenter",sv:"Presentatör"},
  {de:"Podcast",en:"Podcast",sv:"Podcast"},
  // Kleidung & Mode erweitert
  {de:"Regenmantel",en:"Raincoat",sv:"Regnkappa"},{de:"Blazer",en:"Blazer",sv:"Kavaj"},{de:"Weste",en:"Vest",sv:"Väst"},
  {de:"Leggings",en:"Leggings",sv:"Tights"},{de:"Overall",en:"Overall",sv:"Overall"},{de:"Kittel",en:"Smock",sv:"Rock"},
  {de:"Bikini",en:"Bikini",sv:"Bikini"},
  {de:"Strumpfhose",en:"Tights",sv:"Strumpbyxor"},{de:"Schlafanzug",en:"Pyjamas",sv:"Pyjamas"},
  {de:"Uniform",en:"Uniform",sv:"Uniform"},{de:"Smoking",en:"Tuxedo",sv:"Frack"},
  // Küche & Kochen erweitert
  {de:"Wok",en:"Wok",sv:"Wok"},
  {de:"Schneidebrett",en:"Cutting board",sv:"Skärbräda"},{de:"Küchenmesser",en:"Kitchen knife",sv:"Köksknivar"},{de:"Reibe",en:"Grater",sv:"Rivjärn"},
  {de:"Sieb",en:"Sieve",sv:"Sil"},{de:"Küchenwaage",en:"Kitchen scale",sv:"Köksvåg"},
  
  {de:"Gefrierschrank",en:"Freezer",sv:"Frys"},
  // Haustiere & Tierpflege
  {de:"Leine",en:"Leash",sv:"Koppel"},
  {de:"Halsband",en:"Collar",sv:"Halsband"},{de:"Käfig",en:"Cage",sv:"Bur"},{de:"Aquarium",en:"Aquarium",sv:"Akvarium"},
  {de:"Tierfutter",en:"Pet food",sv:"Djurmat"},{de:"Stall",en:"Stable",sv:"Stall"},{de:"Zwinger",en:"Kennel",sv:"Hundkoja"},
  {de:"Fellpflege",en:"Grooming",sv:"Grooming"},{de:"Kastrieren",en:"Neutering",sv:"Kastrering"},{de:"Chip",en:"Microchip",sv:"Mikrochip"},
  // Musik & Konzert erweitert
  {de:"Dirigent",en:"Conductor",sv:"Dirigent"},
  {de:"Chor",en:"Choir",sv:"Kör"},{de:"Solo",en:"Solo",sv:"Solo"},{de:"Duett",en:"Duet",sv:"Duett"},
  
  
  {de:"Tournee",en:"Tour",sv:"Turné"},{de:"Festival",en:"Festival",sv:"Festival"},{de:"Zugabe",en:"Encore",sv:"Extranummer"},
  // Reise & Tourismus erweitert
  {de:"Reisebüro",en:"Travel agency",sv:"Resebyrå"},{de:"Ausflug",en:"Excursion",sv:"Utflykt"},
  {de:"Rundreise",en:"Round trip",sv:"Rundresa"},{de:"Kreuzfahrt",en:"Cruise",sv:"Kryssning"},
  {de:"Flugsteig",en:"Gate",sv:"Gate"},{de:"Einreise",en:"Entry",sv:"Inresa"},{de:"Ausreise",en:"Exit",sv:"Utresa"},
  {de:"Zoll",en:"Customs",sv:"Tull"},{de:"Gepäckband",en:"Baggage belt",sv:"Bagagebana"},
  {de:"Verspätung",en:"Delay",sv:"Försening"},{de:"Umsteigen",en:"Transfer",sv:"Byte"},
  // Sport & Fitness erweitert
  {de:"Fitnessstudio",en:"Gym",sv:"Gym"},{de:"Hantel",en:"Dumbbell",sv:"Hantel"},{de:"Treadmill",en:"Treadmill",sv:"Löpband"},
  {de:"Yogamatte",en:"Yoga mat",sv:"Yogamatta"},{de:"Personal Trainer",en:"Personal trainer",sv:"Personlig tränare"},{de:"Aufwärmen",en:"Warm-up",sv:"Uppvärmning"},
  {de:"Wiederholung",en:"Repetition",sv:"Repetition"},
  {de:"Muskeln",en:"Muscles",sv:"Muskler"},{de:"Ausdauer",en:"Endurance",sv:"Uthållighet"},{de:"Koordination",en:"Coordination",sv:"Koordination"},
  {de:"Gleichgewicht",en:"Balance",sv:"Balans"},{de:"Flexibilität",en:"Flexibility",sv:"Flexibilitet"},
  // Farben & Design erweitert
  {de:"Khaki",en:"Khaki",sv:"Khaki"},
  {de:"Koralle",en:"Coral",sv:"Korall"},{de:"Smaragdgrün",en:"Emerald green",sv:"Smaragdgrönt"},
  {de:"Elfenbein",en:"Ivory",sv:"Elfenben"},{de:"Schokoladenbraun",en:"Chocolate brown",sv:"Chokladbrun"},{de:"Mintgrün",en:"Mint green",sv:"Mintgrön"},
  {de:"Dunkelblau",en:"Navy blue",sv:"Marinblå"},{de:"Hellgrau",en:"Light grey",sv:"Ljusgrå"},{de:"Anthrazit",en:"Anthracite",sv:"Antracit"},
  // Gesundheit & Medizin erweitert
  {de:"Psychotherapie",en:"Psychotherapy",sv:"Psykoterapi"},{de:"Ernährungsberatung",en:"Nutrition counseling",sv:"Kostrådgivning"},
  {de:"Bluttest",en:"Blood test",sv:"Blodprov"},{de:"Ultraschall",en:"Ultrasound",sv:"Ultraljud"},
  {de:"MRT",en:"MRI",sv:"MRT"},{de:"EKG",en:"ECG",sv:"EKG"},
  {de:"Narkose",en:"Anesthesia",sv:"Anestesi"},{de:"Naht",en:"Stitch",sv:"Stygn"},{de:"Gips",en:"Cast",sv:"Gips"},
  {de:"Rollstuhl",en:"Wheelchair",sv:"Rullstol"},{de:"Krücken",en:"Crutches",sv:"Kryckor"},{de:"Prothese",en:"Prosthesis",sv:"Protes"},
  // Mathematik erweitert
  
  
  {de:"Integral",en:"Integral",sv:"Integral"},{de:"Ableitung",en:"Derivative",sv:"Derivata"},
  
  {de:"Koordinate",en:"Coordinate",sv:"Koordinat"},{de:"Vektor",en:"Vector",sv:"Vektor"},
  // Wirtschaft & Handel erweitert
  {de:"Handelsabkommen",en:"Trade agreement",sv:"Handelsavtal"},
  {de:"Zölle",en:"Tariffs",sv:"Tullar"},{de:"Marktanteil",en:"Market share",sv:"Marknadsandel"},{de:"Umsatz",en:"Revenue",sv:"Omsättning"},
  
  {de:"Rendite",en:"Return",sv:"Avkastning"},
  {de:"Börse",en:"Stock exchange",sv:"Börs"},{de:"Fusion",en:"Merger",sv:"Fusion"},{de:"Übernahme",en:"Acquisition",sv:"Förvärv"},
  // Lebensmittel & Ernährung erweitert
  {de:"Mineral",en:"Mineral",sv:"Mineral"},{de:"Protein",en:"Protein",sv:"Protein"},
  {de:"Kohlenhydrat",en:"Carbohydrate",sv:"Kolhydrat"},{de:"Fett",en:"Fat",sv:"Fett"},{de:"Kalorien",en:"Calories",sv:"Kalorier"},
  {de:"Diät",en:"Diet",sv:"Diet"},{de:"Vegetarisch",en:"Vegetarian",sv:"Vegetarisk"},{de:"Vegan",en:"Vegan",sv:"Vegansk"},
  {de:"Glutenfrei",en:"Gluten-free",sv:"Glutenfri"},{de:"Frisch",en:"Fresh",sv:"Färsk"},
  {de:"Tiefgekühltes",en:"Frozen food",sv:"Fryst mat"},{de:"Konserven",en:"Canned food",sv:"Konserver"},{de:"Haltbarkeitsdatum",en:"Expiry date",sv:"Bäst-före-datum"},
  // Recht & Justiz erweitert
  
  {de:"Staatsanwalt",en:"Prosecutor",sv:"Åklagare"},
  {de:"Berufung",en:"Appeal",sv:"Överklagande"},
  {de:"Freispruch",en:"Acquittal",sv:"Frigivning"},{de:"Verurteilung",en:"Conviction",sv:"Fällande dom"},
  {de:"Täter",en:"Perpetrator",sv:"Gärningsman"},{de:"Opfer",en:"Victim",sv:"Offer"},{de:"Haftstrafe",en:"Prison sentence",sv:"Fängelsestraff"},
  // Natur & Geographie
  {de:"Kontinent",en:"Continent",sv:"Kontinent"},{de:"Ozean",en:"Ocean",sv:"Ocean"},{de:"Halbinsel",en:"Peninsula",sv:"Halvö"},
  {de:"Kap",en:"Cape",sv:"Kap"},{de:"Delta",en:"Delta",sv:"Delta"},
  {de:"Plateau",en:"Plateau",sv:"Platå"},{de:"Tiefebene",en:"Plain",sv:"Lågland"},{de:"Hochland",en:"Highlands",sv:"Högland"},
  {de:"Steppe",en:"Steppe",sv:"Stäpp"},{de:"Savanne",en:"Savanna",sv:"Savann"},{de:"Regenwald",en:"Rainforest",sv:"Regnskog"},
  {de:"Tundra",en:"Tundra",sv:"Tundra"},{de:"Moor",en:"Moor",sv:"Mosse"},{de:"Sumpf",en:"Swamp",sv:"Träsk"},
  // Emotionen & Psychologie erweitert
  {de:"Empathie",en:"Empathy",sv:"Empati"},{de:"Mitgefühl",en:"Compassion",sv:"Medkänsla"},{de:"Frustration",en:"Frustration",sv:"Frustration"},
  {de:"Verlegenheit",en:"Embarrassment",sv:"Genans"},
  
  {de:"Dankbarkeit",en:"Gratitude",sv:"Tacksamhet"},
  {de:"Langeweile",en:"Boredom",sv:"Tristess"},{de:"Einsamkeit",en:"Loneliness",sv:"Ensamhet"},
  // Wohnen & Einrichten erweitert
  {de:"Kinderzimmer",en:"Children's room",sv:"Barnrum"},
  {de:"Arbeitszimmer",en:"Study",sv:"Arbetsrum"},{de:"Dachboden",en:"Attic",sv:"Vind"},{de:"Heizung",en:"Heating",sv:"Uppvärmning"},
  {de:"Rolladen",en:"Shutter",sv:"Rullgardin"},{de:"Jalousie",en:"Blinds",sv:"Persienn"},
  {de:"Parkett",en:"Parquet",sv:"Parkettgolv"},{de:"Tapete",en:"Wallpaper",sv:"Tapet"},
  {de:"Lichtschalter",en:"Light switch",sv:"Ljusbrytare"},{de:"Sicherung",en:"Fuse",sv:"Säkring"},
  // Sprache & Linguistik
  
  {de:"Absatz",en:"Paragraph",sv:"Stycke"},
  
  {de:"Betonung",en:"Stress",sv:"Betoning"},
  {de:"Muttersprache",en:"Mother tongue",sv:"Modersmål"},
  // Tier- & Pflanzenwelt erweitert
  {de:"Reptil",en:"Reptile",sv:"Reptil"},{de:"Amphibie",en:"Amphibian",sv:"Amfibie"},{de:"Säugetier",en:"Mammal",sv:"Däggdjur"},
  {de:"Raubtier",en:"Predator",sv:"Rovdjur"},{de:"Beute",en:"Prey",sv:"Byte"},{de:"Herde",en:"Herd",sv:"Hjord"},
  {de:"Schwarm",en:"Flock",sv:"Flock"},{de:"Rudel",en:"Pack",sv:"Flock"},{de:"Nest",en:"Nest",sv:"Bo"},
  {de:"Höhle",en:"Den",sv:"Lya"},{de:"Bau",en:"Burrow",sv:"Gryt"},{de:"Migration",en:"Migration",sv:"Migration"},
  {de:"Hibernation",en:"Hibernation",sv:"Dvala"},{de:"Fotosynthese",en:"Photosynthesis",sv:"Fotosyntes"},{de:"Pollination",en:"Pollination",sv:"Pollinering"},
  // Zahlen & Mengen erweitert
  {de:"Million",en:"Million",sv:"Miljon"},{de:"Milliarde",en:"Billion",sv:"Miljard"},{de:"Billion",en:"Trillion",sv:"Biljon"},
  {de:"Unendlich",en:"Infinite",sv:"Oändlig"},{de:"Hälfte",en:"Half",sv:"Hälften"},
  {de:"Drittel",en:"Third",sv:"Tredjedel"},{de:"Viertel",en:"Quarter",sv:"Kvart"},{de:"Dutzend",en:"Dozen",sv:"Dussin"},
  {de:"Paar",en:"Pair",sv:"Par"},{de:"Gruppe",en:"Group",sv:"Grupp"},{de:"Menge",en:"Quantity",sv:"Mängd"},
  {de:"Summe",en:"Sum",sv:"Summa"},{de:"Differenz",en:"Difference",sv:"Differens"},{de:"Produkt",en:"Product",sv:"Produkt"},
  // Gesellschaft & Kultur
  {de:"Tradition",en:"Tradition",sv:"Tradition"},{de:"Brauch",en:"Custom",sv:"Sedvänja"},
  {de:"Feier",en:"Celebration",sv:"Firande"},{de:"Generation",en:"Generation",sv:"Generation"},
  {de:"Gemeinschaft",en:"Community",sv:"Gemenskap"},{de:"Gesellschaft",en:"Society",sv:"Samhälle"},{de:"Bevölkerung",en:"Population",sv:"Befolkning"},
  {de:"Minderheit",en:"Minority",sv:"Minoritet"},{de:"Mehrheit",en:"Majority",sv:"Majoritet"},{de:"Integration",en:"Integration",sv:"Integration"},
  {de:"Diskriminierung",en:"Discrimination",sv:"Diskriminering"},{de:"Gleichberechtigung",en:"Equality",sv:"Jämlikhet"},{de:"Vielfalt",en:"Diversity",sv:"Mångfald"},
  // Persönlichkeit & Charakter
  {de:"geduldig",en:"patient",sv:"tålmodig"},{de:"ungeduldig",en:"impatient",sv:"otålmodig"},
  {de:"unehrlich",en:"dishonest",sv:"oärlig"},
  {de:"neugierig",en:"curious",sv:"nyfiken"},{de:"kreativ",en:"creative",sv:"kreativ"},{de:"praktisch",en:"practical",sv:"praktisk"},
  {de:"logisch",en:"logical",sv:"logisk"},{de:"intuitiv",en:"intuitive",sv:"intuitiv"},{de:"spontan",en:"spontaneous",sv:"spontan"},
  {de:"zuverlässig",en:"reliable",sv:"pålitlig"},{de:"verantwortungsbewusst",en:"responsible",sv:"ansvarsfull"},{de:"ehrgeizig",en:"ambitious",sv:"ambitiös"},
  // Technik & Maschinen erweitert
  {de:"Bremse",en:"Brake",sv:"Broms"},
  {de:"Lenkrad",en:"Steering wheel",sv:"Ratt"},{de:"Kupplung",en:"Clutch",sv:"Koppling"},{de:"Auspuff",en:"Exhaust",sv:"Avgasrör"},
  {de:"Tank",en:"Tank",sv:"Tank"},{de:"Reifendruck",en:"Tyre pressure",sv:"Däcktryck"},{de:"Windschutzscheibe",en:"Windscreen",sv:"Vindruta"},
  {de:"Scheibenwischer",en:"Windscreen wiper",sv:"Vindrutetorkare"},{de:"Scheinwerfer",en:"Headlight",sv:"Strålkastare"},{de:"Blinker",en:"Indicator",sv:"Blinkers"},
  // Finanzwesen & Banking erweitert
  {de:"Kontostand",en:"Account balance",sv:"Kontosaldo"},{de:"Dauerauftrag",en:"Standing order",sv:"Autogiro"},
  
  
  {de:"Mehrwertsteuer",en:"VAT",sv:"Moms"},{de:"Einkommensteuer",en:"Income tax",sv:"Inkomstskatt"},{de:"Steuererklärung",en:"Tax return",sv:"Skattedeklaration"},
  // Polizei & Sicherheit
  {de:"Polizei",en:"Police",sv:"Polis"},{de:"Feuerwehr",en:"Fire brigade",sv:"Brandkår"},{de:"Notfall",en:"Emergency",sv:"Nödsituation"},
  {de:"Notruf",en:"Emergency call",sv:"Nödsamtal"},{de:"Alarm",en:"Alarm",sv:"Larm"},{de:"Überwachung",en:"Surveillance",sv:"Övervakning"},
  {de:"Sicherheit",en:"Security",sv:"Säkerhet"},{de:"Schutz",en:"Protection",sv:"Skydd"},{de:"Gefahr",en:"Danger",sv:"Fara"},
  // Wetter & Klima erweitert
  {de:"Luftfeuchtigkeit",en:"Humidity",sv:"Luftfuktighet"},{de:"Niederschlag",en:"Precipitation",sv:"Nederbörd"},
  {de:"Barometer",en:"Barometer",sv:"Barometer"},{de:"Wettervorhersage",en:"Weather forecast",sv:"Väderprognos"},{de:"Jahreszeit",en:"Season",sv:"Årstid"},
  {de:"Hitzewelle",en:"Heat wave",sv:"Värmebölja"},{de:"Kältewelle",en:"Cold wave",sv:"Köldknäpp"},{de:"Schneefall",en:"Snowfall",sv:"Snöfall"},
  {de:"Hagel",en:"Hail",sv:"Hagel"},
  // Philosophie & Ethik erweitert
  {de:"Lüge",en:"Lie",sv:"Lögn"},
  {de:"Gleichheit",en:"Equality",sv:"Likhet"},{de:"Würde",en:"Dignity",sv:"Värdighet"},
  {de:"Norm",en:"Norm",sv:"Norm"},
  {de:"Pflicht",en:"Duty",sv:"Plikt"},{de:"Recht",en:"Right",sv:"Rätt"},
  // Weitere Verben des Alltags
  {de:"anrufen",en:"to call",sv:"att ringa"},{de:"abholen",en:"to pick up",sv:"att hämta"},{de:"bringen",en:"to bring",sv:"att ta med"},
  {de:"planen",en:"to plan",sv:"att planera"},
  {de:"organisieren",en:"to organize",sv:"att organisera"},{de:"vorbereiten",en:"to prepare",sv:"att förbereda"},
  {de:"beenden",en:"to finish",sv:"att avsluta"},{de:"wiederholen",en:"to repeat",sv:"att upprepa"},{de:"überprüfen",en:"to check",sv:"att kontrollera"},
  // Freizeit & Unterhaltung
  
  
  {de:"Vergnügungspark",en:"Amusement park",sv:"Nöjespark"},{de:"Zoo",en:"Zoo",sv:"Djurpark"},
  {de:"Botanischer Garten",en:"Botanical garden",sv:"Botanisk trädgård"},
  {de:"Buchhandlung",en:"Bookshop",sv:"Bokhandel"},
  // Küstenregion & Meer
  {de:"Küste",en:"Coast",sv:"Kust"},{de:"Welle",en:"Wave",sv:"Våg"},
  {de:"Ebbe",en:"Low tide",sv:"Ebb"},{de:"Flut",en:"High tide",sv:"Flod"},{de:"Riff",en:"Reef",sv:"Rev"},
  {de:"Muschel",en:"Shell",sv:"Snäcka"},
  {de:"Leuchtturm",en:"Lighthouse",sv:"Fyr"},{de:"Anker",en:"Anchor",sv:"Ankare"},
  {de:"Segel",en:"Sail",sv:"Segel"},{de:"Ruder",en:"Oar",sv:"Åra"},{de:"Fischnetz",en:"Fishing net",sv:"Fisknät"},
  {de:"Welpe",en:"Puppy",sv:"Valp"},{de:"Kätzchen",en:"Kitten",sv:"Kattunge"},{de:"Fohlen",en:"Foal",sv:"Föl"},
  {de:"Küken",en:"Chick",sv:"Kyckling"},{de:"Ferkel",en:"Piglet",sv:"Smågris"},{de:"Lamm",en:"Lamb",sv:"Lamm"},
  {de:"Kalb",en:"Calf",sv:"Kalv"},{de:"Junges",en:"Young animal",sv:"Unge"},{de:"Welpenwurf",en:"Litter",sv:"Kull"},
  {de:"Zwilling",en:"Twin",sv:"Tvilling"},{de:"Drilling",en:"Triplet",sv:"Trilling"},
  // Mathematik erweitert II
  {de:"Primzahl",en:"Prime number",sv:"Primtal"},{de:"Potenz",en:"Power",sv:"Potens"},{de:"Logarithmus",en:"Logarithm",sv:"Logaritm"},
  {de:"Trigonometrie",en:"Trigonometry",sv:"Trigonometri"},{de:"Sinus",en:"Sine",sv:"Sinus"},{de:"Kosinus",en:"Cosine",sv:"Kosinus"},
  {de:"Tangente",en:"Tangent",sv:"Tangent"},{de:"Kurve",en:"Curve",sv:"Kurva"},{de:"Achse",en:"Axis",sv:"Axel"},
  {de:"Parallelogramm",en:"Parallelogram",sv:"Parallellogram"},{de:"Polygon",en:"Polygon",sv:"Polygon"},
  {de:"Diagonale",en:"Diagonal",sv:"Diagonal"},{de:"Umfang",en:"Perimeter",sv:"Omkrets"},{de:"Durchmesser",en:"Diameter",sv:"Diameter"},
  {de:"Radius",en:"Radius",sv:"Radius"},{de:"Hypotenuse",en:"Hypotenuse",sv:"Hypotenusa"},{de:"Kathete",en:"Leg of triangle",sv:"Katet"},
  {de:"Winkel",en:"Angle",sv:"Vinkel"},{de:"Gerade",en:"Straight line",sv:"Rät linje"},{de:"Punkt",en:"Point",sv:"Punkt"},
  {de:"Matrix",en:"Matrix",sv:"Matris"},{de:"Determinante",en:"Determinant",sv:"Determinant"},{de:"Permutation",en:"Permutation",sv:"Permutation"},
  {de:"Kombination",en:"Combination",sv:"Kombination"},{de:"Fibonacci",en:"Fibonacci",sv:"Fibonacci"},{de:"Nennwert",en:"Face value",sv:"Nominellt värde"},
  // Physik
  {de:"Schwingung",en:"Oscillation",sv:"Svängning"},{de:"Frequenz",en:"Frequency",sv:"Frekvens"},{de:"Amplitude",en:"Amplitude",sv:"Amplitud"},
  {de:"Wellenlänge",en:"Wavelength",sv:"Våglängd"},{de:"Lichtgeschwindigkeit",en:"Speed of light",sv:"Ljushastighet"},{de:"Trägheit",en:"Inertia",sv:"Tröghet"},
  {de:"Reibung",en:"Friction",sv:"Friktion"},{de:"Druck",en:"Pressure",sv:"Tryck"},{de:"Dichte",en:"Density",sv:"Densitet"},
  {de:"Auftrieb",en:"Buoyancy",sv:"Lyftkraft"},{de:"Ladung",en:"Charge",sv:"Laddning"},{de:"Spannung",en:"Voltage",sv:"Spänning"},
  {de:"Widerstand",en:"Resistance",sv:"Motstånd"},{de:"Stromstärke",en:"Current",sv:"Ström"},{de:"Kondensator",en:"Capacitor",sv:"Kondensator"},
  {de:"Magnet",en:"Magnet",sv:"Magnet"},{de:"Elektromagnet",en:"Electromagnet",sv:"Elektromagnet"},{de:"Wärmeleitung",en:"Heat conduction",sv:"Värmeledning"},
  {de:"Verdampfung",en:"Evaporation",sv:"Avdunstning"},{de:"Kondensation",en:"Condensation",sv:"Kondensation"},{de:"Schmelzpunkt",en:"Melting point",sv:"Smältpunkt"},
  {de:"Siedepunkt",en:"Boiling point",sv:"Kokpunkt"},{de:"Aggregatzustand",en:"State of matter",sv:"Aggregationstillstånd"},{de:"Quantenmechanik",en:"Quantum mechanics",sv:"Kvantmekanik"},
  {de:"Relativitätstheorie",en:"Theory of relativity",sv:"Relativitetsteori"},{de:"Thermodynamik",en:"Thermodynamics",sv:"Termodynamik"},
  // Chemie erweitert
  {de:"Periodensystem",en:"Periodic table",sv:"Periodiska systemet"},{de:"Element",en:"Element",sv:"Element"},{de:"Verbindung",en:"Compound",sv:"Förening"},
  {de:"Gemisch",en:"Mixture",sv:"Blandning"},{de:"Solvens",en:"Solvent",sv:"Lösningsmedel"},
  {de:"Säure",en:"Acid",sv:"Syra"},{de:"Base",en:"Base",sv:"Bas"},{de:"pH-Wert",en:"pH value",sv:"pH-värde"},
  {de:"Oxidation",en:"Oxidation",sv:"Oxidation"},{de:"Reduktion",en:"Reduction",sv:"Reduktion"},{de:"Katalysator",en:"Catalyst",sv:"Katalysator"},
  {de:"Ion",en:"Ion",sv:"Jon"},{de:"Elektron",en:"Electron",sv:"Elektron"},{de:"Proton",en:"Proton",sv:"Proton"},
  {de:"Neutron",en:"Neutron",sv:"Neutron"},{de:"Bindung",en:"Bond",sv:"Bindning"},{de:"Polymer",en:"Polymer",sv:"Polymer"},
  {de:"Destillation",en:"Distillation",sv:"Destillation"},{de:"Kristallisation",en:"Crystallization",sv:"Kristallisering"},
  // IT & Internet erweitert
  {de:"Verschlüsselung",en:"Encryption",sv:"Kryptering"},{de:"Firewall",en:"Firewall",sv:"Brandvägg"},{de:"Router",en:"Router",sv:"Router"},
  {de:"Protokoll",en:"Protocol",sv:"Protokoll"},{de:"IP-Adresse",en:"IP address",sv:"IP-adress"},{de:"Domain",en:"Domain",sv:"Domän"},
  {de:"Hosting",en:"Hosting",sv:"Webbhotell"},{de:"Datenübertragung",en:"Data transfer",sv:"Dataöverföring"},{de:"Bandbreite",en:"Bandwidth",sv:"Bandbredd"},
  {de:"Cache",en:"Cache",sv:"Cache"},{de:"Cookie",en:"Cookie",sv:"Cookie"},{de:"Browser-Erweiterung",en:"Browser extension",sv:"Webbläsartillägg"},
  {de:"Sicherheitslücke",en:"Security vulnerability",sv:"Säkerhetslucka"},{de:"Phishing",en:"Phishing",sv:"Nätfiske"},{de:"Malware",en:"Malware",sv:"Skadlig programvara"},
  {de:"Backup",en:"Backup",sv:"Säkerhetskopia"},{de:"Cloud-Speicher",en:"Cloud storage",sv:"Molnlagring"},{de:"Streaming-Dienst",en:"Streaming service",sv:"Streamingtjänst"},
  {de:"Maschinelles Lernen",en:"Machine learning",sv:"Maskininlärning"},
  // Musik - weitere Instrumente & Begriffe
  {de:"Tuba",en:"Tuba",sv:"Tuba"},{de:"Oboe",en:"Oboe",sv:"Oboe"},{de:"Fagott",en:"Bassoon",sv:"Fagott"},
  {de:"Triangel",en:"Triangle",sv:"Triangel"},{de:"Marimba",en:"Marimba",sv:"Marimba"},{de:"Xylofon",en:"Xylophone",sv:"Xylofon"},
  {de:"Banjo",en:"Banjo",sv:"Banjo"},{de:"Mandoline",en:"Mandolin",sv:"Mandolin"},{de:"Ukulele",en:"Ukulele",sv:"Ukulele"},
  {de:"Synthesizer",en:"Synthesizer",sv:"Synthesizer"},{de:"Drumcomputer",en:"Drum machine",sv:"Trummaskin"},{de:"Verstärker",en:"Amplifier",sv:"Förstärkare"},
  {de:"Mischpult",en:"Mixing desk",sv:"Mixerbord"},{de:"Notenblatt",en:"Sheet of music",sv:"Notblad"},{de:"Partitur",en:"Score",sv:"Partitur"},
  {de:"Metronom",en:"Metronome",sv:"Metronom"},{de:"Stimmgabel",en:"Tuning fork",sv:"Stämgaffel"},{de:"Dämpfer",en:"Mute",sv:"Dämpare"},
  {de:"Plektrum",en:"Plectrum",sv:"Plektrum"},
  // Kunst erweitert
  {de:"Aquarell",en:"Watercolor",sv:"Akvarell"},{de:"Ölgemälde",en:"Oil painting",sv:"Oljemålning"},{de:"Pastell",en:"Pastel",sv:"Pastell"},
  {de:"Gravur",en:"Engraving",sv:"Gravyr"},{de:"Lithografie",en:"Lithography",sv:"Litografi"},{de:"Siebdruck",en:"Screen printing",sv:"Silkscreen"},
  {de:"Fresko",en:"Fresco",sv:"Fresk"},{de:"Mosaik",en:"Mosaic",sv:"Mosaik"},{de:"Collage",en:"Collage",sv:"Kollage"},
  {de:"Installation",en:"Installation",sv:"Installation"},{de:"Performance",en:"Performance art",sv:"Performance"},{de:"Streetart",en:"Street art",sv:"Gatukonst"},
  {de:"Kalligrafie",en:"Calligraphy",sv:"Kalligrafi"},{de:"Töpfern",en:"Pottery",sv:"Krukmakeri"},
  {de:"Bildhauer",en:"Sculptor",sv:"Skulptör"},{de:"Restaurator",en:"Conservator",sv:"Restauratör"},{de:"Kurator",en:"Curator",sv:"Kurator"},
  {de:"Skizze",en:"Sketch",sv:"Skiss"},{de:"Entwurf",en:"Draft",sv:"Utkast"},
  // Literatur erweitert
  {de:"Kurzgeschichte",en:"Short story",sv:"Novell"},{de:"Märchen",en:"Fairy tale",sv:"Saga"},{de:"Fabel",en:"Fable",sv:"Fabel"},
  {de:"Epos",en:"Epic",sv:"Epos"},{de:"Lyrik",en:"Poetry",sv:"Lyrik"},{de:"Prosa",en:"Prose",sv:"Prosa"},
  {de:"Autobiografie",en:"Autobiography",sv:"Självbiografi"},{de:"Memoiren",en:"Memoirs",sv:"Memoarer"},{de:"Tagebuch",en:"Diary",sv:"Dagbok"},
  {de:"Anthologie",en:"Anthology",sv:"Antologi"},{de:"Vorwort",en:"Preface",sv:"Förord"},{de:"Nachwort",en:"Afterword",sv:"Efterord"},
  {de:"Inhaltsverzeichnis",en:"Table of contents",sv:"Innehållsförteckning"},{de:"Fußnote",en:"Footnote",sv:"Fotnot"},{de:"Glossar",en:"Glossary",sv:"Ordlista"},
  {de:"Protagonist",en:"Protagonist",sv:"Protagonist"},{de:"Antagonist",en:"Antagonist",sv:"Antagonist"},{de:"Motiv",en:"Motif",sv:"Motiv"},
  {de:"Symbolik",en:"Symbolism",sv:"Symbolism"},{de:"Ironie",en:"Irony",sv:"Ironi"},
  // Geschichte erweitert
  {de:"Urgeschichte",en:"Prehistory",sv:"Förhistoria"},{de:"Steinzeit",en:"Stone Age",sv:"Stenåldern"},{de:"Bronzezeit",en:"Bronze Age",sv:"Bronsåldern"},
  {de:"Eisenzeit",en:"Iron Age",sv:"Järnåldern"},{de:"Römer",en:"Romans",sv:"Romare"},{de:"Griechen",en:"Greeks",sv:"Greker"},
  {de:"Wikinger",en:"Vikings",sv:"Vikingar"},{de:"Kreuzzug",en:"Crusade",sv:"Korståg"},{de:"Renaissance",en:"Renaissance",sv:"Renässansen"},
  {de:"Reformation",en:"Reformation",sv:"Reformationen"},{de:"Aufklärung",en:"Enlightenment",sv:"Upplysningen"},{de:"Industrialisierung",en:"Industrialization",sv:"Industrialisering"},
  {de:"Kolonialismus",en:"Colonialism",sv:"Kolonialism"},{de:"Imperialismus",en:"Imperialism",sv:"Imperialism"},{de:"Weltkrieg",en:"World War",sv:"Världskrig"},
  {de:"Kalter Krieg",en:"Cold War",sv:"Kalla kriget"},{de:"Mauerfall",en:"Fall of the Wall",sv:"Murens fall"},{de:"Zeitgeschichte",en:"Contemporary history",sv:"Nutidshistoria"},
  {de:"Archäologie",en:"Archaeology",sv:"Arkeologi"},{de:"Ausgrabung",en:"Excavation",sv:"Utgrävning"},
  // Politik erweitert
  {de:"Bürgerrecht",en:"Civil right",sv:"Medborgerlig rättighet"},{de:"Meinungsfreiheit",en:"Freedom of speech",sv:"Yttrandefrihet"},
  {de:"Pressefreiheit",en:"Press freedom",sv:"Pressfrihet"},{de:"Wahlrecht",en:"Voting right",sv:"Rösträtt"},
  {de:"Volksabstimmung",en:"Referendum",sv:"Folkomröstning"},{de:"Bürgermeister",en:"Mayor",sv:"Borgmästare"},
  {de:"Abgeordneter",en:"Member of parliament",sv:"Riksdagsledamot"},{de:"Bundesrat",en:"Federal council",sv:"Förbundsråd"},
  {de:"Bundeskanzler",en:"Federal chancellor",sv:"Förbundskansler"},{de:"Außenminister",en:"Foreign minister",sv:"Utrikesminister"},
  {de:"Innenminister",en:"Interior minister",sv:"Inrikesminister"},{de:"Finanzminister",en:"Finance minister",sv:"Finansminister"},
  {de:"Botschaft",en:"Embassy",sv:"Ambassad"},{de:"Botschafter",en:"Ambassador",sv:"Ambassadör"},{de:"Konsulat",en:"Consulate",sv:"Konsulat"},
  {de:"Nato",en:"NATO",sv:"Nato"},{de:"Europäische Union",en:"European Union",sv:"Europeiska unionen"},{de:"Vereinte Nationen",en:"United Nations",sv:"Förenta nationerna"},
  {de:"Sanktion",en:"Sanction",sv:"Sanktion"},{de:"Embargo",en:"Embargo",sv:"Embargo"},
  // Medizin - weitere Krankheiten
  {de:"Pneumonie",en:"Pneumonia",sv:"Lunginflammation"},{de:"Tuberkulose",en:"Tuberculosis",sv:"Tuberkulos"},{de:"Hepatitis",en:"Hepatitis",sv:"Hepatit"},
  {de:"Epilepsie",en:"Epilepsy",sv:"Epilepsi"},{de:"Parkinson",en:"Parkinson's disease",sv:"Parkinsons sjukdom"},{de:"Alzheimer",en:"Alzheimer's disease",sv:"Alzheimers sjukdom"},
  {de:"Schizophrenie",en:"Schizophrenia",sv:"Schizofreni"},{de:"Autismus",en:"Autism",sv:"Autism"},{de:"ADHS",en:"ADHD",sv:"ADHD"},
  {de:"Bluthochdruck",en:"High blood pressure",sv:"Högt blodtryck"},{de:"Cholesterin",en:"Cholesterol",sv:"Kolesterol"},{de:"Niereninsuffizienz",en:"Kidney failure",sv:"Njursvikt"},
  {de:"Leberzirrhose",en:"Liver cirrhosis",sv:"Levercirros"},{de:"Gicht",en:"Gout",sv:"Gikt"},{de:"Rheuma",en:"Rheumatism",sv:"Reumatism"},
  {de:"Ekzem",en:"Eczema",sv:"Eksem"},{de:"Psoriasis",en:"Psoriasis",sv:"Psoriasis"},{de:"Akne",en:"Acne",sv:"Akne"},
  {de:"Osteoporose",en:"Osteoporosis",sv:"Osteoporos"},{de:"Skoliose",en:"Scoliosis",sv:"Skolios"},
  // Medikamente erweitert
  {de:"Blutverdünner",en:"Blood thinner",sv:"Blodförtunnande medel"},{de:"Betablocker",en:"Beta blocker",sv:"Betablockerare"},
  {de:"Antidepressivum",en:"Antidepressant",sv:"Antidepressivum"},{de:"Beruhigungsmittel",en:"Sedative",sv:"Lugnande medel"},
  {de:"Diuretikum",en:"Diuretic",sv:"Vätskedrivande medel"},{de:"Antihistaminikum",en:"Antihistamine",sv:"Antihistamin"},
  {de:"Cortison",en:"Cortisone",sv:"Kortison"},{de:"Insulin",en:"Insulin",sv:"Insulin"},{de:"Chemotherapie",en:"Chemotherapy",sv:"Kemoterapi"},
  {de:"Strahlentherapie",en:"Radiation therapy",sv:"Strålbehandling"},{de:"Dialyse",en:"Dialysis",sv:"Dialys"},{de:"Transplantation",en:"Transplantation",sv:"Transplantation"},
  {de:"Bypass",en:"Bypass",sv:"Bypass"},{de:"Impfstoffpflicht",en:"Vaccine mandate",sv:"Vaccinationsplikt"},{de:"Generikum",en:"Generic drug",sv:"Generika"},
  // Rechtssystem erweitert
  {de:"Strafrecht",en:"Criminal law",sv:"Straffrätt"},{de:"Zivilrecht",en:"Civil law",sv:"Civilrätt"},{de:"Handelsrecht",en:"Commercial law",sv:"Handelsrätt"},
  {de:"Arbeitsrecht",en:"Labor law",sv:"Arbetsrätt"},{de:"Familienrecht",en:"Family law",sv:"Familjerätt"},{de:"Erbrecht",en:"Inheritance law",sv:"Arvsrätt"},
  {de:"Verfassungsrecht",en:"Constitutional law",sv:"Konstitutionell rätt"},{de:"Steuerhinterziehung",en:"Tax evasion",sv:"Skatteflykt"},
  {de:"Korruption",en:"Corruption",sv:"Korruption"},{de:"Bestechung",en:"Bribery",sv:"Mutor"},{de:"Betrug",en:"Fraud",sv:"Bedrägeri"},
  {de:"Diebstahl",en:"Theft",sv:"Stöld"},{de:"Raub",en:"Robbery",sv:"Rån"},{de:"Mord",en:"Murder",sv:"Mord"},
  {de:"Totschlag",en:"Manslaughter",sv:"Dråp"},{de:"Aussage",en:"Testimony",sv:"Vittnesmål"},{de:"Verhör",en:"Interrogation",sv:"Förhör"},
  {de:"Durchsuchungsbefehl",en:"Search warrant",sv:"Husrannsakan"},{de:"Haftbefehl",en:"Arrest warrant",sv:"Häktningsbeslut"},
  {de:"Bewährung",en:"Probation",sv:"Villkorlig frigivning"},
  // Wirtschaft & Finanzen erweitert
  {de:"Bruttosozialprodukt",en:"Gross national product",sv:"Bruttonationalprodukt"},{de:"Handelsbilanz",en:"Trade balance",sv:"Handelsbalans"},
  {de:"Zahlungsbilanz",en:"Balance of payments",sv:"Betalningsbalans"},{de:"Konjunktur",en:"Economic cycle",sv:"Konjunktur"},
  {de:"Rezession",en:"Recession",sv:"Recession"},{de:"Deflation",en:"Deflation",sv:"Deflation"},{de:"Stagflation",en:"Stagflation",sv:"Stagflation"},
  {de:"Subvention",en:"Subsidy",sv:"Subvention"},{de:"Globalisierung",en:"Globalization",sv:"Globalisering"},{de:"Freihandel",en:"Free trade",sv:"Frihandel"},
  {de:"Protektionismus",en:"Protectionism",sv:"Protektionism"},{de:"Kartell",en:"Cartel",sv:"Kartell"},{de:"Monopol",en:"Monopoly",sv:"Monopol"},
  {de:"Oligopol",en:"Oligopoly",sv:"Oligopol"},{de:"Marktwirtschaft",en:"Market economy",sv:"Marknadsekonomi"},
  {de:"Planwirtschaft",en:"Planned economy",sv:"Planekonomi"},{de:"Börsencrash",en:"Stock market crash",sv:"Börskrasch"},
  {de:"Hedgefonds",en:"Hedge fund",sv:"Hedgefond"},{de:"Risikokapital",en:"Venture capital",sv:"Riskkapital"},
  {de:"Insolvenz",en:"Insolvency",sv:"Insolvens"},
  // Bauwesen & Architektur erweitert
  {de:"Tragwerk",en:"Load-bearing structure",sv:"Bärande konstruktion"},{de:"Stahlbeton",en:"Reinforced concrete",sv:"Armerad betong"},
  {de:"Holzrahmenbau",en:"Timber frame construction",sv:"Träkonstruktion"},{de:"Fassade",en:"Facade",sv:"Fasad"},
  {de:"Fensterrahmen",en:"Window frame",sv:"Fönsterram"},{de:"Türrahmen",en:"Door frame",sv:"Dörrram"},
  {de:"Estrich",en:"Screed",sv:"Avjämningsskikt"},{de:"Dämmung",en:"Insulation",sv:"Isolering"},
  {de:"Flachdach",en:"Flat roof",sv:"Platt tak"},{de:"Satteldach",en:"Gabled roof",sv:"Sadeltak"},
  {de:"Walmdach",en:"Hip roof",sv:"Valmat tak"},{de:"Dachrinne",en:"Gutter",sv:"Takränna"},
  {de:"Fallrohr",en:"Downpipe",sv:"Stupränna"},{de:"Traufe",en:"Eaves",sv:"Takfot"},
  {de:"Giebel",en:"Gable",sv:"Gavel"},{de:"Erker",en:"Bay window",sv:"Burspråk"},
  {de:"Loggia",en:"Loggia",sv:"Loggia"},{de:"Kolonnade",en:"Colonnade",sv:"Kolonnad"},
  {de:"Gewölbe",en:"Vault",sv:"Valv"},{de:"Kuppel",en:"Dome",sv:"Kupol"},
  // Wilde Tiere II
  {de:"Hyäne",en:"Hyena",sv:"Hyena"},{de:"Schakal",en:"Jackal",sv:"Schakal"},{de:"Mungo",en:"Mongoose",sv:"Mangust"},
  {de:"Erdmännchen",en:"Meerkat",sv:"Surikat"},{de:"Tapir",en:"Tapir",sv:"Tapir"},{de:"Faultier",en:"Sloth",sv:"Sengångare"},
  {de:"Ameisenbär",en:"Anteater",sv:"Myrslok"},{de:"Erdferkel",en:"Aardvark",sv:"Jordsvin"},{de:"Pangolin",en:"Pangolin",sv:"Pangolin"},
  {de:"Schnabeltier",en:"Platypus",sv:"Näbbdjur"},{de:"Känguru",en:"Kangaroo",sv:"Känguru"},{de:"Koala",en:"Koala",sv:"Koala"},
  {de:"Wombat",en:"Wombat",sv:"Wombat"},{de:"Dingo",en:"Dingo",sv:"Dingo"},{de:"Orang-Utan",en:"Orangutan",sv:"Orangutang"},
  {de:"Schimpanse",en:"Chimpanzee",sv:"Schimpans"},{de:"Bonobo",en:"Bonobo",sv:"Bonobo"},{de:"Mandrill",en:"Mandrill",sv:"Mandrill"},
  {de:"Pavian",en:"Baboon",sv:"Babian"},{de:"Makake",en:"Macaque",sv:"Makak"},
  // Meerestiere II
  {de:"Mantarochen",en:"Manta ray",sv:"Mantarocka"},{de:"Zackenbarsch",en:"Grouper",sv:"Havsabborre"},{de:"Muräne",en:"Moray eel",sv:"Murena"},
  {de:"Sägefisch",en:"Sawfish",sv:"Sågfisk"},{de:"Hammerhai",en:"Hammerhead shark",sv:"Hammarhaj"},{de:"Weißer Hai",en:"Great white shark",sv:"Vit haj"},
  {de:"Walhai",en:"Whale shark",sv:"Valhaj"},{de:"Narwal",en:"Narwhal",sv:"Narval"},{de:"Beluga",en:"Beluga whale",sv:"Vitval"},
  {de:"Orca",en:"Orca",sv:"Orca"},{de:"Seegurke",en:"Sea cucumber",sv:"Sjögurka"},
  {de:"Seeigel",en:"Sea urchin",sv:"Sjöborre"},{de:"Seeanemone",en:"Sea anemone",sv:"Havsanemone"},{de:"Korallenfisch",en:"Coral fish",sv:"Korallfisk"},
  {de:"Anglerfisch",en:"Anglerfish",sv:"Djuphavsmarulk"},{de:"Schwertschwanzkrebs",en:"Horseshoe crab",sv:"Dolksvans"},{de:"Meeresspinne",en:"Sea spider",sv:"Havsspindel"},
  {de:"Flusskrebs",en:"Crayfish",sv:"Kräfta"},{de:"Auster",en:"Oyster",sv:"Ostron"},
  // Vögel II
  {de:"Geier",en:"Vulture",sv:"Gam"},{de:"Habicht",en:"Hawk",sv:"Hök"},{de:"Falke",en:"Falcon",sv:"Falk"},
  {de:"Kondor",en:"Condor",sv:"Kondor"},{de:"Kolibri",en:"Hummingbird",sv:"Kolibri"},{de:"Papageitaucher",en:"Puffin",sv:"Lunnefågel"},
  {de:"Eisvogel",en:"Kingfisher",sv:"Kungsfiskare"},{de:"Wiedehopf",en:"Hoopoe",sv:"Härfågel"},{de:"Kuckuck",en:"Cuckoo",sv:"Gök"},
  {de:"Drossel",en:"Thrush",sv:"Trast"},{de:"Amsel",en:"Blackbird",sv:"Koltrast"},{de:"Star",en:"Starling",sv:"Stare"},
  {de:"Meise",en:"Tit",sv:"Mes"},{de:"Finke",en:"Finch",sv:"Fink"},{de:"Lerche",en:"Lark",sv:"Lärka"},
  {de:"Pirol",en:"Oriole",sv:"Guldgylling"},{de:"Schnepfe",en:"Snipe",sv:"Beckasin"},{de:"Reiher",en:"Heron",sv:"Häger"},
  {de:"Kranich",en:"Crane",sv:"Trana"},{de:"Bussard",en:"Buzzard",sv:"Ormvråk"},
  // Insekten II
  {de:"Termite",en:"Termite",sv:"Termit"},{de:"Gottesanbeterin",en:"Praying mantis",sv:"Bönsyrsa"},{de:"Tausendfüßer",en:"Centipede",sv:"Tusenfoting"},
  {de:"Tausendbein",en:"Millipede",sv:"Tusenbening"},{de:"Floh",en:"Flea",sv:"Loppa"},{de:"Laus",en:"Louse",sv:"Lus"},
  {de:"Wanze",en:"Bug",sv:"Skinnbagge"},{de:"Maulwurfsgrille",en:"Mole cricket",sv:"Mullvadssyrsa"},{de:"Glühwürmchen",en:"Firefly",sv:"Eldfluga"},
  {de:"Schnake",en:"Crane fly",sv:"Harkrank"},{de:"Blattlaus",en:"Aphid",sv:"Bladlus"},{de:"Schildlaus",en:"Scale insect",sv:"Sköldlus"},
  {de:"Hornisse",en:"Hornet",sv:"Bålgeting"},{de:"Hummel",en:"Bumblebee",sv:"Humla"},{de:"Weidenmücke",en:"Gall midge",sv:"Gallmygga"},
  {de:"Stabheuschrecke",en:"Stick insect",sv:"Vandrande pinne"},{de:"Nashornkäfer",en:"Rhinoceros beetle",sv:"Noshornsskalbagge"},
  {de:"Marienkäfer",en:"Ladybug",sv:"Nyckelpiga"},{de:"Getreidekäfer",en:"Grain beetle",sv:"Spannmålsskalbagge"},
  {de:"Kellerasseln",en:"Woodlouse",sv:"Gråsugga"},
  // Pflanzen & Bäume II
  {de:"Lorbeer",en:"Bay laurel",sv:"Lagerträd"},{de:"Wacholder",en:"Juniper",sv:"En"},{de:"Thuja",en:"Thuja",sv:"Tuja"},
  {de:"Zypresse",en:"Cypress",sv:"Cypress"},{de:"Magnolie",en:"Magnolia",sv:"Magnolia"},{de:"Mimose",en:"Mimosa",sv:"Mimosa"},
  {de:"Akazie",en:"Acacia",sv:"Akacia"},{de:"Eukalyptus",en:"Eucalyptus",sv:"Eukalyptus"},{de:"Sequoia",en:"Sequoia",sv:"Sekvoja"},
  {de:"Mangrove",en:"Mangrove",sv:"Mangrove"},{de:"Kork",en:"Cork oak",sv:"Korkek"},{de:"Olive",en:"Olive tree",sv:"Olivträd"},
  {de:"Granatapfelbaum",en:"Pomegranate tree",sv:"Granatäppleträd"},{de:"Zitronenbaum",en:"Lemon tree",sv:"Citronträd"},
  {de:"Apfelbaum",en:"Apple tree",sv:"Äppelträd"},{de:"Birnbaum",en:"Pear tree",sv:"Päronträd"},{de:"Pflaumenbaum",en:"Plum tree",sv:"Plommonträd"},
  {de:"Maulbeerbaum",en:"Mulberry tree",sv:"Mullbärsträd"},{de:"Erle",en:"Alder",sv:"Al"},
  // Blumen II
  {de:"Dahlie",en:"Dahlia",sv:"Dahlia"},{de:"Begonie",en:"Begonia",sv:"Begonia"},{de:"Petunie",en:"Petunia",sv:"Petunia"},
  {de:"Geranie",en:"Geranium",sv:"Pelargon"},{de:"Fuchsie",en:"Fuchsia",sv:"Fuchsia"},{de:"Iris",en:"Iris",sv:"Iris"},
  {de:"Lupine",en:"Lupine",sv:"Lupin"},{de:"Vergissmeinnicht",en:"Forget-me-not",sv:"Förgätmigej"},{de:"Ringelblume",en:"Marigold",sv:"Ringblomma"},
  {de:"Studentenblume",en:"Tagetes",sv:"Tagetes"},{de:"Impatiens",en:"Impatiens",sv:"Flitiga lisa"},{de:"Stockrose",en:"Hollyhock",sv:"Stockros"},
  {de:"Rittersporn",en:"Delphinium",sv:"Riddarsporre"},{de:"Phlox",en:"Phlox",sv:"Flox"},{de:"Clematis",en:"Clematis",sv:"Klematis"},
  {de:"Wisterie",en:"Wisteria",sv:"Blåregn"},{de:"Pfingstrose",en:"Peony",sv:"Pion"},{de:"Taglilie",en:"Daylily",sv:"Daglilja"},
  {de:"Margerite",en:"Daisy",sv:"Prästkrage"},{de:"Kornblume",en:"Cornflower",sv:"Blåklint"},
  // Gewürze & Kräuter II
  {de:"Koriander",en:"Coriander",sv:"Koriander"},{de:"Petersilie",en:"Parsley",sv:"Persilja"},{de:"Schnittlauch",en:"Chives",sv:"Gräslök"},
  {de:"Dill",en:"Dill",sv:"Dill"},{de:"Minze",en:"Mint",sv:"Mynta"},{de:"Salbei",en:"Sage",sv:"Salvia"},
  {de:"Majoran",en:"Marjoram",sv:"Mejram"},{de:"Estragon",en:"Tarragon",sv:"Dragon"},{de:"Bohnenkraut",en:"Savory",sv:"Kyndel"},
  {de:"Fenchelsamen",en:"Fennel seed",sv:"Fänkålsfrö"},{de:"Kardamom",en:"Cardamom",sv:"Kardemumma"},{de:"Safran",en:"Saffron",sv:"Saffran"},
  {de:"Vanille",en:"Vanilla",sv:"Vanilj"},{de:"Kümmel",en:"Caraway",sv:"Kummin"},{de:"Anis",en:"Anise",sv:"Anis"},
  {de:"Sternanis",en:"Star anise",sv:"Stjärnanis"},{de:"Szechuan-Pfeffer",en:"Sichuan pepper",sv:"Sichuanpeppar"},{de:"Sumach",en:"Sumac",sv:"Sumak"},
  {de:"Bockshornklee",en:"Fenugreek",sv:"Bockhornsklöver"},{de:"Asafoetida",en:"Asafoetida",sv:"Asfetida"},
  // Backwaren & Konditorei
  {de:"Eclair",en:"Éclair",sv:"Éclair"},{de:"Macaron",en:"Macaron",sv:"Macaron"},{de:"Palmier",en:"Palmier",sv:"Palmier"},
  {de:"Brioche",en:"Brioche",sv:"Brioche"},{de:"Ciabatta",en:"Ciabatta",sv:"Ciabatta"},{de:"Focaccia",en:"Focaccia",sv:"Focaccia"},
  {de:"Baumkuchen",en:"Baumkuchen",sv:"Baumkuchen"},{de:"Lebkuchen",en:"Gingerbread",sv:"Pepparkaka"},{de:"Stollen",en:"Stollen",sv:"Julkaka"},
  {de:"Hefezopf",en:"Braided bread",sv:"Flätat bröd"},{de:"Rosinenbrot",en:"Raisin bread",sv:"Russinbröd"},{de:"Vollkornbrot",en:"Whole grain bread",sv:"Fullkornsbröd"},
  {de:"Pumpernickel",en:"Pumpernickel",sv:"Pumpernickel"},{de:"Knäckebrot",en:"Crispbread",sv:"Knäckebröd"},{de:"Laugenstange",en:"Pretzel stick",sv:"Saltstång"},
  {de:"Streuselkuchen",en:"Crumble cake",sv:"Smulpaj"},{de:"Bienenstich",en:"Bee sting cake",sv:"Bistick"},{de:"Schwarzwälder Kirschtorte",en:"Black Forest cake",sv:"Schwarzwaldtårta"},
  {de:"Tiramisu",en:"Tiramisu",sv:"Tiramisu"},{de:"Panna Cotta",en:"Panna cotta",sv:"Panna cotta"},
  // Fleisch & Fisch II
  {de:"Kalbsschnitzel",en:"Veal cutlet",sv:"Kalvschnitzel"},{de:"Schweinekotelett",en:"Pork chop",sv:"Fläskkotlett"},
  {de:"Rindergulasch",en:"Beef goulash",sv:"Nötgulasch"},{de:"Lammkeule",en:"Leg of lamb",sv:"Lammlägg"},
  {de:"Gans",en:"Goose",sv:"Gås"},
  {de:"Fasan",en:"Pheasant",sv:"Fasan"},{de:"Rehkeule",en:"Venison haunch",sv:"Rådjurslägg"},{de:"Wildschweinkeule",en:"Wild boar haunch",sv:"Vildsvinsstek"},
  {de:"Jakobsmuschel",en:"Scallop",sv:"Pilgrimsmussla"},{de:"Venusmuschel",en:"Clam",sv:"Hjärtmussla"},
  {de:"Riesengarnele",en:"Prawn",sv:"Jätteräka"},{de:"Languste",en:"Spiny lobster",sv:"Langust"},
  {de:"Heilbutt",en:"Halibut",sv:"Hälleflundra"},{de:"Rotbarsch",en:"Redfish",sv:"Rödfisk"},
  {de:"Brasse",en:"Bream",sv:"Braxen"},{de:"Zander",en:"Pike-perch",sv:"Gös"},
  {de:"Stint",en:"Smelt",sv:"Nors"},{de:"Strömmling",en:"Baltic herring",sv:"Strömming"},
  // Süßigkeiten II
  {de:"Pralinen-Schachtel",en:"Box of chocolates",sv:"Chokladask"},{de:"Trüffel",en:"Chocolate truffle",sv:"Chokladtryffel"},
  {de:"Fudge",en:"Fudge",sv:"Fudge"},{de:"Halva",en:"Halva",sv:"Halva"},{de:"Türkischer Honig",en:"Turkish delight",sv:"Turkisk honung"},
  {de:"Zuckerwatte",en:"Candy floss",sv:"Sockervadd"},{de:"Krokant",en:"Brittle",sv:"Krokant"},
  {de:"Mohnkuchen",en:"Poppy seed cake",sv:"Vallmokaka"},{de:"Strudel",en:"Strudel",sv:"Strudel"},
  {de:"Baklava",en:"Baklava",sv:"Baklava"},{de:"Churros",en:"Churros",sv:"Churros"},{de:"Crème brûlée",en:"Crème brûlée",sv:"Crème brûlée"},
  {de:"Soufflé",en:"Soufflé",sv:"Soufflé"},{de:"Pannacotta",en:"Pannacotta",sv:"Pannacotta"},
  {de:"Mousse au Chocolat",en:"Chocolate mousse",sv:"Chokladmousse"},
  // Werkzeuge & Heimwerken erweitert
  {de:"Winkelschleifer",en:"Angle grinder",sv:"Vinkelslip"},{de:"Stichsäge",en:"Jigsaw",sv:"Sticksåg"},
  {de:"Kreissäge",en:"Circular saw",sv:"Cirkelsåg"},{de:"Kettensäge",en:"Chainsaw",sv:"Motorsåg"},
  {de:"Fuchsschwanz",en:"Handsaw",sv:"Ryggsåg"},{de:"Bügelsäge",en:"Hacksaw",sv:"Bågfilsåg"},
  {de:"Stechbeitel",en:"Wood chisel",sv:"Stämjärn"},{de:"Raspel",en:"Rasp",sv:"Raspfil"},
  {de:"Drahtbürste",en:"Wire brush",sv:"Stålborste"},{de:"Schleifpapier",en:"Abrasive paper",sv:"Slippapper"},
  {de:"Lackierpistole",en:"Spray gun",sv:"Lackpistol"},
  {de:"Rolle",en:"Paint roller",sv:"Färgroller"},{de:"Abdeckband",en:"Masking tape",sv:"Maskeringstejp"},
  {de:"Dübel",en:"Rawlplug",sv:"Plugg"},{de:"Schraube",en:"Screw",sv:"Skruv"},
  {de:"Bolzen",en:"Bolt",sv:"Bult"},
  {de:"Unterlegscheibe",en:"Washer",sv:"Bricka"},
  // Elektrogeräte & Haushalt II
  {de:"Brotschneidemaschine",en:"Bread slicer",sv:"Brödsåg"},{de:"Entsafter",en:"Juicer",sv:"Juicepress"},
  {de:"Eismaschine",en:"Ice cream maker",sv:"Glassmaskin"},{de:"Pastamaschine",en:"Pasta machine",sv:"Pastamaskin"},
  {de:"Brotbackautomat",en:"Bread machine",sv:"Brödmaskin"},{de:"Dampfgarer",en:"Steamer",sv:"Ångkokare"},
  {de:"Fritteuse",en:"Deep fryer",sv:"Fritös"},{de:"Heißluftfritteuse",en:"Air fryer",sv:"Airfryer"},
  {de:"Vakuumierer",en:"Vacuum sealer",sv:"Vakuumförpackare"},{de:"Nähmaschine",en:"Sewing machine",sv:"Symaskin"},
  {de:"Staubwischer",en:"Dust remover",sv:"Dammvippa"},{de:"Luftreiniger",en:"Air purifier",sv:"Luftrenare"},
  {de:"Luftbefeuchter",en:"Humidifier",sv:"Luftfuktare"},{de:"Heizlüfter",en:"Fan heater",sv:"Fläktvärmaren"},
  {de:"Wärmflasche",en:"Hot water bottle",sv:"Värmflaska"},
  // Textilien & Mode
  {de:"Fleece",en:"Fleece",sv:"Fleece"},{de:"Gore-Tex",en:"Gore-Tex",sv:"Gore-Tex"},
  {de:"Mesh",en:"Mesh",sv:"Mesh"},{de:"Chenille",en:"Chenille",sv:"Chenille"},{de:"Tweed",en:"Tweed",sv:"Tweed"},
  {de:"Organza",en:"Organza",sv:"Organza"},{de:"Chiffon",en:"Chiffon",sv:"Chiffon"},{de:"Tüll",en:"Tulle",sv:"Tyll"},
  {de:"Spitze",en:"Lace",sv:"Spets"},{de:"Kord",en:"Corduroy",sv:"Manchester"},
  {de:"Flanell",en:"Flannel",sv:"Flanell"},{de:"Frottee",en:"Terry cloth",sv:"Frotté"},
  {de:"Viskose",en:"Viscose",sv:"Viskos"},{de:"Kaschmir",en:"Cashmere",sv:"Kashmir"},
  {de:"Angora",en:"Angora",sv:"Angora"},{de:"Alpaka",en:"Alpaca",sv:"Alpacka"},
  {de:"Hanf",en:"Hemp",sv:"Hampa"},{de:"Bambusfaser",en:"Bamboo fiber",sv:"Bambusfiber"},
  {de:"Mikrofaser",en:"Microfiber",sv:"Mikrofiber"},{de:"Elasthan",en:"Elastane",sv:"Elastan"},
  // Schmuck & Edelsteine
  {de:"Smaragd",en:"Emerald",sv:"Smaragd"},{de:"Rubin",en:"Ruby",sv:"Rubin"},
  {de:"Saphir",en:"Sapphire",sv:"Safir"},{de:"Amethyst",en:"Amethyst",sv:"Ametist"},
  {de:"Topas",en:"Topaz",sv:"Topas"},{de:"Opal",en:"Opal",sv:"Opal"},
  {de:"Bernstein",en:"Amber",sv:"Bärnsten"},
  {de:"Jade",en:"Jade",sv:"Jade"},
  {de:"Achat",en:"Agate",sv:"Agat"},{de:"Malachit",en:"Malachite",sv:"Malakit"},
  {de:"Granat",en:"Garnet",sv:"Granat"},{de:"Quarz",en:"Quartz",sv:"Kvarts"},
  {de:"Mondstein",en:"Moonstone",sv:"Månsten"},{de:"Onyx",en:"Onyx",sv:"Onyx"},
  {de:"Lapislazuli",en:"Lapis lazuli",sv:"Lasursten"},{de:"Roségold",en:"Rose gold",sv:"Roséguld"},
  {de:"Weißgold",en:"White gold",sv:"Vitguld"},{de:"Platin",en:"Platinum",sv:"Platina"},
  // Kosmetik & Körperpflege II
  {de:"Gesichtsmaske",en:"Face mask",sv:"Ansiktsmask"},{de:"Peeling",en:"Exfoliant",sv:"Peeling"},
  {de:"Serum",en:"Serum",sv:"Serum"},{de:"Toner",en:"Toner",sv:"Toner"},
  {de:"Feuchtigkeitscreme",en:"Moisturizer",sv:"Fuktighetskräm"},{de:"Augencreme",en:"Eye cream",sv:"Ögonkräm"},
  {de:"Lippenbalsam",en:"Lip balm",sv:"Läppbalsam"},{de:"Selbstbräuner",en:"Self-tanner",sv:"Självbrunande kräm"},
  {de:"Haarkur",en:"Hair treatment",sv:"Hårkur"},{de:"Haarspülung",en:"Conditioner",sv:"Hårbalsam"},
  {de:"Haargel",en:"Hair gel",sv:"Hårgel"},{de:"Haarlack",en:"Hairspray",sv:"Hårspray"},
  {de:"Haarbürste",en:"Hairbrush",sv:"Hårborste"},{de:"Kamm",en:"Comb",sv:"Kam"},
  {de:"Lippenpflege",en:"Lip care",sv:"Läppvård"},{de:"BB-Cream",en:"BB cream",sv:"BB-kräm"},
  {de:"Konturpuder",en:"Contour powder",sv:"Kontourpuder"},
  {de:"Nagelfeile",en:"Nail file",sv:"Nagelfil"},{de:"Wimpernzange",en:"Eyelash curler",sv:"Ögonvipptång"},
  // Garten & Gartenarbeit
  {de:"Hochbeet",en:"Raised bed",sv:"Upphöjd odlingsbädd"},{de:"Frühbeet",en:"Cold frame",sv:"Drivbänk"},
  {de:"Bewässerungssystem",en:"Irrigation system",sv:"Bevattningssystem"},{de:"Tropfbewässerung",en:"Drip irrigation",sv:"Droppbevattning"},
  {de:"Mulch",en:"Mulch",sv:"Marktäckningsmaterial"},{de:"Komposthaufen",en:"Compost heap",sv:"Komposthög"},
  {de:"Pflanzkübel",en:"Planter",sv:"Planteringskärl"},{de:"Hängekorb",en:"Hanging basket",sv:"Hängkorg"},
  {de:"Rankgitter",en:"Trellis",sv:"Spaljé"},{de:"Pfahl",en:"Stake",sv:"Påle"},
  {de:"Pflanzerde",en:"Potting soil",sv:"Krukmull"},{de:"Torf",en:"Peat",sv:"Torv"},
  {de:"Grassamen",en:"Grass seed",sv:"Gräsfrö"},{de:"Rasendünger",en:"Lawn fertilizer",sv:"Gräsmattegödning"},
  {de:"Heckenschere",en:"Hedge trimmer",sv:"Häcksax"},{de:"Baumschere",en:"Loppers",sv:"Grensax"},
  {de:"Spaten",en:"Spade",sv:"Spade"},{de:"Gartengabel",en:"Garden fork",sv:"Trädgårdsgaffel"},
  {de:"Pflanzstecher",en:"Dibber",sv:"Planteringspinne"},{de:"Knieschoner",en:"Knee pad",sv:"Knäskydd"},
  // Camping & Outdoor II
  {de:"Klettergurt",en:"Climbing harness",sv:"Klättersele"},{de:"Karabiner",en:"Carabiner",sv:"Karbinhake"},
  {de:"Pickel",en:"Ice axe",sv:"Ishacka"},{de:"Steigeisen",en:"Crampons",sv:"Stegjärn"},
  {de:"Wanderstiefel",en:"Hiking boots",sv:"Vandringsskor"},{de:"Trekkingstöcke",en:"Trekking poles",sv:"Vandringsstavar"},
  {de:"Gamaschen",en:"Gaiters",sv:"Damasker"},{de:"Rucksackdeckel",en:"Backpack lid",sv:"Ryggsäckslock"},
  {de:"Trinkblase",en:"Hydration bladder",sv:"Vattenpåse"},{de:"Trinkflasche",en:"Water bottle",sv:"Vattenflaska"},
  {de:"Kopflampe",en:"Headlamp",sv:"Pannlampa"},{de:"Feuerstarter",en:"Fire starter",sv:"Eldningsstarter"},
  {de:"Notfallpfeife",en:"Emergency whistle",sv:"Nödpipa"},{de:"Rettungsdecke",en:"Emergency blanket",sv:"Räddningsfilt"},
  {de:"Sonnenschutz",en:"Sun protection",sv:"Solskydd"},{de:"Insektenschutz",en:"Insect repellent",sv:"Insektsskydd"},
  {de:"Erste-Hilfe-Set",en:"First aid kit",sv:"Förstahälpslåda"},{de:"Signalrakete",en:"Signal flare",sv:"Signalraketen"},
  {de:"Rettungsseil",en:"Rescue rope",sv:"Räddningsrep"},{de:"Lawinenairbag",en:"Avalanche airbag",sv:"Lavinairbag"},
  // Fotografie & Film
  {de:"Kamerabody",en:"Camera body",sv:"Kamerahus"},{de:"Weitwinkelobjektiv",en:"Wide-angle lens",sv:"Vidvinkelobjektiv"},
  {de:"Teleobjektiv",en:"Telephoto lens",sv:"Teleobjektiv"},{de:"Makroobjektiv",en:"Macro lens",sv:"Makroobjektiv"},
  {de:"Festbrennweite",en:"Prime lens",sv:"Fast brännvidd"},{de:"Zoomobjektiv",en:"Zoom lens",sv:"Zoomobjektiv"},
  {de:"Blende",en:"Aperture",sv:"Bländare"},{de:"Verschlusszeit",en:"Shutter speed",sv:"Slutartid"},
  {de:"ISO-Wert",en:"ISO value",sv:"ISO-värde"},{de:"Weißabgleich",en:"White balance",sv:"Vitbalans"},
  {de:"Schärfentiefe",en:"Depth of field",sv:"Skärpedjup"},{de:"Bokeh",en:"Bokeh",sv:"Bokeh"},
  {de:"RAW-Datei",en:"RAW file",sv:"RAW-fil"},{de:"Bildbearbeitung",en:"Photo editing",sv:"Bildredigering"},
  {de:"Bildkomposition",en:"Photo composition",sv:"Bildkomposition"},{de:"Goldener Schnitt",en:"Golden ratio",sv:"Gyllene snittet"},
  {de:"Belichtungsmesser",en:"Light meter",sv:"Exponeringsmätare"},{de:"Polfilter",en:"Polarizing filter",sv:"Polarisationsfilter"},
  {de:"ND-Filter",en:"ND filter",sv:"ND-filter"},{de:"Gegenlichtblende",en:"Lens hood",sv:"Motljusskydd"},
  // Film & Produktion
  {de:"Kameramann",en:"Cameraman",sv:"Kameraman"},{de:"Produzent",en:"Producer",sv:"Producent"},
  {de:"Schnitt",en:"Editing",sv:"Klippning"},{de:"Schnittmeister",en:"Film editor",sv:"Klippare"},
  {de:"Special Effects",en:"Special effects",sv:"Specialeffekter"},{de:"CGI",en:"CGI",sv:"CGI"},
  {de:"Stuntman",en:"Stuntman",sv:"Stuntman"},{de:"Maskenbildner",en:"Make-up artist",sv:"Maskör"},
  {de:"Beleuchter",en:"Lighting technician",sv:"Ljusättare"},{de:"Tonmeister",en:"Sound engineer",sv:"Ljudtekniker"},
  {de:"Synchronsprecher",en:"Voice actor",sv:"Röstskådespelare"},{de:"Drehbuchautor",en:"Screenwriter",sv:"Manusförfattare"},
  {de:"Filmfestival",en:"Film festival",sv:"Filmfestival"},{de:"Oskar",en:"Oscar",sv:"Oscar"},
  {de:"Berlinale",en:"Berlinale",sv:"Berlinale"},{de:"Cannes",en:"Cannes",sv:"Cannes"},
  {de:"Genrefilm",en:"Genre film",sv:"Genrefilm"},{de:"Kurzfilm",en:"Short film",sv:"Kortfilm"},
  {de:"Spielfilm",en:"Feature film",sv:"Långfilm"},{de:"Animationsfilm",en:"Animated film",sv:"Animerad film"},
  // Wintersport II
  {de:"Abfahrtslauf",en:"Downhill skiing",sv:"Störtlopp"},{de:"Slalom",en:"Slalom",sv:"Slalom"},
  {de:"Riesenslalom",en:"Giant slalom",sv:"Storslalom"},{de:"Super-G",en:"Super-G",sv:"Super-G"},
  {de:"Freestyle-Skiing",en:"Freestyle skiing",sv:"Freestyle-skidåkning"},{de:"Halfpipe",en:"Halfpipe",sv:"Halfpipe"},
  {de:"Snowpark",en:"Snow park",sv:"Snowpark"},{de:"Nordische Kombination",en:"Nordic combined",sv:"Nordisk kombination"},
  {de:"Eisschnelllauf",en:"Speed skating",sv:"Skridskoåkning"},{de:"Shorttrack",en:"Short track",sv:"Kortbana"},
  {de:"Eishockey",en:"Ice hockey",sv:"Ishockey"},{de:"Curlingstein",en:"Curling stone",sv:"Curlingsten"},
  {de:"Schneeschuh",en:"Snowshoe",sv:"Snösko"},{de:"Pulka",en:"Pulk",sv:"Pulka"},
  {de:"Skisprungschanze",en:"Ski jump ramp",sv:"Backhoppningsramp"},{de:"Loipe",en:"Cross-country ski trail",sv:"Skidspår"},
  {de:"Pistenraupe",en:"Snow groomer",sv:"Pistmaskin"},{de:"Skilift",en:"Ski lift",sv:"Skidlift"},
  {de:"Gondel",en:"Gondola",sv:"Gondol"},{de:"Sessellift",en:"Chairlift",sv:"Stolslift"},
  // Wassersport II
  {de:"Kitesurfen",en:"Kitesurfing",sv:"Kitesurfning"},{de:"Wakeboarden",en:"Wakeboarding",sv:"Wakeboarding"},
  {de:"Wildwasserrafting",en:"White water rafting",sv:"Forsränning"},{de:"Stand-Up-Paddling",en:"Stand-up paddling",sv:"Ståpadling"},
  {de:"Freiwasserschwimmen",en:"Open water swimming",sv:"Öppet vattensimning"},{de:"Triathlon",en:"Triathlon",sv:"Triathlon"},
  {de:"Wasserski",en:"Water skiing",sv:"Vattenskidåkning"},{de:"Tubing",en:"Tubing",sv:"Tubing"},
  {de:"Tauchwand",en:"Diving wall",sv:"Dykväggen"},{de:"Tauchflasche",en:"Diving tank",sv:"Dyktub"},
  {de:"Atemregler",en:"Regulator",sv:"Andningsregulator"},{de:"Tauchmaske",en:"Diving mask",sv:"Dykmask"},
  {de:"Neoprenanzug",en:"Wetsuit",sv:"Våtdräkt"},{de:"Flossen",en:"Fins",sv:"Fenor"},
  {de:"Schnorchelset",en:"Snorkel set",sv:"Snorkelset"},{de:"Druckmesser",en:"Pressure gauge",sv:"Tryckmätare"},
  {de:"Tauchcomputer",en:"Dive computer",sv:"Dykdator"},{de:"Navigationsboje",en:"Navigation buoy",sv:"Navigationsboj"},
  {de:"Unterwasserkamera",en:"Underwater camera",sv:"Undervattenskamera"},{de:"Gezeiten",en:"Tides",sv:"Tidvatten"},
  // Weitere Wissenschaftsbegriffe
  {de:"Nanotechnologie",en:"Nanotechnology",sv:"Nanoteknik"},{de:"Biotechnologie",en:"Biotechnology",sv:"Bioteknik"},
  {de:"Gentechnik",en:"Genetic engineering",sv:"Genteknik"},{de:"Klonierung",en:"Cloning",sv:"Kloning"},
  {de:"Stammzellen",en:"Stem cells",sv:"Stamceller"},{de:"DNS",en:"DNA",sv:"DNA"},
  {de:"Chromosom",en:"Chromosome",sv:"Kromosom"},{de:"Gen",en:"Gene",sv:"Gen"},
  {de:"Mutation",en:"Mutation",sv:"Mutation"},{de:"Ökosystem",en:"Ecosystem",sv:"Ekosystem"},
  {de:"Nahrungskette",en:"Food chain",sv:"Näringskedja"},{de:"Symbiose",en:"Symbiosis",sv:"Symbiosis"},
  {de:"Parasit",en:"Parasite",sv:"Parasit"},{de:"Wirt",en:"Host",sv:"Värd"},{de:"Räuber",en:"Predator",sv:"Rovdjur"},
  {de:"Neuronenübertragung",en:"Neural transmission",sv:"Neuronal transmission"},{de:"Synapse",en:"Synapse",sv:"Synaps"},
  {de:"Neurotransmitter",en:"Neurotransmitter",sv:"Neurotransmittor"},{de:"Reflex",en:"Reflex",sv:"Reflex"},
  {de:"Homöostase",en:"Homeostasis",sv:"Homeostas"},
  // Geografie & Geologie
  {de:"Erdrinde",en:"Earth's crust",sv:"Jordskorpa"},{de:"Erdmantel",en:"Earth's mantle",sv:"Jordmantel"},
  {de:"Erdkern",en:"Earth's core",sv:"Jordens kärna"},{de:"Tektonische Platten",en:"Tectonic plates",sv:"Tektoniska plattor"},
  {de:"Seismograph",en:"Seismograph",sv:"Seismograf"},{de:"Richter-Skala",en:"Richter scale",sv:"Richterskalan"},
  {de:"Gestein",en:"Rock",sv:"Bergarter"},{de:"Kristall",en:"Crystal",sv:"Kristall"},
  {de:"Magma",en:"Magma",sv:"Magma"},{de:"Lava",en:"Lava",sv:"Lava"},{de:"Asche",en:"Ash",sv:"Aska"},
  {de:"Erdspalte",en:"Rift",sv:"Spricka"},{de:"Subduktion",en:"Subduction",sv:"Subduktion"},
  {de:"Golfstrom",en:"Gulf Stream",sv:"Golfströmmen"},{de:"El Niño",en:"El Niño",sv:"El Niño"},
  {de:"Permafrost",en:"Permafrost",sv:"Permafrost"},{de:"Polkappe",en:"Polar ice cap",sv:"Polarkapp"},
  {de:"Meeresströmung",en:"Ocean current",sv:"Havsström"},{de:"Kontinentaldrift",en:"Continental drift",sv:"Kontinentalrörelse"},
  // Astronomie II
  {de:"Schwarzes Loch",en:"Black hole",sv:"Svart hål"},
  {de:"Neutronenstern",en:"Neutron star",sv:"Neutron stjärna"},{de:"Supernova",en:"Supernova",sv:"Supernova"},
  {de:"Pulsare",en:"Pulsar",sv:"Pulsar"},{de:"Quasar",en:"Quasar",sv:"Kvazar"},
  {de:"Dunkle Materie",en:"Dark matter",sv:"Mörk materia"},{de:"Dunkle Energie",en:"Dark energy",sv:"Mörk energi"},
  {de:"Roten Riesen",en:"Red giant",sv:"Röd jätte"},{de:"Weißer Zwerg",en:"White dwarf",sv:"Vit dvärg"},
  {de:"Lichtyear",en:"Light year",sv:"Ljusår"},{de:"Parallaxe",en:"Parallax",sv:"Parallax"},
  {de:"Rotation",en:"Rotation",sv:"Rotation"},
  {de:"Gezeiteneffekt",en:"Tidal effect",sv:"Tidvatteneffekt"},{de:"Raumzeit",en:"Spacetime",sv:"Rumtid"},
  {de:"Singularität",en:"Singularity",sv:"Singularitet"},{de:"Horizont",en:"Event horizon",sv:"Händelsehorisont"},
  {de:"Infrarot",en:"Infrared",sv:"Infraröd"},{de:"Ultraviolett",en:"Ultraviolet",sv:"Ultraviolett"},
  // Medizin - Anatomie & weitere Begriffe
  {de:"Gebärmutter",en:"Uterus",sv:"Livmoder"},{de:"Eierstock",en:"Ovary",sv:"Äggstock"},
  {de:"Harnblase",en:"Bladder",sv:"Urinblåsa"},{de:"Gallenblase",en:"Gallbladder",sv:"Gallblåsa"},
  {de:"Milz",en:"Spleen",sv:"Mjälte"},{de:"Bauchspeicheldrüse",en:"Pancreas",sv:"Bukspottkörtel"},
  {de:"Niere",en:"Kidney",sv:"Njure"},{de:"Darm",en:"Intestine",sv:"Tarm"},
  {de:"Dickdarm",en:"Large intestine",sv:"Tjocktarm"},{de:"Dünndarm",en:"Small intestine",sv:"Tunntarm"},
  {de:"Speiseröhre",en:"Esophagus",sv:"Matstrupe"},{de:"Luftröhre",en:"Trachea",sv:"Luftstrupe"},
  {de:"Bronchien",en:"Bronchi",sv:"Bronker"},{de:"Alveolen",en:"Alveoli",sv:"Luftblåsor"},
  {de:"Lymphknoten",en:"Lymph node",sv:"Lymfkörtel"},{de:"Knochenmark",en:"Bone marrow",sv:"Benmärg"},
  {de:"Hornhaut",en:"Cornea",sv:"Hornhinna"},{de:"Netzhaut",en:"Retina",sv:"Näthinna"},
  {de:"Trommelfell",en:"Eardrum",sv:"Trumhinna"},{de:"Stimmbänder",en:"Vocal cords",sv:"Stämband"},
  // Gesellschaft & Soziales
  {de:"Sozialhilfe",en:"Social welfare",sv:"Socialbidrag"},{de:"Arbeitsamt",en:"Employment office",sv:"Arbetsförmedling"},
  {de:"Kindergeld",en:"Child benefit",sv:"Barnbidrag"},{de:"Elterngeld",en:"Parental allowance",sv:"Föräldrapenning"},
  {de:"Mutterschutz",en:"Maternity leave",sv:"Moderskapslätt"},{de:"Pflegeheim",en:"Nursing home",sv:"Äldreboende"},
  {de:"Obdachlosigkeit",en:"Homelessness",sv:"Hemlöshet"},{de:"Armut",en:"Poverty",sv:"Fattigdom"},
  {de:"Reichtum",en:"Wealth",sv:"Rikedom"},{de:"Ungleichheit",en:"Inequality",sv:"Ojämlikhet"},
  {de:"Solidarität",en:"Solidarity",sv:"Solidaritet"},{de:"Ehrenamt",en:"Volunteering",sv:"Volontärarbete"},
  {de:"Bürgerinitiative",en:"Citizen initiative",sv:"Medborgarinitiativ"},{de:"Petition",en:"Petition",sv:"Petition"},
  {de:"Demonstration",en:"Demonstration",sv:"Demonstration"},{de:"Streik",en:"Strike",sv:"Strejk"},
  {de:"Gewerkschaft",en:"Trade union",sv:"Fackförbund"},{de:"Arbeitgeberverband",en:"Employer association",sv:"Arbetsgivarförening"},
  {de:"Tarifvertrag",en:"Collective agreement",sv:"Kollektivavtal"},{de:"Mindestlohn",en:"Minimum wage",sv:"Minimilön"},
  // Freizeit, Spielzeug & Spiele
  {de:"Brettspiel",en:"Board game",sv:"Sällskapsspel"},{de:"Schach",en:"Chess",sv:"Schack"},
  {de:"Dame",en:"Checkers",sv:"Dam"},{de:"Backgammon",en:"Backgammon",sv:"Backgammon"},
  {de:"Monopoly",en:"Monopoly",sv:"Monopol"},{de:"Puzzlespiel",en:"Puzzle",sv:"Pussel"},
  {de:"Kartenspiel",en:"Card game",sv:"Kortspiel"},{de:"Würfelspiel",en:"Dice game",sv:"Tärningsspel"},
  {de:"Rollenspiel",en:"Role-playing game",sv:"Rollspel"},{de:"Videospiel",en:"Video game",sv:"Tv-spiel"},
  {de:"Konsole",en:"Console",sv:"Konsol"},{de:"Controller",en:"Controller",sv:"Handkontroll"},
  {de:"Spielfigur",en:"Game piece",sv:"Spelpjäs"},{de:"Baustein",en:"Building block",sv:"Byggkloss"},
  {de:"Teddybär",en:"Teddy bear",sv:"Nalle"},{de:"Puppe",en:"Doll",sv:"Docka"},
  {de:"Playmobil",en:"Playmobil",sv:"Playmobil"},{de:"Modellauto",en:"Model car",sv:"Modellauto"},
  {de:"Drohne",en:"Drone",sv:"Drönare"},{de:"Ferngesteuertes Auto",en:"Remote-controlled car",sv:"Radiostyrd bil"},
  // Schule & Bildung II
  {de:"Zirkel",en:"Compass",sv:"Passare"},
  {de:"Winkelmesser",en:"Protractor",sv:"Vinkelmätare"},{de:"Schulranzen",en:"School bag",sv:"Skolväska"},
  {de:"Schultasche",en:"Satchel",sv:"Portfölj"},{de:"Mäppchen",en:"Pencil case",sv:"Pennfodral"},
  {de:"Schuluniform",en:"School uniform",sv:"Skoluniform"},{de:"Stundenplan",en:"Timetable",sv:"Schema"},
  {de:"Notenbuch",en:"Gradebook",sv:"Betygsbok"},{de:"Klassenbuch",en:"Class register",sv:"Klassbok"},
  {de:"Projektor",en:"Projector",sv:"Projektor"},{de:"Whiteboard",en:"Whiteboard",sv:"Whiteboard"},
  {de:"Kreide",en:"Chalk",sv:"Krita"},{de:"Overhead",en:"Overhead projector",sv:"Overheadprojektor"},
  {de:"Lernkarte",en:"Flashcard",sv:"Minneskort"},{de:"Grammatikübung",en:"Grammar exercise",sv:"Grammatikövning"},
  {de:"Diktat",en:"Dictation",sv:"Diktamen"},{de:"Aufsatz",en:"Composition",sv:"Uppsats"},
  {de:"Klassenarbeit",en:"Class test",sv:"Klassarbete"},{de:"Abitur",en:"School-leaving exam",sv:"Studentexamen"},
  // Küche & Kochrezepte
  {de:"Zutaten",en:"Ingredients",sv:"Ingredienser"},
  {de:"Portionsgröße",en:"Portion size",sv:"Portionsstorlek"},{de:"Garzeit",en:"Cooking time",sv:"Koktid"},
  {de:"Bratzeit",en:"Frying time",sv:"Stektid"},{de:"Backzeit",en:"Baking time",sv:"Baktid"},
  {de:"Beilage",en:"Side dish",sv:"Tillbehör"},
  {de:"Soße",en:"Sauce",sv:"Sås"},{de:"Dressing",en:"Dressing",sv:"Dressing"},
  {de:"Marinade",en:"Marinade",sv:"Marinad"},{de:"Brühe",en:"Broth",sv:"Buljong"},
  {de:"Fond",en:"Stock",sv:"Fond"},{de:"Roux",en:"Roux",sv:"Redning"},
  {de:"Emulsion",en:"Emulsion",sv:"Emulsion"},{de:"Konsistenz",en:"Consistency",sv:"Konsistens"},
  {de:"Textur",en:"Texture",sv:"Textur"},{de:"Aroma",en:"Aroma",sv:"Arom"},
  {de:"Geschmack",en:"Taste",sv:"Smak"},{de:"Biss",en:"Bite",sv:"Bit"},
  // Reisen & Länder II
  {de:"Übernachtung",en:"Overnight stay",sv:"Övernattning"},{de:"Tagesausflug",en:"Day trip",sv:"Dagutflykt"},
  {de:"Pauschalreise",en:"Package tour",sv:"Paketresa"},{de:"Individualreise",en:"Independent travel",sv:"Individualresa"},
  {de:"Gruppenreise",en:"Group tour",sv:"Gruppresor"},{de:"Backpacking",en:"Backpacking",sv:"Ryggsäcksresande"},
  {de:"Couchsurfing",en:"Couchsurfing",sv:"Couchsurfing"},{de:"Hostel",en:"Hostel",sv:"Vandrarhem"},
  {de:"Pension",en:"Guesthouse",sv:"Pensionat"},{de:"Ferienwohnung",en:"Holiday apartment",sv:"Semesterlägenhet"},
  {de:"Ferienhaus",en:"Holiday house",sv:"Semesterhus"},{de:"Bed and Breakfast",en:"Bed and breakfast",sv:"Bed and breakfast"},
  {de:"Autovermietung",en:"Car rental",sv:"Biluthyrning"},{de:"Reiseversicherung",en:"Travel insurance",sv:"Reseförsäkring"},
  {de:"Reiseapotheke",en:"Travel first aid kit",sv:"Reseapotek"},{de:"Reisekrankheit",en:"Travel sickness",sv:"Åksjuka"},
  {de:"Jetlag",en:"Jet lag",sv:"Jetlag"},{de:"Klimatisiertes Zimmer",en:"Air-conditioned room",sv:"Luftkonditionerat rum"},
  {de:"Halbpension",en:"Half board",sv:"Halvpension"},{de:"Vollpension",en:"Full board",sv:"Helpension"},
  // Adjektive III - erweitert
  {de:"winzig",en:"tiny",sv:"pytteliten"},{de:"riesig",en:"enormous",sv:"enorm"},
  {de:"uralt",en:"ancient",sv:"urforntidig"},{de:"brandneu",en:"brand new",sv:"splitterny"},
  {de:"blitzschnell",en:"lightning fast",sv:"blixtsnabb"},{de:"todmüde",en:"dead tired",sv:"dödstrött"},
  {de:"stockdunkel",en:"pitch dark",sv:"kolsvart"},{de:"kochend",en:"boiling",sv:"kokande"},
  {de:"knusprig",en:"crispy",sv:"krispig"},{de:"cremig",en:"creamy",sv:"krämig"},
  {de:"saftig",en:"juicy",sv:"saftig"},{de:"sauer",en:"sour",sv:"sur"},
  {de:"bitter",en:"bitter",sv:"bitter"},{de:"süßlich",en:"sweetish",sv:"sötsur"},
  {de:"würzig",en:"spicy",sv:"kryddstark"},{de:"fade",en:"bland",sv:"fadd"},
  {de:"verdorben",en:"spoiled",sv:"bortskämd"},{de:"frisch gebacken",en:"freshly baked",sv:"nybakad"},
  {de:"hausgemacht",en:"homemade",sv:"hemlagad"},{de:"rohkost",en:"raw food",sv:"råkost"},
  // Verben III - erweitert
  {de:"murmeln",en:"to murmur",sv:"att mumla"},
  {de:"gähnen",en:"to yawn",sv:"att gäspa"},{de:"niesen",en:"to sneeze",sv:"att nysa"},
  {de:"husten",en:"to cough",sv:"att hosta"},{de:"schlucken",en:"to swallow",sv:"att svälja"},
  {de:"kauen",en:"to chew",sv:"att tugga"},{de:"lutschen",en:"to suck",sv:"att suga"},
  {de:"blasen",en:"to blow",sv:"att blåsa"},{de:"riechen",en:"to smell",sv:"att lukta"},
  {de:"berühren",en:"to touch",sv:"att röra vid"},{de:"greifen",en:"to grasp",sv:"att gripa"},
  {de:"umklammern",en:"to grip",sv:"att hålla fast"},{de:"schütteln",en:"to shake",sv:"att skaka"},
  {de:"kippen",en:"to tilt",sv:"att tippa"},{de:"drehen",en:"to turn",sv:"att vrida"},
  {de:"rollen",en:"to roll",sv:"att rulla"},{de:"gleiten",en:"to glide",sv:"att glida"},
  {de:"rutschen",en:"to slide",sv:"att halka"},{de:"schaukeln",en:"to swing",sv:"att svinga"},
  // Haus & Wohnen III
  {de:"Mansarde",en:"Attic room",sv:"Mansardrum"},{de:"Souterrain",en:"Semi-basement",sv:"Souterräng"},
  {de:"Penthouse",en:"Penthouse",sv:"Penthouse"},{de:"Loft",en:"Loft",sv:"Loft"},
  {de:"Studio",en:"Studio apartment",sv:"Etta"},{de:"Altbauwohnung",en:"Old apartment",sv:"Lägenhet i äldre hus"},
  {de:"Neubau",en:"New building",sv:"Nybygge"},{de:"Eigentumswohnung",en:"Condominium",sv:"Bostadsrätt"},
  {de:"Mietwohnung",en:"Rental apartment",sv:"Hyreslägenhet"},{de:"WG-Zimmer",en:"Room in shared apartment",sv:"Rum i delat boende"},
  {de:"Untermiete",en:"Sublet",sv:"Andrahand"},{de:"Haushaltsgeld",en:"Household budget",sv:"Hushållspengar"},
  {de:"Kaution",en:"Security deposit",sv:"Deposition"},
  {de:"Hausverwaltung",en:"Property management",sv:"Fastighetsförvaltning"},
  {de:"Hausordnung",en:"House rules",sv:"Husregler"},{de:"Klingelschild",en:"Doorbell sign",sv:"Dörrklocksskylt"},
  {de:"Mülltonnen",en:"Trash bins",sv:"Sopkärl"},{de:"Fahrradkeller",en:"Bicycle storage",sv:"Cykeldepå"},
  // Transport II
  {de:"Elektrobus",en:"Electric bus",sv:"Elbuss"},{de:"Brennstoffzellenauto",en:"Fuel cell car",sv:"Vätgasbil"},
  {de:"Hybridauto",en:"Hybrid car",sv:"Hybridbil"},{de:"Elektroroller",en:"Electric scooter",sv:"Elscooter"},
  {de:"Lastenrad",en:"Cargo bike",sv:"Lastcykel"},{de:"Rikscha",en:"Rickshaw",sv:"Rickshaw"},
  {de:"Seilbahn",en:"Cable car",sv:"Kabelbana"},{de:"Standseilbahn",en:"Funicular",sv:"Bergbana"},
  {de:"Monorail",en:"Monorail",sv:"Monorail"},{de:"Magnetschwebebahn",en:"Maglev train",sv:"Maglevsåg"},
  {de:"Güterwaggon",en:"Freight car",sv:"Godsvagn"},{de:"Schlafwagen",en:"Sleeper car",sv:"Sovvagn"},
  {de:"Speisewagen",en:"Dining car",sv:"Restaurangvagn"},{de:"Dampflokomotive",en:"Steam locomotive",sv:"Ånglok"},
  {de:"Containerschiff",en:"Container ship",sv:"Containerfartyg"},{de:"Frachter",en:"Cargo ship",sv:"Fraktfartyg"},
  {de:"Tanker",en:"Tanker",sv:"Tankfartyg"},{de:"Katamaran",en:"Catamaran",sv:"Katamaran"},
  {de:"Hovercraft",en:"Hovercraft",sv:"Svävare"},{de:"Zeppelin",en:"Zeppelin",sv:"Zeppelin"},
  // Umwelt & Nachhaltigkeit II
  {de:"Kompostierung",en:"Composting",sv:"Kompostering"},{de:"Mülltrennung",en:"Waste separation",sv:"Källsortering"},
  {de:"Wiederverwendung",en:"Reuse",sv:"Återanvändning"},{de:"Upcycling",en:"Upcycling",sv:"Upcycling"},
  {de:"Circular Economy",en:"Circular economy",sv:"Cirkulär ekonomi"},{de:"Ökobilanz",en:"Life cycle assessment",sv:"Miljöbedömning"},
  {de:"Kohlenstoffabdruck",en:"Carbon footprint",sv:"Koldioxidavtryck"},{de:"Nettonull",en:"Net zero",sv:"Netto-noll"},
  {de:"Erneuerbare Energie",en:"Renewable energy",sv:"Förnybar energi"},{de:"Gezeitenenergie",en:"Tidal energy",sv:"Tidvattenenergi"},
  {de:"Geothermie",en:"Geothermal energy",sv:"Geotermisk energi"},{de:"Biogas",en:"Biogas",sv:"Biogas"},
  {de:"Wasserstoff",en:"Hydrogen",sv:"Väte"},{de:"Brennstoffzelle",en:"Fuel cell",sv:"Bränslecell"},
  {de:"Energieeffizienz",en:"Energy efficiency",sv:"Energieffektivitet"},{de:"Wärmedämmung",en:"Thermal insulation",sv:"Värmeisolering"},
  {de:"Passivhaus",en:"Passive house",sv:"Passivhus"},{de:"Nullenergiegebäude",en:"Zero-energy building",sv:"Nollenergihus"},
  {de:"Klimaneutral",en:"Climate neutral",sv:"Klimatneutral"},{de:"Artenschutz",en:"Species protection",sv:"Artskydd"},
  // Mathematik – Ergänzung
  {de:"Tangens",en:"Tangent",sv:"Tangens"},{de:"Differentialrechnung",en:"Differential calculus",sv:"Differentialkalkyl"},
  {de:"Stochastik",en:"Stochastics",sv:"Stokastik"},{de:"Kombinatorik",en:"Combinatorics",sv:"Kombinatorik"},
  {de:"Mengenlehre",en:"Set theory",sv:"Mängdlära"},{de:"Vektorraum",en:"Vector space",sv:"Vektorrum"},
  {de:"Nullstelle",en:"Zero point",sv:"Nollpunkt"},
  {de:"Asymptote",en:"Asymptote",sv:"Asymptot"},{de:"Parabel",en:"Parabola",sv:"Parabel"},
  {de:"Hyperbel",en:"Hyperbola",sv:"Hyperbel"},{de:"Ellipse",en:"Ellipse",sv:"Ellips"},
  {de:"Steigung",en:"Slope",sv:"Lutning"},
  {de:"Schnittpunkt",en:"Intersection point",sv:"Skärningspunkt"},{de:"Extremwert",en:"Extreme value",sv:"Extremvärde"},
  {de:"Wendepunkt",en:"Inflection point",sv:"Inflektionspunkt"},{de:"Funktionsgraph",en:"Function graph",sv:"Funktionsgraf"},
  {de:"Wahrscheinlichkeitsrechnung",en:"Probability theory",sv:"Sannolikhetsteori"},{de:"Normalverteilung",en:"Normal distribution",sv:"Normalfördelning"},
  // Fotografie – Ergänzung
  {de:"Digitalkamera",en:"Digital camera",sv:"Digitalkamera"},{de:"Sucher",en:"Viewfinder",sv:"Sökare"},
  {de:"Telekonverter",en:"Teleconverter",sv:"Telekonverter"},{de:"Bildstabilisator",en:"Image stabilizer",sv:"Bildstabilisator"},
  {de:"RAW-Format",en:"RAW format",sv:"RAW-format"},{de:"JPEG",en:"JPEG",sv:"JPEG"},
  {de:"Histogramm",en:"Histogram",sv:"Histogram"},
  {de:"Bracketing",en:"Bracketing",sv:"Bracketing"},{de:"Mehrfachbelichtung",en:"Multiple exposure",sv:"Multiexponering"},
  {de:"Dunkelkammer",en:"Darkroom",sv:"Mörkrum"},{de:"Negativfilm",en:"Negative film",sv:"Negativfilm"},
  {de:"Diafilm",en:"Slide film",sv:"Diafilm"},{de:"Sofortbildkamera",en:"Instant camera",sv:"Direktbildskamera"},
  {de:"Spiegelreflexkamera",en:"SLR camera",sv:"Spegelreflexkamera"},{de:"Systemkamera",en:"Mirrorless camera",sv:"Systemkamera"},
  {de:"Bildrauschen",en:"Image noise",sv:"Bildbrus"},
  // Musik – Instrumente Ergänzung
  {de:"Kontrabass",en:"Double bass",sv:"Kontrabas"},{de:"Zither",en:"Zither",sv:"Cittra"},
  {de:"Dudelsack",en:"Bagpipe",sv:"Säckpipa"},{de:"Laute",en:"Lute",sv:"Luta"},
  {de:"Cembalo",en:"Harpsichord",sv:"Cembalo"},{de:"Piccolo",en:"Piccolo",sv:"Piccola"},
  {de:"Alphorn",en:"Alphorn",sv:"Alphorn"},{de:"Didgeridoo",en:"Didgeridoo",sv:"Didgeridoo"},
  {de:"Kazoo",en:"Kazoo",sv:"Kazoo"},
  {de:"Steeldrum",en:"Steel drum",sv:"Steeldrum"},{de:"Glockenspiel",en:"Glockenspiel",sv:"Klockspel"},
  {de:"Vibrafon",en:"Vibraphone",sv:"Vibrafon"},
  {de:"Celesta",en:"Celesta",sv:"Celesta"},{de:"Orgelpfeife",en:"Organ pipe",sv:"Orgelpipa"},
  {de:"Chorleiter",en:"Choir conductor",sv:"Körledare"},{de:"Solist",en:"Soloist",sv:"Solist"},
  // Gewürze & Kräuter – Ergänzung
  {de:"Piment",en:"Allspice",sv:"Kryddpeppar"},
  {de:"Tamarinde",en:"Tamarind",sv:"Tamarind"},
  
  {de:"Szechuanpfeffer",en:"Sichuan pepper",sv:"Sichuanpeppar"},
  {de:"Galangal",en:"Galangal",sv:"Galangal"},{de:"Zitronengras",en:"Lemongrass",sv:"Citrongräs"},
  {de:"Kaffirlimette",en:"Kaffir lime",sv:"Kaffirlime"},
  {de:"Harissa",en:"Harissa",sv:"Harissa"},{de:"Miso",en:"Miso",sv:"Miso"},
  {de:"Tahini",en:"Tahini",sv:"Tahini"},
  // Vögel – Ergänzung
  {de:"Rotmilan",en:"Red kite",sv:"Röd glada"},{de:"Sperber",en:"Sparrowhawk",sv:"Sparvhök"},
  {de:"Wespenbussard",en:"Honey buzzard",sv:"Bivråk"},
  {de:"Schwarzstorch",en:"Black stork",sv:"Svart stork"},{de:"Silberreiher",en:"Great egret",sv:"Ägretthäger"},
  
  {de:"Zaunkönig",en:"Wren",sv:"Gärdsmyg"},{de:"Kleiber",en:"Nuthatch",sv:"Nötväcka"},
  {de:"Baumläufer",en:"Treecreeper",sv:"Trädkrypare"},
  
  {de:"Dompfaff",en:"Bullfinch",sv:"Domherre"},
  // Meerestiere – Ergänzung
  {de:"Seelilie",en:"Sea lily",sv:"Sjölilia"},
  {de:"Feuerfisch",en:"Lionfish",sv:"Lejonsfisk"},{de:"Steinfisch",en:"Stonefish",sv:"Stenfisk"},
  {de:"Blauflossen-Thun",en:"Bluefin tuna",sv:"Blåfenad tonfisk"},{de:"Schwertfisch",en:"Swordfish",sv:"Svärdfisk"},
  {de:"Meeresbarsch",en:"Sea bass",sv:"Havsabborre"},
  {de:"Steinbutt",en:"Turbot",sv:"Piggvar"},{de:"Scholle",en:"Plaice",sv:"Rödspätta"},
  {de:"Schellfisch",en:"Haddock",sv:"Kolja"},
  // Insekten – Ergänzung
  {de:"Bockkäfer",en:"Longhorn beetle",sv:"Långhorning"},{de:"Hirschkäfer",en:"Stag beetle",sv:"Ekoxe"},
  {de:"Mistkäfer",en:"Dung beetle",sv:"Dyngbagge"},{de:"Sandlaufkäfer",en:"Tiger beetle",sv:"Sandjägare"},
  {de:"Wasserläufer",en:"Water strider",sv:"Vattenlöpare"},{de:"Stabschrecke",en:"Stick insect",sv:"Vandringspinne"},
  
  {de:"Ohrwurm",en:"Earwig",sv:"Tvestjärt"},{de:"Asseln",en:"Woodlouse",sv:"Gråsugga"},
  // Pflanzen & Blumen – Ergänzung
  {de:"Christrose",en:"Christmas rose",sv:"Julros"},{de:"Enzian",en:"Gentian",sv:"Gentiana"},
  {de:"Edelweiß",en:"Edelweiss",sv:"Edelweiss"},{de:"Alpenrose",en:"Alpine rose",sv:"Alpros"},
  {de:"Wiesenblume",en:"Meadow flower",sv:"Ängsblomma"},{de:"Stranddistel",en:"Sea holly",sv:"Martorn"},
  {de:"Wolfsmilch",en:"Spurge",sv:"Törel"},{de:"Baldrian",en:"Valerian",sv:"Vänderot"},
  {de:"Johanniskraut",en:"St. John's wort",sv:"Johannesört"},{de:"Brennnessel",en:"Stinging nettle",sv:"Brännässla"},
  {de:"Schachtelhalm",en:"Horsetail",sv:"Fräken"},{de:"Wegwarte",en:"Chicory",sv:"Cikoria"},
  // Werkzeuge – Ergänzung
  
  {de:"Hobel",en:"Plane",sv:"Hyvel"},
  
  {de:"Sägeblatt",en:"Saw blade",sv:"Sågblad"},
  {de:"Schraubstock",en:"Vice",sv:"Skruvstäd"},
  
  // Wintersport – Ergänzung
  {de:"Skating",en:"Ice skating",sv:"Skridskoåkning"},
  
  {de:"Rodeln",en:"Tobogganing",sv:"Kälkåkning"},
  {de:"Skeleton",en:"Skeleton",sv:"Skeleton"},{de:"Bob",en:"Bobsled",sv:"Bob"},
  {de:"Eistanz",en:"Ice dance",sv:"Isdans"},{de:"Kurztrack",en:"Short track",sv:"Kortbana"},
  {de:"Langlaufspur",en:"Cross-country trail",sv:"Längdskidspår"},{de:"Abfahrtspiste",en:"Downhill slope",sv:"Utförsbacke"},
  // Wassersport – Ergänzung
  {de:"Drachenboot",en:"Dragon boat",sv:"Drakbåt"},{de:"Wildwasser-Kanu",en:"Whitewater canoe",sv:"Vildvattenskanot"},
  {de:"Turmspringen",en:"Platform diving",sv:"Plattformshoppning"},
  {de:"Freistilschwimmen",en:"Freestyle swimming",sv:"Frisim"},{de:"Schmetterlingsstil",en:"Butterfly stroke",sv:"Fjärilssim"},
  
  {de:"Paddleboarding",en:"Paddleboarding",sv:"Paddleboard"},
  // Film & Produktion – Ergänzung
  {de:"Kameraschwenk",en:"Camera pan",sv:"Kamerakörning"},{de:"Zoomen",en:"Zooming",sv:"Zooma"},
  {de:"Filmmusik",en:"Film score",sv:"Filmmusik"},
  {de:"Requisiteur",en:"Props master",sv:"Rekvisitör"},{de:"Garderobiere",en:"Wardrobe mistress",sv:"Kostymerska"},
  {de:"Szenenbildner",en:"Production designer",sv:"Scenograf"},
  {de:"Pressevorführung",en:"Press screening",sv:"Pressvisning"},
  // Camping – Ergänzung
  {de:"Trinkwasserfilter",en:"Water filter",sv:"Vattenfilter"},
  {de:"Biwaksack",en:"Bivouac sack",sv:"Biwacksäck"},{de:"Orientierungslauf",en:"Orienteering",sv:"Orientering"},
  {de:"Schneebrille",en:"Snow goggles",sv:"Snöglasögon"},
  {de:"Wanderstock",en:"Hiking pole",sv:"Vandringsstav"},{de:"Trekkingschuhe",en:"Trekking shoes",sv:"Trekkingskor"},
  // Wirtschaft & Finanzen – Ergänzung
  {de:"Investmentfonds",en:"Investment fund",sv:"Investeringsfond"},
  {de:"Börsengang",en:"IPO",sv:"Börsintroduktion"},
  {de:"Kreditrating",en:"Credit rating",sv:"Kreditbetyg"},{de:"Staatsverschuldung",en:"National debt",sv:"Statsskuld"},
  {de:"Währungsreserve",en:"Currency reserve",sv:"Valutareserv"},{de:"Leitzins",en:"Key interest rate",sv:"Styrränta"},
  {de:"Kaufkraft",en:"Purchasing power",sv:"Köpkraft"},
  // Rechtssystem – Ergänzung
  {de:"Verfassungsgericht",en:"Constitutional court",sv:"Författningsdomstol"},
  {de:"Pflichtverteidiger",en:"Public defender",sv:"Offentlig försvarare"},{de:"Schöffe",en:"Lay judge",sv:"Nämndeman"},
  {de:"Berufungsgericht",en:"Court of appeal",sv:"Hovrätt"},
  {de:"Strafmaß",en:"Sentence",sv:"Straffmätning"},
  
  // Medizin – Ergänzung
  {de:"Anamnese",en:"Medical history",sv:"Anamnes"},
  {de:"Prognose",en:"Prognosis",sv:"Prognos"},{de:"Remission",en:"Remission",sv:"Remission"},
  {de:"Rezidiv",en:"Relapse",sv:"Återfall"},{de:"Chronisch",en:"Chronic",sv:"Kronisk"},
  {de:"Akut",en:"Acute",sv:"Akut"},{de:"Palliativ",en:"Palliative",sv:"Palliativ"},
  {de:"Intensivstation",en:"Intensive care unit",sv:"Intensivvårdsavdelning"},
  {de:"Rhesusfaktor",en:"Rhesus factor",sv:"Rh-faktor"},
  // Bauwesen – Ergänzung
  {de:"Spannbeton",en:"Prestressed concrete",sv:"Spännt betong"},
  {de:"Mauerwerk",en:"Masonry",sv:"Murverk"},
  {de:"Putz",en:"Plaster",sv:"Puts"},
  {de:"Dachdecker",en:"Roofer",sv:"Takläggare"},{de:"Zimmermann",en:"Carpenter",sv:"Snickare"},
  {de:"Gerüstbauer",en:"Scaffolder",sv:"Ställningsbyggare"},{de:"Tiefbau",en:"Civil engineering",sv:"Anläggningsarbete"},
  // Garten – Ergänzung
  
  {de:"Pflanzstab",en:"Plant stake",sv:"Plantstöd"},{de:"Gartenschlauch",en:"Garden hose",sv:"Trädgårdsslang"},
  {de:"Hacke",en:"Hoe",sv:"Hacka"},
  
  {de:"Pastinake",en:"Parsnip",sv:"Palsternacka"},
  // Schmuck & Edelsteine – Ergänzung
  {de:"Tigerauge",en:"Tiger's eye",sv:"Tigeröga"},
  {de:"Karneol",en:"Carnelian",sv:"Karneol"},
  
  
  {de:"Perlmutt",en:"Mother of pearl",sv:"Pärlemor"},{de:"Rhodonit",en:"Rhodonite",sv:"Rodonit"},
  // Textilien – Ergänzung
  {de:"Popeline",en:"Poplin",sv:"Poplin"},{de:"Batist",en:"Batiste",sv:"Batist"},
  {de:"Krepp",en:"Crepe",sv:"Krepp"},
  {de:"Cord",en:"Corduroy",sv:"Manchester"},
  {de:"Molton",en:"Molleton",sv:"Molton"},
  {de:"Modal",en:"Modal",sv:"Modal"},
  // Kosmetik – Ergänzung
  {de:"Mizellenwasser",en:"Micellar water",sv:"Micellvatten"},
  {de:"Nagelpflege",en:"Nail care",sv:"Nagelvård"},
  
  {de:"Trockenshampoo",en:"Dry shampoo",sv:"Torrschampo"},{de:"Gesichtswasser",en:"Toner",sv:"Ansiktsvatten"},
  {de:"Körperbutter",en:"Body butter",sv:"Kroppsmöt"},
  // Technologie – Ergänzung
  {de:"Edge Computing",en:"Edge computing",sv:"Edge-datorberäkning"},{de:"Quantencomputer",en:"Quantum computer",sv:"Kvantdator"},
  {de:"Blockchain",en:"Blockchain",sv:"Blockkedja"},{de:"Metaverse",en:"Metaverse",sv:"Metaverse"},
  {de:"Augmented Reality",en:"Augmented reality",sv:"Förstärkt verklighet"},{de:"Virtual Reality",en:"Virtual reality",sv:"Virtuell verklighet"},
  {de:"Internet der Dinge",en:"Internet of things",sv:"Sakernas internet"},
  {de:"Neuronales Netz",en:"Neural network",sv:"Neuralt nätverk"},{de:"Sprachmodell",en:"Language model",sv:"Språkmodell"},
  {de:"Elektrofahrzeug",en:"Electric vehicle",sv:"Elfordon"},
  // Geschichte – Ergänzung
  
  {de:"Völkerwanderung",en:"Migration period",sv:"Folkvandringstiden"},
  
  
  {de:"Berliner Mauer",en:"Berlin Wall",sv:"Berlinmuren"},{de:"Wiedervereinigung",en:"Reunification",sv:"Återförening"},
  // Kunst – Ergänzung
  {de:"Expressionismus",en:"Expressionism",sv:"Expressionism"},{de:"Impressionismus",en:"Impressionism",sv:"Impressionism"},
  {de:"Kubismus",en:"Cubism",sv:"Kubism"},{de:"Surrealismus",en:"Surrealism",sv:"Surrrealism"},
  {de:"Dadaismus",en:"Dadaism",sv:"Dadaism"},{de:"Pop Art",en:"Pop art",sv:"Pop art"},
  {de:"Minimalismus",en:"Minimalism",sv:"Minimalism"},{de:"Konzeptkunst",en:"Conceptual art",sv:"Konceptkonst"},
  
  // Literatur – Ergänzung
  {de:"Monolog",en:"Monologue",sv:"Monolog"},{de:"Dialog",en:"Dialogue",sv:"Dialog"},
  {de:"Perspektive",en:"Perspective",sv:"Perspektiv"},
  {de:"Allegorie",en:"Allegory",sv:"Allegori"},
  {de:"Satire",en:"Satire",sv:"Satir"},
  {de:"Tragödie",en:"Tragedy",sv:"Tragedi"},{de:"Komödie",en:"Comedy",sv:"Komedi"},
  {de:"Melodrama",en:"Melodrama",sv:"Melodrama"},{de:"Kriminalroman",en:"Crime novel",sv:"Kriminalroman"},
];


async function importDefaultWords() {
    if (!currentUser || !db) return;
    try {
        const now = getNextReviewTimestamp(0);
        const ref = db.collection('users').doc(currentUser.uid).collection('words_' + currentCollIndex);
        for (let i = 0; i < DEFAULT_WORDS.length; i += 490) {
            const batch = db.batch();
            DEFAULT_WORDS.slice(i, i + 490).forEach(w => {
                batch.set(ref.doc(), {
                    [conf.l1]: w.de, [conf.l2]: w.en, [conf.l3]: w.sv,
                    ts: firebase.firestore.FieldValue.serverTimestamp(),
                    level: 0, nextReview: now
                });
            });
            await batch.commit();
        }
        showToast('✅ ' + DEFAULT_WORDS.length + ' Standardwörter importiert!', 'success');
        refreshData();
    } catch(e) { logCustomError('importDefaultWords', e); }
}

async function forceImportDefaultWords() {
    if (!currentUser || !db) { showToast('⚠️ Warte auf Datenbank-Verbindung...', 'error'); return; }
    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('words_' + currentCollIndex).get();
        const existingCount = snap.size;
        if (existingCount > 0) {
            const ok = confirm('Es sind bereits ' + existingCount + ' Wörter vorhanden.\n\nTrotzdem ' + DEFAULT_WORDS.length + ' Standardwörter importieren?\n(Achtung: Es entstehen Duplikate!)');
            if (!ok) return;
        }
        showToast('⏳ Importiere ' + DEFAULT_WORDS.length + ' Standardwörter...', 'info');
        await importDefaultWords();
    } catch(e) { logCustomError('forceImportDefaultWords', e); showToast('❌ Fehler beim Import.', 'error'); }
}

async function refreshData() {
    if(!currentUser || !db) return;
    dataReady = false;
    const s = await db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).orderBy("ts", "desc").get();
    if(s) {
        allWords = s.docs.map(d => ({id: d.id, ...d.data()}));
        document.getElementById('wordCount').innerText = allWords.length;
        renderList();
        dataReady = true;
        onDataReady();
        if (allWords.length === 0) importDefaultWords();
    }
}
function onDataReady() {
    const fcTab = document.getElementById('tabFlashcards');
    if (fcTab && fcTab.style.display !== 'none' && fcPool.length === 0) initFlashcards(false);
    const homeTab = document.getElementById('tabHome');
    if (homeTab && homeTab.style.display !== 'none') renderDashboard();
}
function generateStudyList() { if(!allWords.length) { document.getElementById('studyContainer').innerHTML = "<p style='text-align:center;'>Füge zuerst Wörter hinzu!</p>"; document.getElementById('studyActions').style.display = 'none'; return; } const now = Date.now(); let dueWords = allWords.filter(w => !w.nextReview || w.nextReview <= now); if(dueWords.length === 0) { document.getElementById('studyContainer').innerHTML = "<p style='text-align:center; font-size:1.2rem;'>🎉 Alle aktuellen Vokabeln gelernt!<br>Komm morgen wieder.</p>"; document.getElementById('studyWordCount').innerText="Fertig"; document.getElementById('studyActions').style.display = 'none'; return; } document.getElementById('studyActions').style.display = 'flex'; studyWords = dueWords.sort(() => 0.5 - Math.random()).slice(0, 15); studyIndex = 0; renderStudyWord(); }
function renderStudyWord() { if(!studyWords.length) return; const w = studyWords[studyIndex]; document.getElementById('studyWordCount').innerText = `${studyIndex+1}/${studyWords.length}`; document.getElementById('studyContainer').innerHTML = `<div style="text-align:center; margin-bottom:10px;"><span class="level-dot lvl-${w.level||0}"></span><span style="font-size:0.8rem; color:var(--text-light); font-weight:bold;">Level ${w.level||0}</span></div><div style="font-size:2.2rem; font-weight:800; color:var(--primary); text-align:center; margin:10px 0;">${escapeHTML(w[conf.l1])}</div><div style="text-align:center; margin-bottom:15px;"><div style="font-size:1.5rem;">${ALL_LANGS[conf.l3].flag} ${escapeHTML(w[conf.l3])} <button class="icon-btn" style="display:inline-flex; border:none; background:transparent;" onclick="speak('${safeJS(w[conf.l3])}','${conf.l3}')">🔊</button></div></div><div style="text-align:center;"><div style="font-size:1.2rem; color:var(--text-light);">${ALL_LANGS[conf.l2].flag} ${escapeHTML(w[conf.l2])}</div></div>`; }
async function markWord(correct) { if(!studyWords.length || !currentUser || !db) return; const w = studyWords[studyIndex]; let lvl = w.level || 0; if(correct) { lvl = Math.min(5, lvl + 1); playSound('success'); addXP(5); statsToday.learned++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); recordDailyActivity(); if(statsToday.learned === 5) { addXP(20); fireConfetti(); } } else { lvl = Math.max(0, lvl - 1); playSound('error'); } w.level = lvl; w.nextReview = getNextReviewTimestamp(lvl); db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(w.id).update({level: lvl, nextReview: w.nextReview}); setTimeout(nextStudyWord, 300); }
function nextStudyWord() { studyIndex++; if(studyIndex >= studyWords.length) { fireConfetti(); generateStudyList(); } else { renderStudyWord(); } }

window.onload = () => { try { init(); } catch(e) { console.error("Kritischer Fehler beim Starten:", e); } };
