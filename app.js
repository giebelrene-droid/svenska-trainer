const APP_VERSION = "30.8";

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

// ==========================================
// 2. KERN-VARIABLEN & FIREBASE INITIALISIERUNG
// ==========================================
let db = null; let currentUser = null;
try {
    firebase.initializeApp({ apiKey: "AIzaSyB4ViTtin8mGcayWbXX-UtpTpPF5E4u68Q", authDomain: "uebersetzer-d-eng-swe.firebaseapp.com", projectId: "uebersetzer-d-eng-swe" }); 
    db = firebase.firestore(); db.enablePersistence().catch(()=>{});
} catch(err) { logCustomError("Firebase Init", err); if(document.getElementById('offlineBanner')) document.getElementById('offlineBanner').style.display = 'block'; }

const ALL_LANGS = { 'de':{name:'Deutsch',tts:'de-DE',flag:'🇩🇪'}, 'en':{name:'Englisch',tts:'en-US',flag:'🇬🇧'}, 'sv':{name:'Schwedisch',tts:'sv-SE',flag:'🇸🇪'}, 'fr':{name:'Französisch',tts:'fr-FR',flag:'🇫🇷'}, 'no':{name:'Norwegisch',tts:'nb-NO',flag:'🇳🇴'}, 'es':{name:'Spanisch',tts:'es-ES',flag:'🇪🇸'}, 'it':{name:'Italienisch',tts:'it-IT',flag:'🇮🇹'} };
let userNames = ['Papa', 'Mama', 'Kind 1', 'Kind 2']; let currentCollIndex = 0; let conf = { l1: 'de', l2: 'en', l3: 'sv' }; let allWords = [];
let studyWords = []; let studyIndex = 0; let fcPool = []; let fcIndex = 0; let fcSessionHistory = { spaeter: [], nochmals: [], geuebt: [] }; let currentFcListType = '';
let activeRpSentenceForFeedback = ""; let rpOptionsBuffer = null; let rpFetchPromise = null; let rpMicTimer = null; let rpCurrentTranscript = "";
let geminiApiKey = localStorage.getItem('trainerGeminiKey') || ""; let currentApiKeyIndex = 0; let cachedGeminiModel = null;
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
// 1) Beim ersten Klick irgendwo auf der Seite: leere Utterance → entsperrt Chrome
document.addEventListener('click', function unlockTTS() {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    window.speechSynthesis.speak(u);
}, { once: true });

// 2) Alle 5s resume() aufrufen — verhindert Chrome-Android-Pause-Bug
if (window.speechSynthesis) {
    setInterval(() => { window.speechSynthesis.resume(); }, 5000);
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
    const voiceSelect = document.getElementById('selAudioVoice'); if (!voiceSelect) return;
    const currentLangCode = ALL_LANGS[conf.l3].tts.split('-')[0];
    const matchingVoices = availableVoices.filter(v => v.lang.startsWith(currentLangCode));
    let html = '<option value="">🤖 Standard-Stimme</option>';
    matchingVoices.forEach(v => { html += `<option value="${escapeHTML(v.name)}">${escapeHTML(v.name)}</option>`; });
    voiceSelect.innerHTML = html;
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

function buildUtterance(text, langKey, rate) {
    const msg = new SpeechSynthesisUtterance(text.trim());
    msg.lang   = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) ? ALL_LANGS[langKey].tts : 'de-DE';
    msg.rate   = parseFloat(rate) || 1.0;
    msg.volume = 1.0;
    msg.pitch  = 1.0;
    if (langKey === conf.l3 && availableVoices.length > 0) {
        const voiceSelect = document.getElementById('selAudioVoice');
        if (voiceSelect && voiceSelect.value) {
            const sel = availableVoices.find(v => v.name === voiceSelect.value);
            if (sel) msg.voice = sel;
        }
    }
    return msg;
}

function speak(text, langKey, rate = 1.0) {
    if (!window.speechSynthesis || !text || !text.trim()) return;
    const ss = window.speechSynthesis;
    // 3) Vor jedem speak(): cancel() dann resume() — einziger bekannter Fix für Chrome Android
    ss.cancel();
    ss.resume();
    const msg = buildUtterance(text, langKey, rate);
    msg.onerror = (e) => { logCustomError('speak', (e.error || String(e))); };
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

function updateVersionDisplay() {
    const badge = document.getElementById('versionBadge');
    const footer = document.getElementById('footerVersion');
    if (badge) badge.textContent = 'v' + APP_VERSION;
    if (footer) footer.textContent = APP_VERSION;
}

function init() {
    removeBrokenServiceWorkers();
    updateVersionDisplay();
    if(document.getElementById('inpGeminiKey')) document.getElementById('inpGeminiKey').value = geminiApiKey; 
    try { const storedNames = localStorage.getItem('trainerUserNames'); if(storedNames) userNames = JSON.parse(storedNames); const savedIdx = localStorage.getItem('trainerUserIdx'); if(savedIdx) currentCollIndex = parseInt(savedIdx); } catch(e){}
    const todayStr = new Date().toDateString(); if(statsToday.date !== todayStr) { statsToday = {learned:0, added:0, date:todayStr}; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); }
    loadUserLangs(); renderRenameInputs(); updateUserDropdown(); populateLangSelects(); checkStreak(); updateQuests(); updateSaveModeUI(); 
    showTab('add'); 
    if(typeof firebase !== 'undefined') { firebase.auth().signInAnonymously().catch((e)=>{}); firebase.auth().onAuthStateChanged((user) => { if (user) { currentUser = user; refreshData(); } }); }
}

function updateSaveModeUI() {
    const btn = document.getElementById('btnSaveMode'); if(!btn) return;
    if(isFastInputMode) { btn.innerHTML = "⚡ Modus: Schnelleingabe (Hier bleiben)"; btn.style.borderColor = "var(--secondary)"; btn.style.color = "var(--secondary)"; } 
    else { btn.innerHTML = "🔀 Modus: Normal (Zur Liste springen)"; btn.style.borderColor = "var(--border-soft)"; btn.style.color = "var(--text-light)"; }
}
function toggleSaveMode() { isFastInputMode = !isFastInputMode; localStorage.setItem('trainerFastInput', isFastInputMode); updateSaveModeUI(); }
function openSettings() { document.getElementById('settingsOverlay').style.display = 'flex'; }
function closeSettings() { document.getElementById('settingsOverlay').style.display = 'none'; }
function saveApiKey() { geminiApiKey = document.getElementById('inpGeminiKey').value.trim(); localStorage.setItem('trainerGeminiKey', geminiApiKey); cachedGeminiModel = null; }

function showTab(n) { 
    try {
        if(isLiveRecording) toggleLiveRecord(); 
        if(isChatSessionActive) toggleChatRecord();
        if(isAudioRunning && n !== 'audio') toggleAudioTrainer(); 
        
        document.querySelectorAll('.nav-scroll button').forEach(b=>b.classList.remove('active')); 
        const btnMap = { 'add':'btn1', 'flashcards':'btnFlash', 'chat':'btn8', 'live':'btn7', 'study':'btn5', 'list':'btn3', 'arcade':'btnArcade', 'story':'btnStory', 'roleplay':'btnRoleplay', 'audio':'btnAudio' };
        if(btnMap[n] && document.getElementById(btnMap[n])) document.getElementById(btnMap[n]).classList.add('active');
        
        const tabs = ['tabAdd', 'tabFlashcards', 'tabChat','tabLive','tabStudy','tabList','tabArcade','tabStory','tabRoleplay', 'tabAudio'];
        tabs.forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
        const activeTab = document.getElementById('tab' + n.charAt(0).toUpperCase() + n.slice(1));
        if(activeTab) activeTab.style.display = 'block';
        
        if(n === 'list') { document.getElementById('listSearch').value = ''; renderList(); }
        if(n === 'study') generateStudyList();
        if(n === 'flashcards' && fcPool.length === 0) initFlashcards(false); 
        if(n === 'arcade') openMiniGame('Menu');
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
function addXP(amount) { userXP += amount; localStorage.setItem('trainerXP', userXP); updateStatsUI(); }
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
// 5. GEMINI API ANBINDUNG
// ==========================================
async function callGemini(prompt, imageBase64 = null, systemPrompt = null) {
    const keys = geminiApiKey.split(',').map(k => k.trim()).filter(k => k);
    if(keys.length === 0) { showToast("⚠️ Bitte hinterlege mindestens einen API-Key in den Einstellungen.", "error"); return null; }

    const activeLoader = Array.from(document.querySelectorAll('.loader')).find(el => el.offsetWidth > 0);
    const originalLoaderText = activeLoader ? activeLoader.innerText : "";

    if (!cachedGeminiModel) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keys[0]}`); const data = await res.json();
            if (data.models) {
                let m = data.models.find(mod => mod.name.includes("flash") && !mod.name.includes("latest") && mod.supportedGenerationMethods.includes("generateContent"));
                if(!m) m = data.models.find(mod => mod.name.includes("gemini") && mod.supportedGenerationMethods.includes("generateContent"));
                if (m) cachedGeminiModel = m.name.replace('models/', '');
            }
        } catch(e) { logCustomError("Model Fetch", e); }
        if(!cachedGeminiModel) cachedGeminiModel = "gemini-1.5-flash-latest";
    }

    let payload = { contents: [] };
    if (systemPrompt) { payload.contents.push({ role: "user", parts: [{ text: "SYSTEM-ANWEISUNG: " + systemPrompt }] }); payload.contents.push({ role: "model", parts: [{ text: "Verstanden." }] }); }
    let userParts = [{ text: prompt }];
    if (imageBase64) {
        let mime = "image/jpeg"; try { mime = imageBase64.match(/data:(.*?);/)[1]; } catch(e){}
        let b64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
        userParts.push({ inlineData: { mimeType: mime, data: b64 } });
    }
    payload.contents.push({ role: "user", parts: userParts });

    const waitTimes = [0, 2000, 4000, 8000, 15000]; let lastErrorMsg = "";
    for (let round = 0; round < waitTimes.length; round++) {
        if (round > 0 && activeLoader) activeLoader.innerText = `Lade... Warte ${waitTimes[round]/1000}s...`;
        if (round > 0) await new Promise(resolve => setTimeout(resolve, waitTimes[round]));
        for (let i = 0; i < keys.length; i++) {
            const currentKey = keys[currentApiKeyIndex % keys.length];
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${cachedGeminiModel}:generateContent?key=${currentKey}`;
            try {
                const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
                const d = await resp.json();
                if (d.error) throw new Error(d.error.message);
                if (activeLoader) activeLoader.innerText = originalLoaderText;
                return d.candidates[0].content.parts[0].text.trim();
            } catch(e) { lastErrorMsg = e.message; logCustomError(`API Key Failed`, e.message); currentApiKeyIndex++; }
        }
    }
    if (activeLoader) activeLoader.innerText = originalLoaderText;
    if (lastErrorMsg.toLowerCase().includes("overloaded")) showToast("⚠️ Die Google KI-Server sind im Moment überlastet.", "error");
    else if (lastErrorMsg.toLowerCase().includes("quota")) showToast("⚠️ API-Limit erreicht! Kurze Pause machen.", "error");
    else showToast("⚠️ Fehler bei der API-Abfrage.", "error");
    return null;
}

// ==========================================
// 6. AUDIO-TRAINER (DIE NEUE LERN-FUNKTION)
// ==========================================
function speakAsync(text, langKey, rate = 1.0) {
    return new Promise((resolve) => {
        const diagPrefix = `speakAsync("${(text||'').slice(0,25)}", ${langKey}, ${rate})`;
        if (!('speechSynthesis' in window) || cancelAudio || !text || !text.trim()) {
            return resolve();
        }

        const ss = window.speechSynthesis;

        currentUtterance = buildUtterance(text, langKey, rate);

        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; currentUtterance = null; resolve(); } };

        currentUtterance.onend = () => { done(); };
        currentUtterance.onerror = (e) => {
            logCustomError('speakAsync', (e.error || String(e)));
            done();
        };

        // Timeout-Fallback: iOS/Android feuern onend manchmal nie
        const charCount = text.trim().length;
        const estMs = Math.max(2000, (charCount / (parseFloat(rate) * 14)) * 1000) + 2000;
        setTimeout(done, Math.min(estMs, 18000));

        ss.cancel();
        ss.resume();
        ss.speak(currentUtterance);
    });
}
const sleepAsync = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function toggleAudioTrainer() {
    const btn = document.getElementById('btnStartAudio');
    if (isAudioRunning) {
        isAudioRunning = false; cancelAudio = true;
        window.speechSynthesis.cancel();
        stopSynthKeepAlive();
        btn.innerHTML = "▶️ Audio-Trainer starten"; btn.style.background = "linear-gradient(135deg, #a855f7, #ec4899)";
        document.getElementById('audioDisplayL1').innerText = "Pausiert."; document.getElementById('audioDisplayL3').innerText = "";
        return;
    }
    isAudioRunning = true; cancelAudio = false;
    startSynthKeepAlive(); // Chrome/Android: verhindert Abbruch nach ~15s
    btn.innerHTML = "⏹️ Audio-Trainer stoppen"; btn.style.background = "#EF4444";
    audioTrainerLoop();
}

async function audioTrainerLoop() {
    while (isAudioRunning && !cancelAudio) {
        document.getElementById('audioLoader').style.display = 'block';
        const diff = document.getElementById('selAudioDiff').value; const tgtLangName = ALL_LANGS[conf.l3].name;
        
        const now = Date.now(); audioHistory = audioHistory.filter(item => (now - item.ts) < 1800000); 
        const avoidList = audioHistory.map(i => i.text).join('", "'); const avoidPrompt = avoidList ? `Verwende AUF KEINEN FALL diese Sätze oder ähnliche: ["${avoidList}"]. ` : "";
        const topics = ["Einkaufen", "Reisen", "Arbeit", "Freizeit", "Essen und Trinken", "Wetter", "Familie", "Sport", "Gesundheit", "Verkehrsmittel", "Gefühle", "Technik", "Natur", "Wohnen"];
        const randomTopic = topics[Math.floor(Math.random() * topics.length)]; const randomSeed = Math.floor(Math.random() * 10000); 
        
        const prompt = `Du bist ein Sprachtrainer. Erstelle EINEN realistischen Satz auf Niveau ${diff} zum Thema "${randomTopic}" (ID: ${randomSeed}). ${avoidPrompt}Gib ihn auf Deutsch und auf ${tgtLangName} zurück. JSON-Format: {"l1": "Deutscher Satz", "l3": "Übersetzung in ${tgtLangName}"}`;
        
        const res = await callGemini(prompt);
        document.getElementById('audioLoader').style.display = 'none';
        if (!res || cancelAudio) { if(!cancelAudio) await sleepAsync(3000); continue; }

        let sentenceObj;
        try {
            let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim();
            const sIdx = cleanStr.indexOf('{'); const eIdx = cleanStr.lastIndexOf('}'); if (sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1);
            sentenceObj = JSON.parse(cleanStr);
        } catch (e) { await sleepAsync(2000); continue; }

        const l1Text = sentenceObj.l1; const l3Text = sentenceObj.l3;
        audioHistory.push({text: l1Text, ts: Date.now()}); currentAudioSentence = { l1: l1Text, l3: l3Text }; 
        document.getElementById('audioDisplayL1').innerText = l1Text; document.getElementById('audioDisplayL3').innerText = "";

        const slowRate = parseFloat(document.getElementById('selAudioSlow').value);
        const pauseMs = parseInt(document.getElementById('selAudioPause').value) * 1000;
        const reps = parseInt(document.getElementById('selAudioReps').value) || 1;

        if (cancelAudio) break; await speakAsync(l1Text, conf.l1, 1.0);
        if (cancelAudio) break; await sleepAsync(600);
        document.getElementById('audioDisplayL3').innerText = l3Text;

        if (cancelAudio) break; await speakAsync(l3Text, conf.l3, 1.0);
        if (cancelAudio) break; await sleepAsync(pauseMs);

        for (let i = 0; i < reps; i++) {
            if (cancelAudio) break; await speakAsync(l3Text, conf.l3, slowRate);
            if (cancelAudio) break; await sleepAsync(pauseMs);
        }

        if (cancelAudio) break; await speakAsync(l3Text, conf.l3, 1.0);
        if (cancelAudio) break; await sleepAsync(2000);
    }
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
    const prompt = `Du bist ein professioneller Sprachtrainer. Erstelle für das Szenario/Thema "${topic}" exakt DREI völlig unterschiedliche, aber absolut realistische Antwortmöglichkeiten in ${tgtLangName}. Niveau: ${diffText}. Satz 1: Höflich. Satz 2: Kurz/informell. Satz 3: Frage. Aspekt: ${intention} (ID: ${randomSeed}). Antworte AUSSCHLIESSLICH im folgenden JSON-Format: [{"l3": "...", "l1": "..."}, {"l3": "...", "l1": "..."}, {"l3": "...", "l1": "..."}]`;
    const res = await callGemini(prompt);
    if(res) { try { let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const sIdx = cleanStr.indexOf('['); const eIdx = cleanStr.lastIndexOf(']'); if(sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1); return JSON.parse(cleanStr); } catch(e) { logCustomError("JSON Parsing Szenarien", e); return null; } } return null;
}
function prefetchRpSentences() { if (!rpFetchPromise) { rpFetchPromise = fetchRpSentencesFromGemini().then(options => { if (options) rpOptionsBuffer = options; rpFetchPromise = null; }); } }
async function startRoleplay() { document.getElementById('rpArea').style.display = 'block'; document.getElementById('rpFeedbackBox').style.display = 'none'; let topic = document.getElementById('selRpTopic').value; if(topic === 'custom') topic = document.getElementById('inpCustomTopic').value.trim() || "Allgemeines Gespräch"; document.getElementById('rpTopicDisplay').innerText = topic.toUpperCase(); await generateRpSentence(); }
async function generateRpSentence() {
    document.getElementById('rpFeedbackBox').style.display = 'none'; document.getElementById('rpOptionsContainer').innerHTML = ""; document.getElementById('btnRpRefresh').style.display = 'none'; document.getElementById('rpLoader').style.display = 'block';
    let options = null;
    if (rpOptionsBuffer) { options = rpOptionsBuffer; rpOptionsBuffer = null; } else if (rpFetchPromise) { await rpFetchPromise; options = rpOptionsBuffer; rpOptionsBuffer = null; } else { options = await fetchRpSentencesFromGemini(); }
    document.getElementById('rpLoader').style.display = 'none'; document.getElementById('btnRpRefresh').style.display = 'inline-block';
    if(options) { renderRpOptions(options); prefetchRpSentences(); } else { document.getElementById('rpOptionsContainer').innerHTML = `<div style="text-align:center; color:#EF4444; font-weight:bold;">⚠️ Konnte Sätze nicht laden. Bitte versuche es erneut.</div>`; }
}
function renderRpOptions(options) {
    let html = ''; options.forEach((opt, idx) => { const jsSafeL3 = safeJS(opt.l3); html += `<div class="rp-option"><div class="rp-option-text">${escapeHTML(opt.l3)}</div><div class="rp-option-trans">${escapeHTML(opt.l1)}</div><div class="rp-option-actions"><button class="icon-btn" onclick="speakRpSentence('${jsSafeL3}')" style="font-size: 1rem;">🔊 Hören</button><button class="icon-btn" id="rpMicBtn_${idx}" onclick="recordRpSpeech('${jsSafeL3}', 'rpMicBtn_${idx}')" style="border-color:var(--primary); color:var(--primary); font-weight:800; font-size:1rem;">🎤 Üben</button></div></div>`; });
    document.getElementById('rpOptionsContainer').innerHTML = html;
}
function speakRpSentence(text) { const speed = parseFloat(document.getElementById('selRpSpeed').value); speak(text, conf.l3, speed); }
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
    if(allWords.length === 0) { document.getElementById('fcCardArea').style.display = 'none'; document.getElementById('fcDoneMessage').style.display = 'block'; document.getElementById('fcDoneMessage').innerHTML = "<p>Füge erst Wörter hinzu!</p>"; return; }
    let filteredWords = [...allWords]; const topicInput = document.getElementById('fcTopicInput'); const topic = useFilter && topicInput ? topicInput.value.trim() : "";
    if (topic) {
        document.getElementById('fcCardArea').style.display = 'none'; document.getElementById('fcDoneMessage').style.display = 'none'; document.getElementById('fcLoader').style.display = 'block'; const wordListL1 = allWords.map(w => w[conf.l1]).join(', ');
        const prompt = `Du bist ein intelligenter Filter. Hier ist eine Liste von Wörtern: [${wordListL1}]. Finde ALLE Wörter in dieser Liste, die thematisch in die Kategorie "${topic}" passen. Antworte AUSSCHLIESSLICH mit einem validen JSON-Array. Beispiel: ["Wort1"]`;
        const res = await callGemini(prompt); document.getElementById('fcLoader').style.display = 'none';
        if (res) { try { let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const sIdx = cleanStr.indexOf('['); const eIdx = cleanStr.lastIndexOf(']'); if (sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1); const matchedWords = JSON.parse(cleanStr); filteredWords = allWords.filter(w => matchedWords.includes(w[conf.l1])); if (filteredWords.length === 0) { showToast("Keine passenden Wörter zum Thema gefunden.", "info"); filteredWords = [...allWords]; topicInput.value = ""; } } catch(e) { showToast("⚠️ Fehler beim KI-Filtern.", "error"); filteredWords = [...allWords]; } } else { filteredWords = [...allWords]; }
    }
    fcPool = filteredWords.sort(() => 0.5 - Math.random()); fcIndex = 0; fcSessionHistory = { spaeter: [], nochmals: [], geuebt: [] }; updateFcHistoryCounts(); document.getElementById('fcHistoryList').style.display = 'none'; renderFc();
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
    ['gameRallye', 'gameHunt', 'gameDuel', 'gameAdventure'].forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
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
async function toggleLiveRecord() { const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if(!SpeechRecognition) return; if(isLiveRecording) { isLiveRecording = false; document.getElementById('btnLiveRecord').innerText = "🎤 Start"; document.getElementById('btnLiveRecord').style.background = "var(--primary-gradient)"; if(liveRecObj) liveRecObj.stop(); return; } isLiveRecording = true; document.getElementById('btnLiveRecord').innerText = "⏹️ Stopp"; document.getElementById('btnLiveRecord').style.background = "#EF4444"; liveRecObj = new SpeechRecognition(); liveRecObj.lang = ALL_LANGS[document.getElementById('liveSrcLang').value].tts; liveRecObj.continuous = true; liveRecObj.interimResults = true; liveRecObj.onresult = async (e) => { let text = ""; for(let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript; document.getElementById('liveSourceText').value = text; if(e.results[e.results.length - 1].isFinal) { document.getElementById('loaderLive').style.display = 'block'; const res = await callGemini(`Übersetze den Text streng in die Sprache ${ALL_LANGS[document.getElementById('liveTgtLang').value].name}. Gib NUR die Übersetzung zurück: "${text}"`); document.getElementById('loaderLive').style.display = 'none'; if(res) document.getElementById('liveResultText').value = res; } }; liveRecObj.onerror = (e) => logCustomError("Live Übersetzung Mikrofon", e.error); liveRecObj.onend = () => { if(isLiveRecording) liveRecObj.start(); }; liveRecObj.start(); }
function handleImageScan(input) { const file = input.files[0]; if(!file) return; document.getElementById('loader').style.display = 'block'; const reader = new FileReader(); reader.onload = (e) => { const img = new Image(); img.onload = async () => { let finalImageBase64 = e.target.result; try { const canvas = document.createElement('canvas'); let w = img.width, h = img.height; const max = 800; if(w > h && w > max) { h = Math.round(h * max / w); w = max; } else if(h > max) { w = Math.round(w * max / h); h = max; } canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h); finalImageBase64 = canvas.toDataURL('image/jpeg', 0.7); } catch(err) {} const prompt = `Look at this image. Identify the single main everyday object in it. Translate its name into these exact language codes: ${conf.l1}, ${conf.l2}, ${conf.l3}. Respond ONLY with a valid JSON object. Example format: {"${conf.l1}":"Apfel", "${conf.l2}":"Apple", "${conf.l3}":"Äpple"}`; const res = await callGemini(prompt, finalImageBase64); document.getElementById('loader').style.display = 'none'; if(res) { try { let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const sIdx = cleanStr.indexOf('{'); const eIdx = cleanStr.lastIndexOf('}'); if(sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1); const obj = JSON.parse(cleanStr); document.getElementById('inDe').value = obj[conf.l1] || ""; document.getElementById('inEn').value = obj[conf.l2] || ""; document.getElementById('inSv').value = obj[conf.l3] || ""; } catch(err) { showToast("⚠️ JSON Parsing Fehler.", "error"); } } input.value = ""; }; img.src = e.target.result; }; reader.readAsDataURL(file); }
async function handleSmartTranslate() { const txt = document.getElementById('inDe').value || document.getElementById('inEn').value || document.getElementById('inSv').value; if(!txt) return; document.getElementById('loader').style.display = "block"; try { const res = await callGemini(`Übersetze das Wort "${txt}". Antworte NUR mit einem validen JSON Objekt: {"${conf.l1}":"...", "${conf.l2}":"...", "${conf.l3}":"..."}`); let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const sIdx = cleanStr.indexOf('{'); const eIdx = cleanStr.lastIndexOf('}'); if(sIdx !== -1 && eIdx !== -1) { cleanStr = cleanStr.substring(sIdx, eIdx + 1); } const obj = JSON.parse(cleanStr); document.getElementById('inDe').value = obj[conf.l1] || ""; document.getElementById('inEn').value = obj[conf.l2] || ""; document.getElementById('inSv').value = obj[conf.l3] || ""; } catch(e) { showToast("Übersetzung fehlgeschlagen.", "error"); } document.getElementById('loader').style.display = "none"; }
function toggleVerbSection() { const vs = document.getElementById('verbSection'); vs.style.display = vs.style.display === 'block' ? 'none' : 'block'; }
async function fetchVerbForms() { const b = document.getElementById('inDe').value || document.getElementById('inEn').value; if(!b) return; document.getElementById('loader').style.display = "block"; const prompt = `Verb "${b}". JSON: {"l1P":"...", "l1F":"...", "l2P":"...", "l2F":"...", "l3P":"...", "l3F":"..."} for ${conf.l1}, ${conf.l2}, ${conf.l3}`; const res = await callGemini(prompt); document.getElementById('loader').style.display = "none"; if(res) { try { const cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const o = JSON.parse(cleanStr); document.getElementById('inDePast').value = o.l1P||""; document.getElementById('inDeFut').value = o.l1F||""; document.getElementById('inEnPast').value = o.l2P||""; document.getElementById('inEnFut').value = o.l2F||""; document.getElementById('inSvPast').value = o.l3P||""; document.getElementById('inSvFut').value = o.l3F||""} catch(e) {} } }
function listen(slot, targetId, btn) { const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SpeechRecognition) return showToast("⚠️ Browser unterstützt die integrierte Spracherkennung nicht.", "error"); try { const rec = new SpeechRecognition(); const langKey = slot === 1 ? conf.l1 : (slot === 2 ? conf.l2 : conf.l3); rec.lang = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) ? ALL_LANGS[langKey].tts : 'de-DE'; btn.classList.add('mic-active'); rec.onresult = (e) => { document.getElementById(targetId).value = e.results[0][0].transcript; }; rec.onerror = (e) => { btn.classList.remove('mic-active'); if (e.error === 'not-allowed') showToast("⚠️ Mikrofon-Zugriff verweigert.", "error"); }; rec.onend = () => btn.classList.remove('mic-active'); rec.start(); } catch(err) { btn.classList.remove('mic-active'); } }
function editWord(id) { const w = allWords.find(item => item.id === id); if(!w) return; document.getElementById('editId').value = id; document.getElementById('inDe').value = w[conf.l1] || ""; document.getElementById('inEn').value = w[conf.l2] || ""; document.getElementById('inSv').value = w[conf.l3] || ""; document.getElementById('addTitle').innerText = "✎ Bearbeiten"; document.getElementById('cancelBtn').style.display = "block"; showTab('add'); }
function resetAddForm() { document.getElementById('editId').value = ""; ['inDe','inEn','inSv'].forEach(id => document.getElementById(id).value = ""); document.getElementById('addTitle').innerText = "➕ Neues Wort"; document.getElementById('cancelBtn').style.display = "none"; }
function debouncedFilterListWords() { clearTimeout(listDebounceTimer); listDebounceTimer = setTimeout(renderList, 300); }
function renderList() { const q = document.getElementById('listSearch') ? document.getElementById('listSearch').value.toLowerCase().trim() : ""; const filtered = q ? allWords.filter(w => (w[conf.l1] && w[conf.l1].toLowerCase().includes(q)) || (w[conf.l3] && w[conf.l3].toLowerCase().includes(q))) : allWords; document.getElementById('listCont').innerHTML = filtered.map(w => `<div class="card" style="padding:15px; margin-bottom:10px;"><div class="word-item-actions"><button class="icon-btn" onclick="editWord('${w.id}')" style="padding:8px; font-size:1rem;">✎</button><button class="icon-btn danger" onclick="delWord('${w.id}')" style="padding:8px; font-size:1rem;">X</button></div><div style="font-weight:800; color:var(--primary); font-size:1.1rem; padding-right:80px;"><span class="level-dot lvl-${w.level||0}"></span>${escapeHTML(w[conf.l1])}</div><div style="color:var(--text-light); font-size:0.9rem; margin-top:5px; padding-left: 20px;">${escapeHTML(w[conf.l3])} | ${escapeHTML(w[conf.l2])}</div></div>`).join(''); }
async function delWord(id) { if(!db) return; if(confirm("Löschen?")) { await db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(id).delete(); refreshData(); } }
function getNextReviewTimestamp(level) { const daysToWait = [0, 1, 3, 7, 14, 30]; const nextDate = new Date(); nextDate.setDate(nextDate.getDate() + (daysToWait[level] || 0)); return nextDate.getTime(); }
function manualSave() { if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info"); const eid = document.getElementById('editId').value; const d = { [conf.l1]: document.getElementById('inDe').value, [conf.l2]: document.getElementById('inEn').value, [conf.l3]: document.getElementById('inSv').value }; if(!d[conf.l1]) return showToast("Bitte Feld 1 ausfüllen!", "error"); const ref = db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex); if(!eid) { d.ts = firebase.firestore.FieldValue.serverTimestamp(); d.level = 0; d.nextReview = getNextReviewTimestamp(0); } const promise = eid ? ref.doc(eid).update(d) : ref.add(d); promise.then(() => { if(!eid) { playSound('success'); addXP(10); statsToday.added++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); if(statsToday.added === 2) { addXP(15); fireConfetti(); } } resetAddForm(); refreshData(); if(!isFastInputMode) showTab('list'); else showToast("✅ Wort gespeichert!", "success"); }).catch(e => logCustomError("Wort speichern", e)); }
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
  {de:"gelb",en:"yellow",sv:"gul"},{de:"orange",en:"orange",sv:"orange"},{de:"lila",en:"purple",sv:"lila"},
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
  {de:"gehen",en:"to go",sv:"att gå"},{de:"kommen",en:"to come",sv:"att komma"},{de:"laufen",en:"to run",sv:"att springa"},
  {de:"stehen",en:"to stand",sv:"att stå"},{de:"sitzen",en:"to sit",sv:"att sitta"},{de:"schlafen",en:"to sleep",sv:"att sova"},
  {de:"essen",en:"to eat",sv:"att äta"},{de:"trinken",en:"to drink",sv:"att dricka"},{de:"sprechen",en:"to speak",sv:"att tala"},
  {de:"hören",en:"to hear",sv:"att höra"},{de:"sehen",en:"to see",sv:"att se"},{de:"kaufen",en:"to buy",sv:"att köpa"},
  {de:"lesen",en:"to read",sv:"att läsa"},{de:"schreiben",en:"to write",sv:"att skriva"},{de:"spielen",en:"to play",sv:"att spela"},
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
  {de:"Rechnung",en:"Bill",sv:"Nota"},{de:"Trinkgeld",en:"Tip",sv:"Dricks"},{de:"Tisch",en:"Table",sv:"Bord"},
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
];

async function importDefaultWords() {
    if (!currentUser || !db) return;
    const flagKey = 'defaultImported_' + currentUser.uid + '_' + currentCollIndex;
    if (localStorage.getItem(flagKey)) return;
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
        localStorage.setItem(flagKey, '1');
        showToast('✅ ' + DEFAULT_WORDS.length + ' Standardwörter importiert!', 'success');
        refreshData();
    } catch(e) { logCustomError('importDefaultWords', e); }
}

async function forceImportDefaultWords() {
    if (!currentUser || !db) { showToast('⚠️ Warte auf Datenbank-Verbindung...', 'error'); return; }
    const flagKey = 'defaultImported_' + currentUser.uid + '_' + currentCollIndex;
    localStorage.removeItem(flagKey);
    showToast('⏳ Importiere Standardwörter...', 'info');
    await importDefaultWords();
}

async function refreshData() { if(!currentUser || !db) return; const s = await db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).orderBy("ts", "desc").get(); if(s) { allWords = s.docs.map(d => ({id: d.id, ...d.data()})); document.getElementById('wordCount').innerText = allWords.length; renderList(); if (allWords.length === 0) importDefaultWords(); } }
function generateStudyList() { if(!allWords.length) { document.getElementById('studyContainer').innerHTML = "<p style='text-align:center;'>Füge zuerst Wörter hinzu!</p>"; document.getElementById('studyActions').style.display = 'none'; return; } const now = Date.now(); let dueWords = allWords.filter(w => !w.nextReview || w.nextReview <= now); if(dueWords.length === 0) { document.getElementById('studyContainer').innerHTML = "<p style='text-align:center; font-size:1.2rem;'>🎉 Alle aktuellen Vokabeln gelernt!<br>Komm morgen wieder.</p>"; document.getElementById('studyWordCount').innerText="Fertig"; document.getElementById('studyActions').style.display = 'none'; return; } document.getElementById('studyActions').style.display = 'flex'; studyWords = dueWords.sort(() => 0.5 - Math.random()).slice(0, 15); studyIndex = 0; renderStudyWord(); }
function renderStudyWord() { if(!studyWords.length) return; const w = studyWords[studyIndex]; document.getElementById('studyWordCount').innerText = `${studyIndex+1}/${studyWords.length}`; document.getElementById('studyContainer').innerHTML = `<div style="text-align:center; margin-bottom:10px;"><span class="level-dot lvl-${w.level||0}"></span><span style="font-size:0.8rem; color:var(--text-light); font-weight:bold;">Level ${w.level||0}</span></div><div style="font-size:2.2rem; font-weight:800; color:var(--primary); text-align:center; margin:10px 0;">${escapeHTML(w[conf.l1])}</div><div style="text-align:center; margin-bottom:15px;"><div style="font-size:1.5rem;">${ALL_LANGS[conf.l3].flag} ${escapeHTML(w[conf.l3])} <button class="icon-btn" style="display:inline-flex; border:none; background:transparent;" onclick="speak('${safeJS(w[conf.l3])}','${conf.l3}')">🔊</button></div></div><div style="text-align:center;"><div style="font-size:1.2rem; color:var(--text-light);">${ALL_LANGS[conf.l2].flag} ${escapeHTML(w[conf.l2])}</div></div>`; }
async function markWord(correct) { if(!studyWords.length || !currentUser || !db) return; const w = studyWords[studyIndex]; let lvl = w.level || 0; if(correct) { lvl = Math.min(5, lvl + 1); playSound('success'); addXP(5); statsToday.learned++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); if(statsToday.learned === 5) { addXP(20); fireConfetti(); } } else { lvl = Math.max(0, lvl - 1); playSound('error'); } w.level = lvl; w.nextReview = getNextReviewTimestamp(lvl); db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(w.id).update({level: lvl, nextReview: w.nextReview}); setTimeout(nextStudyWord, 300); }
function nextStudyWord() { studyIndex++; if(studyIndex >= studyWords.length) { fireConfetti(); generateStudyList(); } else { renderStudyWord(); } }

window.onload = () => { try { init(); } catch(e) { console.error("Kritischer Fehler beim Starten:", e); } };
