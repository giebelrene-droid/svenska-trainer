// --- Das Toast-Benachrichtigungssystem ---
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    const bgColors = { 'success': 'var(--secondary)', 'error': '#EF4444', 'info': 'var(--primary)' };

    toast.style.backgroundColor = bgColors[type] || bgColors['info'];
    toast.style.color = 'white';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '12px';
    toast.style.fontWeight = '600';
    toast.style.fontSize = '0.9rem';
    toast.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.2)';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    toast.style.transition = 'all 0.3s ease-out';
    toast.innerText = message;

    container.appendChild(toast);

    setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; }, 10);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(20px)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

let db = null;
let currentUser = null;
let errorLog = JSON.parse(localStorage.getItem('trainerErrorLog') || '[]');

function logCustomError(context, error) {
    const time = new Date().toLocaleTimeString();
    const msg = error instanceof Error ? error.message : String(error);
    const entry = `[${time}] ${context}: ${msg}`;
    
    errorLog.unshift(entry);
    if (errorLog.length > 50) errorLog.pop(); 
    localStorage.setItem('trainerErrorLog', JSON.stringify(errorLog));
    
    console.error("Custom Log:", entry);
    if(document.getElementById('errorLogOverlay') && document.getElementById('errorLogOverlay').style.display === 'flex') {
        renderErrorLog();
    }
}

window.onerror = function(message, source, lineno, colno, error) { logCustomError("Global Error", `${message} (Zeile ${lineno})`); };
window.addEventListener('unhandledrejection', function(event) { logCustomError("Unhandled Promise", event.reason); });

function openErrorLog() { document.getElementById('settingsOverlay').style.display = 'none'; document.getElementById('errorLogOverlay').style.display = 'flex'; renderErrorLog(); }
function closeErrorLog() { document.getElementById('errorLogOverlay').style.display = 'none'; }
function clearErrorLog() { errorLog = []; localStorage.setItem('trainerErrorLog', JSON.stringify(errorLog)); renderErrorLog(); }

function renderErrorLog() {
    const el = document.getElementById('errorLogList');
    if (!el) return;
    if (errorLog.length === 0) el.innerHTML = "Alles läuft reibungslos. Keine Fehler aufgezeichnet!";
    else el.innerHTML = errorLog.map(e => `<div>${escapeHTML(e)}</div>`).join('<hr style="border-color:#374151; margin:5px 0;">');
}

try {
    const firebaseConfig = { apiKey: "AIzaSyB4ViTtin8mGcayWbXX-UtpTpPF5E4u68Q", authDomain: "uebersetzer-d-eng-swe.firebaseapp.com", projectId: "uebersetzer-d-eng-swe" };
    firebase.initializeApp(firebaseConfig); 
    db = firebase.firestore();
    db.enablePersistence().catch((e)=>{ logCustomError("Firebase Offline Cache", e); });
} catch(err) {
    console.error("Firebase konnte nicht geladen werden:", err); logCustomError("Firebase Init", err);
    if(document.getElementById('offlineBanner')) document.getElementById('offlineBanner').style.display = 'block';
}

const ALL_LANGS = { 
    'de':{name:'Deutsch',tts:'de-DE',flag:'🇩🇪'}, 'en':{name:'Englisch',tts:'en-US',flag:'🇬🇧'}, 
    'sv':{name:'Schwedisch',tts:'sv-SE',flag:'🇸🇪'}, 'fr':{name:'Französisch',tts:'fr-FR',flag:'🇫🇷'}, 
    'no':{name:'Norwegisch',tts:'nb-NO',flag:'🇳🇴'}, 'es':{name:'Spanisch',tts:'es-ES',flag:'🇪🇸'}, 
    'it':{name:'Italienisch',tts:'it-IT',flag:'🇮🇹'} 
};

let userNames = ['Papa', 'Mama', 'Kind 1', 'Kind 2']; 
let currentCollIndex = 0;
let conf = { l1: 'de', l2: 'en', l3: 'sv' }; 
let allWords = [];
let studyWords = [];
let studyIndex = 0;
let fcPool = [];
let fcIndex = 0;
let fcSessionHistory = { spaeter: [], nochmals: [], geuebt: [] };
let currentFcListType = '';
let activeRpSentenceForFeedback = "";
let rpOptionsBuffer = null;
let rpFetchPromise = null;
let rpMicTimer = null;
let rpCurrentTranscript = "";
let geminiApiKey = localStorage.getItem('trainerGeminiKey') || "";
let currentApiKeyIndex = 0;
let cachedGeminiModel = null;
let isLiveRecording = false;
let liveRecObj = null;
let isChatSessionActive = false;
let chatRec = null;
let duelWordObj = null;
let duelCanTap = false;
let huntTarget = "";
let listDebounceTimer;
let isFastInputMode = localStorage.getItem('trainerFastInput') !== 'false';
let userXP = parseInt(localStorage.getItem('trainerXP') || '0');
let userStreak = parseInt(localStorage.getItem('trainerStreak') || '0');
let lastActiveDate = localStorage.getItem('trainerLastDate') || '';

let statsToday = {learned:0, added:0, date:""};
try { 
    const rawStats = localStorage.getItem('trainerStatsToday');
    if(rawStats && rawStats !== "undefined") statsToday = JSON.parse(rawStats); 
} catch(e) {}

// --- Audio-Trainer Variablen ---
let isAudioRunning = false;
let cancelAudio = false;
let audioHistory = []; 
let currentAudioSentence = { l1: "", l3: "" };
let currentUtterance = null; // GANZ WICHTIG GEGEN ABBRÜCHE

// --- Stimmen laden ---
let availableVoices = [];
function loadVoices() {
    availableVoices = window.speechSynthesis.getVoices();
    updateVoiceDropdown();
}
if(window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
    setTimeout(loadVoices, 500); 
}

function updateVoiceDropdown() {
    const voiceSelect = document.getElementById('selAudioVoice');
    if(!voiceSelect) return;
    
    const currentLangCode = ALL_LANGS[conf.l3].tts.split('-')[0]; 
    const matchingVoices = availableVoices.filter(v => v.lang.startsWith(currentLangCode));
    
    let html = '<option value="">🤖 Standard-Stimme</option>';
    matchingVoices.forEach(v => { html += `<option value="${v.name}">${v.name}</option>`; });
    voiceSelect.innerHTML = html;
}

function escapeHTML(str) { return !str ? "" : String(str).replace(/[&<>'"]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[m]); }
function safeJS(str) { return !str ? "" : String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;"); }

function removeBrokenServiceWorkers() {
    if('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for(let registration of registrations) { registration.unregister(); }
        }).catch(()=>{});
    }
}

function init() { 
    removeBrokenServiceWorkers(); 
    if(document.getElementById('inpGeminiKey')) document.getElementById('inpGeminiKey').value = geminiApiKey; 
    
    try {
        const storedNames = localStorage.getItem('trainerUserNames'); 
        if(storedNames) userNames = JSON.parse(storedNames);
        const savedIdx = localStorage.getItem('trainerUserIdx'); 
        if(savedIdx) currentCollIndex = parseInt(savedIdx);
    } catch(e){}
    
    const todayStr = new Date().toDateString();
    if(statsToday.date !== todayStr) { 
        statsToday = {learned:0, added:0, date:todayStr}; 
        localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); 
    }
    
    loadUserLangs(); renderRenameInputs(); updateUserDropdown(); populateLangSelects(); checkStreak(); updateQuests(); updateSaveModeUI(); 
    showTab('add'); 
    
    if(typeof firebase !== 'undefined') {
        firebase.auth().signInAnonymously().catch((e)=>{ logCustomError("Firebase Auth", e); });
        firebase.auth().onAuthStateChanged((user) => { if (user) { currentUser = user; refreshData(); } });
    }
}

function updateSaveModeUI() {
    const btn = document.getElementById('btnSaveMode');
    if(!btn) return;
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
        const windowAudio = window.AudioContext || window.webkitAudioContext;
        if(!windowAudio) return;
        const ctx = new windowAudio(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        if(type === 'success') { osc.type = 'sine'; osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1); gain.gain.setValueAtTime(0.1, ctx.currentTime); osc.start(); osc.stop(ctx.currentTime + 0.15); } 
        else if(type === 'error') { osc.type = 'sawtooth'; osc.frequency.setValueAtTime(300, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.2); gain.gain.setValueAtTime(0.1, ctx.currentTime); osc.start(); osc.stop(ctx.currentTime + 0.25); } 
    } catch(e){}
}

function fireConfetti() {
    const colors = ['#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#3B82F6'];
    for(let i=0; i<50; i++) { 
        const c = document.createElement('div'); c.className = 'confetti'; 
        c.style.left = Math.random() * 100 + 'vw'; c.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)]; 
        c.style.top = '-10px'; c.style.animationDuration = (Math.random() * 2 + 2) + 's'; 
        document.body.appendChild(c); setTimeout(() => c.remove(), 4000); 
    }
    playSound('success');
}

function speak(text, langKey, rate = 1.0) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); 
        const msg = new SpeechSynthesisUtterance(text);
        msg.lang = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) ? ALL_LANGS[langKey].tts : 'de-DE';
        msg.rate = rate;
        window.speechSynthesis.speak(msg);
    }
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
    ['selL1','selL2','selL3','liveSrcLang','liveTgtLang','chatSrcLang','chatTgtLang'].forEach(id => { 
        const el = document.getElementById(id); if(!el) return; el.innerHTML = opts; 
        if(id === 'selL1') el.value = conf.l1; if(id === 'selL2') el.value = conf.l2; if(id === 'selL3') el.value = conf.l3; if(id === 'chatTgtLang') el.value = conf.l3; 
    }); 
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

async function callGemini(prompt, imageBase64 = null, systemPrompt = null) {
    const keys = geminiApiKey.split(',').map(k => k.trim()).filter(k => k);
    if(keys.length === 0) { showToast("⚠️ Bitte hinterlege mindestens einen API-Key in den Einstellungen.", "error"); return null; }

    const activeLoader = Array.from(document.querySelectorAll('.loader')).find(el => el.offsetWidth > 0);
    const originalLoaderText = activeLoader ? activeLoader.innerText : "";

    if (!cachedGeminiModel) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keys[0]}`);
            const data = await res.json();
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

    const waitTimes = [0, 2000, 4000, 8000, 15000]; 
    let lastErrorMsg = "";
    
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
            } catch(e) {
                lastErrorMsg = e.message; logCustomError(`API Key Failed`, e.message); currentApiKeyIndex++;
            }
        }
    }

    if (activeLoader) activeLoader.innerText = originalLoaderText;
    if (lastErrorMsg.toLowerCase().includes("overloaded")) showToast("⚠️ Die Google KI-Server sind im Moment überlastet. Bitte warte kurz!", "error");
    else if (lastErrorMsg.toLowerCase().includes("quota")) showToast("⚠️ API-Limit erreicht! Kurze Pause machen.", "error");
    else showToast("⚠️ Fehler bei der API-Abfrage: " + lastErrorMsg, "error");
    return null;
}

function invalidateRpBuffer() { rpOptionsBuffer = null; }
function checkCustomTopic() { const sel = document.getElementById('selRpTopic').value; document.getElementById('customTopicRow').style.display = sel === 'custom' ? 'flex' : 'none'; invalidateRpBuffer(); }

async function fetchRpSentencesFromGemini() {
    const selTopic = document.getElementById('selRpTopic').value;
    let topic = selTopic === 'custom' ? document.getElementById('inpCustomTopic').value.trim() || "Allgemeines Gespräch" : selTopic;
    const tgtLangName = ALL_LANGS[conf.l3].name;
    const diffSelect = document.getElementById('selRpDifficulty');
    const diffText = diffSelect.options[diffSelect.selectedIndex].text;
    const intentions = ["eine höfliche Formulierung", "eine zielgerichtete Frage", "eine typische Antwort", "eine Bitte", "eine kurze Feststellung", "eine alltägliche Interaktion"];
    const intention = intentions[Math.floor(Math.random()*intentions.length)];
    const randomSeed = Math.floor(Math.random() * 10000);
    
    const prompt = `Du bist ein professioneller Sprachtrainer. Erstelle für das Szenario/Thema "${topic}" exakt DREI völlig unterschiedliche, aber absolut realistische Antwortmöglichkeiten in ${tgtLangName}. Niveau: ${diffText}. Satz 1: Höflich. Satz 2: Kurz/informell. Satz 3: Frage. Aspekt: ${intention} (ID: ${randomSeed}). Antworte AUSSCHLIESSLICH im folgenden JSON-Format: [{"l3": "...", "l1": "..."}, {"l3": "...", "l1": "..."}, {"l3": "...", "l1": "..."}]`;
    
    const res = await callGemini(prompt);
    if(res) {
        try {
            let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); 
            const sIdx = cleanStr.indexOf('['); const eIdx = cleanStr.lastIndexOf(']'); 
            if(sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1); 
            return JSON.parse(cleanStr);
        } catch(e) { logCustomError("JSON Parsing Szenarien", e); return null; }
    }
    return null;
}

function prefetchRpSentences() { if (!rpFetchPromise) { rpFetchPromise = fetchRpSentencesFromGemini().then(options => { if (options) { rpOptionsBuffer = options; } rpFetchPromise = null; }); } }

async function startRoleplay() {
    document.getElementById('rpArea').style.display = 'block'; document.getElementById('rpFeedbackBox').style.display = 'none';
    let topic = document.getElementById('selRpTopic').value;
    if(topic === 'custom') topic = document.getElementById('inpCustomTopic').value.trim() || "Allgemeines Gespräch";
    document.getElementById('rpTopicDisplay').innerText = topic.toUpperCase();
    await generateRpSentence();
}

async function generateRpSentence() {
    document.getElementById('rpFeedbackBox').style.display = 'none'; document.getElementById('rpOptionsContainer').innerHTML = ""; document.getElementById('btnRpRefresh').style.display = 'none'; document.getElementById('rpLoader').style.display = 'block';
    let options = null;
    if (rpOptionsBuffer) { options = rpOptionsBuffer; rpOptionsBuffer = null; } 
    else if (rpFetchPromise) { await rpFetchPromise; options = rpOptionsBuffer; rpOptionsBuffer = null; } 
    else { options = await fetchRpSentencesFromGemini(); }

    document.getElementById('rpLoader').style.display = 'none'; document.getElementById('btnRpRefresh').style.display = 'inline-block';
    if(options) { renderRpOptions(options); prefetchRpSentences(); } 
    else { document.getElementById('rpOptionsContainer').innerHTML = `<div style="text-align:center; color:#EF4444; font-weight:bold;">⚠️ Konnte Sätze nicht laden.</div>`; }
}

function renderRpOptions(options) {
    let html = '';
    options.forEach((opt, idx) => {
        const jsSafeL3 = safeJS(opt.l3);
        html += `<div class="rp-option"><div class="rp-option-text">${escapeHTML(opt.l3)}</div><div class="rp-option-trans">${escapeHTML(opt.l1)}</div><div class="rp-option-actions"><button class="icon-btn" onclick="speakRpSentence('${jsSafeL3}')" style="font-size: 1rem;">🔊 Hören</button><button class="icon-btn" id="rpMicBtn_${idx}" onclick="recordRpSpeech('${jsSafeL3}', 'rpMicBtn_${idx}')" style="border-color:var(--primary); color:var(--primary); font-weight:800; font-size:1rem;">🎤 Üben</button></div></div>`;
    });
    document.getElementById('rpOptionsContainer').innerHTML = html;
}

function speakRpSentence(text) { const speed = parseFloat(document.getElementById('selRpSpeed').value); speak(text, conf.l3, speed); }

function recordRpSpeech(targetSentence, btnId) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; 
    if (!SpeechRecognition) return showToast("⚠️ Dein Browser unterstützt das Mikrofon leider nicht.", "error");
    
    try {
        const rec = new SpeechRecognition(); rec.lang = (ALL_LANGS[conf.l3] && ALL_LANGS[conf.l3].tts) ? ALL_LANGS[conf.l3].tts : 'sv-SE'; rec.continuous = true; rec.interimResults = true; 
        const btn = document.getElementById(btnId); if(btn) btn.classList.add('mic-active');
        activeRpSentenceForFeedback = targetSentence; rpCurrentTranscript = ""; document.getElementById('rpUserSaid').innerText = "...";
        
        const waitTimeMs = parseInt(document.getElementById('selRpMicPatience').value) * 1000;
        const resetTimer = () => { clearTimeout(rpMicTimer); rpMicTimer = setTimeout(() => { rec.stop(); }, waitTimeMs); };

        rec.onstart = () => { resetTimer(); };
        rec.onresult = (e) => { let text = ""; for(let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript; rpCurrentTranscript = text; document.getElementById('rpUserSaid').innerText = rpCurrentTranscript; resetTimer(); };
        rec.onerror = (e) => { clearTimeout(rpMicTimer); if(btn) btn.classList.remove('mic-active'); if (e.error === 'not-allowed') showToast("⚠️ Mikrofon-Zugriff blockiert.", "error"); };
        rec.onend = async () => { clearTimeout(rpMicTimer); if(btn) btn.classList.remove('mic-active'); if (rpCurrentTranscript.trim().length > 0) { const textToEval = rpCurrentTranscript; rpCurrentTranscript = ""; fastEvaluateSpeech(textToEval, activeRpSentenceForFeedback, 'rpFeedbackBox', 'rpFeedbackText'); } else { document.getElementById('rpUserSaid').innerText = "Nichts gehört."; } };
        rec.start();
    } catch(err) { if(document.getElementById(btnId)) document.getElementById(btnId).classList.remove('mic-active'); }
}

function fastEvaluateSpeech(spokenText, targetText, boxId, textId) {
    document.getElementById(boxId).style.display = 'none';
    const cleanSpoken = spokenText.toLowerCase().replace(/[.,!?;:]/g, '').trim();
    const cleanTarget = targetText.toLowerCase().replace(/[.,!?;:]/g, '').trim();
    let feedback = "";
    
    if(cleanSpoken === cleanTarget || cleanTarget.includes(cleanSpoken) || cleanSpoken.includes(cleanTarget)) {
        feedback = "Perfekt! Sehr gut ausgesprochen. 🌟"; addXP(5); playSound('success');
    } else {
        const targetWords = cleanTarget.split(' '); const spokenWords = cleanSpoken.split(' '); let matches = 0;
        targetWords.forEach(w => { if(spokenWords.includes(w)) matches++; });
        const matchPercentage = matches / targetWords.length;
        if(matchPercentage > 0.6) { feedback = "Gute Arbeit! Die meisten Wörter waren richtig."; addXP(3); playSound('success'); } 
        else if (matchPercentage > 0.3) { feedback = "Ich habe einige Wörter erkannt, aber der Satz war noch nicht ganz richtig."; playSound('error'); } 
        else { feedback = "Das habe ich leider nicht verstanden. Bitte sprich etwas lauter."; playSound('error'); }
    }
    document.getElementById(textId).innerText = feedback; document.getElementById(boxId).style.display = 'block';
    setTimeout(() => { document.getElementById(boxId).scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
}

function speakLiveResult() { const text = document.getElementById('liveResultText').value; const lang = document.getElementById('liveTgtLang').value; if(text) speak(text, lang); }
function saveLiveTranslation() {
    const srcLang = document.getElementById('liveSrcLang').value; const tgtLang = document.getElementById('liveTgtLang').value;
    const srcText = document.getElementById('liveSourceText').value.trim(); const tgtText = document.getElementById('liveResultText').value.trim();
    if(!srcText || !tgtText) return showToast("Bitte erst etwas übersetzen!", "error");
    if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    
    let d = { [conf.l1]: "", [conf.l2]: "", [conf.l3]: "" };
    if(srcLang === conf.l1) d[conf.l1] = srcText; else if(srcLang === conf.l2) d[conf.l2] = srcText; else if(srcLang === conf.l3) d[conf.l3] = srcText;
    if(tgtLang === conf.l1) d[conf.l1] = tgtText; else if(tgtLang === conf.l2) d[conf.l2] = tgtText; else if(tgtLang === conf.l3) d[conf.l3] = tgtText;
    if(!d[conf.l1]) d[conf.l1] = srcText; if(!d[conf.l3]) d[conf.l3] = tgtText;
    
    d.ts = firebase.firestore.FieldValue.serverTimestamp(); d.level = 0; d.nextReview = getNextReviewTimestamp(0);
    db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).add(d).then(() => { playSound('success'); showToast("✅ Vokabel gespeichert!", "success"); refreshData(); statsToday.added++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); if(statsToday.added === 2) { addXP(15); fireConfetti(); } }).catch(e => logCustomError("Speichern Live-Translation", e));
}

async function initFlashcards(useFilter = false) {
    if(allWords.length === 0) { document.getElementById('fcCardArea').style.display = 'none'; document.getElementById('fcDoneMessage').style.display = 'block'; document.getElementById('fcDoneMessage').innerHTML = "<p>Füge erst Wörter hinzu!</p>"; return; }
    let filteredWords = [...allWords]; const topicInput = document.getElementById('fcTopicInput'); const topic = useFilter && topicInput ? topicInput.value.trim() : "";

    if (topic) {
        document.getElementById('fcCardArea').style.display = 'none'; document.getElementById('fcDoneMessage').style.display = 'none'; document.getElementById('fcLoader').style.display = 'block';
        const wordListL1 = allWords.map(w => w[conf.l1]).join(', ');
        const prompt = `Du bist ein intelligenter Filter. Hier ist eine Liste von Wörtern: [${wordListL1}]. Finde ALLE Wörter in dieser Liste, die thematisch in die Kategorie "${topic}" passen. Antworte AUSSCHLIESSLICH mit einem validen JSON-Array. Beispiel: ["Wort1"]`;
        const res = await callGemini(prompt); document.getElementById('fcLoader').style.display = 'none';

        if (res) {
            try {
                let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim(); const sIdx = cleanStr.indexOf('['); const eIdx = cleanStr.lastIndexOf(']'); if (sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1);
                const matchedWords = JSON.parse(cleanStr); filteredWords = allWords.filter(w => matchedWords.includes(w[conf.l1]));
                if (filteredWords.length === 0) { showToast("Keine passenden Wörter zum Thema gefunden.", "info"); filteredWords = [...allWords]; topicInput.value = ""; }
            } catch(e) { showToast("⚠️ Fehler beim KI-Filtern.", "error"); filteredWords = [...allWords]; }
        } else { filteredWords = [...allWords]; }
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
    try {
        const rec = new SpeechRecognition(); rec.lang = (ALL_LANGS[conf.l3] && ALL_LANGS[conf.l3].tts) ? ALL_LANGS[conf.l3].tts : 'sv-SE';
        const btn = document.getElementById('fcMicBtn'); btn.classList.add('mic-active');
        const targetWord = fcPool[fcIndex][conf.l3]; document.getElementById('fcFeedbackBox').style.display = 'none';
        rec.onresult = (e) => { const spokenText = e.results[0][0].transcript; btn.classList.remove('mic-active'); document.getElementById('fcUserSaid').innerText = spokenText; fastEvaluateSpeech(spokenText, targetWord, 'fcFeedbackBox', 'fcFeedbackText'); };
        rec.onerror = (e) => { btn.classList.remove('mic-active'); if (e.error === 'not-allowed') showToast("⚠️ Mikrofon-Zugriff blockiert.", "error"); };
        rec.onend = () => btn.classList.remove('mic-active'); rec.start();
    } catch(err) { document.getElementById('fcMicBtn').classList.remove('mic-active'); }
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

function openMiniGame(game) { document.getElementById('arcadeMenu').style.display = game === 'Menu' ? 'grid' : 'none'; ['gameRallye', 'gameHunt', 'gameDuel', 'gameAdventure'].forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; }); if(game !== 'Menu') { document.getElementById('game' + game).style.display = 'block'; if(game === 'Hunt') initHunt(); } }
function playRallyeRound() { const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if(!SpeechRecognition) return showToast("Dein Browser unterstützt das Mikrofon leider nicht.", "error"); const rec = new SpeechRecognition(); rec.lang = ALL_LANGS[conf.l3].tts; document.getElementById('btnRallyeMic').classList.add('mic-active'); rec.onresult = async (e) => { const word = e.results[0][0].transcript; document.getElementById('rallyeLoader').style.display = 'block'; const res = await callGemini(`Ist das Wort "${word}" in der Sprache ${ALL_LANGS[conf.l3].name} ein Tier? Antworte NUR mit JA oder NEIN.`); document.getElementById('rallyeLoader').style.display = 'none'; if(res && res.toUpperCase().includes("JA")) { playSound('success'); addXP(15); showToast(`Richtig! "${word}" ist ein Tier. +15 XP`, "success"); } else { playSound('error'); showToast(`Falsch. KI hat "${word}" nicht als Tier erkannt.`, "error"); } }; rec.onend = () => document.getElementById('btnRallyeMic').classList.remove('mic-active'); rec.onerror = (e) => logCustomError("Rallye Mikrofon", e.error); rec.start(); }
function initHunt() { huntTarget = allWords.length ? allWords[Math.floor(Math.random()*allWords.length)][conf.l3] : "Apfel"; document.getElementById('huntTargetWord').innerText = huntTarget; document.getElementById('huntResult').innerText = ""; }
function checkHuntImage(input) { const file = input.files[0]; if(!file) return; document.getElementById('huntLoader').style.display = 'block'; const reader = new FileReader(); reader.onload = (e) => { const img = new Image(); img.onload = async () => { let finalImageBase64 = e.target.result; try { const canvas = document.createElement('canvas'); let w = img.width, h = img.height; const max = 800; if(w > h && w > max) { h = Math.round(h * max / w); w = max; } else if(h > max) { w = Math.round(w * max / h); h = max; } canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h); finalImageBase64 = canvas.toDataURL('image/jpeg', 0.7); } catch(canvasErr) {} const c = await callGemini(`Look at this image. Is this an image of a "${huntTarget}"? Answer STRICTLY with the word YES or NO and nothing else.`, finalImageBase64); document.getElementById('huntLoader').style.display = 'none'; if(c && c.toUpperCase().includes("YES")) { document.getElementById('huntResult').innerText = "✅ Richtig!"; playSound('success'); addXP(20); } else if (c) { document.getElementById('huntResult').innerText = "❌ Falsch. KI sagte: " + c; playSound('error'); } input.value = ""; }; img.src = e.target.result; }; reader.readAsDataURL(file); }
function startDuelRound() { if(!allWords.length) return showToast("Bitte erst Wörter hinzufügen!", "error"); document.getElementById('duelWord').innerText = "Warten..."; duelCanTap = false; setTimeout(() => { duelWordObj = allWords[Math.floor(Math.random()*allWords.length)]; document.getElementById('duelWord').innerText = duelWordObj[conf.l1]; duelCanTap = true; }, 1500); }
function duelTap(p) { if(!duelCanTap) return; duelCanTap = false; const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; if(!SpeechRecognition) return; const rec = new SpeechRecognition(); rec.lang = ALL_LANGS[conf.l3].tts; rec.onresult = (e) => { const s = e.results[0][0].transcript.toLowerCase(); if(s.includes(duelWordObj[conf.l3].toLowerCase())) { document.getElementById('duelResult').innerText = `Punkt für ${p}!`; playSound('success'); } else { document.getElementById('duelResult').innerText = "Falsch"; playSound('error'); } }; rec.onerror = (e) => logCustomError("Duel Mikrofon", e.error); rec.start(); }
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

function manualSave() {
    if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    const eid = document.getElementById('editId').value;
    const d = { [conf.l1]: document.getElementById('inDe').value, [conf.l2]: document.getElementById('inEn').value, [conf.l3]: document.getElementById('inSv').value };
    if(!d[conf.l1]) return showToast("Bitte Feld 1 ausfüllen!", "error");
    
    const ref = db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex);
    if(!eid) { d.ts = firebase.firestore.FieldValue.serverTimestamp(); d.level = 0; d.nextReview = getNextReviewTimestamp(0); }
    
    const promise = eid ? ref.doc(eid).update(d) : ref.add(d);
    promise.then(() => { 
        if(!eid) { playSound('success'); addXP(10); statsToday.added++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); if(statsToday.added === 2) { addXP(15); fireConfetti(); } } 
        resetAddForm(); refreshData(); 
        if(!isFastInputMode) showTab('list'); else showToast("✅ Wort gespeichert!", "success");
    }).catch(e => logCustomError("Wort speichern", e));
}

async function refreshData() { if(!currentUser || !db) return; const s = await db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).orderBy("ts", "desc").get(); if(s) { allWords = s.docs.map(d => ({id: d.id, ...d.data()})); document.getElementById('wordCount').innerText = allWords.length; renderList(); } }
function generateStudyList() { if(!allWords.length) { document.getElementById('studyContainer').innerHTML = "<p style='text-align:center;'>Füge zuerst Wörter hinzu!</p>"; document.getElementById('studyActions').style.display = 'none'; return; } const now = Date.now(); let dueWords = allWords.filter(w => !w.nextReview || w.nextReview <= now); if(dueWords.length === 0) { document.getElementById('studyContainer').innerHTML = "<p style='text-align:center; font-size:1.2rem;'>🎉 Alle aktuellen Vokabeln gelernt!<br>Komm morgen wieder.</p>"; document.getElementById('studyWordCount').innerText="Fertig"; document.getElementById('studyActions').style.display = 'none'; return; } document.getElementById('studyActions').style.display = 'flex'; studyWords = dueWords.sort(() => 0.5 - Math.random()).slice(0, 15); studyIndex = 0; renderStudyWord(); }
function renderStudyWord() { if(!studyWords.length) return; const w = studyWords[studyIndex]; document.getElementById('studyWordCount').innerText = `${studyIndex+1}/${studyWords.length}`; document.getElementById('studyContainer').innerHTML = `<div style="text-align:center; margin-bottom:10px;"><span class="level-dot lvl-${w.level||0}"></span><span style="font-size:0.8rem; color:var(--text-light); font-weight:bold;">Level ${w.level||0}</span></div><div style="font-size:2.2rem; font-weight:800; color:var(--primary); text-align:center; margin:10px 0;">${escapeHTML(w[conf.l1])}</div><div style="text-align:center; margin-bottom:15px;"><div style="font-size:1.5rem;">${ALL_LANGS[conf.l3].flag} ${escapeHTML(w[conf.l3])} <button class="icon-btn" style="display:inline-flex; border:none; background:transparent;" onclick="speak('${safeJS(w[conf.l3])}','${conf.l3}')">🔊</button></div></div><div style="text-align:center;"><div style="font-size:1.2rem; color:var(--text-light);">${ALL_LANGS[conf.l2].flag} ${escapeHTML(w[conf.l2])}</div></div>`; }
async function markWord(correct) { if(!studyWords.length || !currentUser || !db) return; const w = studyWords[studyIndex]; let lvl = w.level || 0; if(correct) { lvl = Math.min(5, lvl + 1); playSound('success'); addXP(5); statsToday.learned++; localStorage.setItem('trainerStatsToday', JSON.stringify(statsToday)); updateQuests(); if(statsToday.learned === 5) { addXP(20); fireConfetti(); } } else { lvl = Math.max(0, lvl - 1); playSound('error'); } w.level = lvl; w.nextReview = getNextReviewTimestamp(lvl); db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).doc(w.id).update({level: lvl, nextReview: w.nextReview}); setTimeout(nextStudyWord, 300); }
function nextStudyWord() { studyIndex++; if(studyIndex >= studyWords.length) { fireConfetti(); generateStudyList(); } else { renderStudyWord(); } }


// --- AUDIO-TRAINER LOGIK (MIT GEDÄCHTNIS & STIMMEN) ---
function speakAsync(text, langKey, rate = 1.0) {
    return new Promise((resolve) => {
        if (!('speechSynthesis' in window) || cancelAudio) return resolve();
        
        currentUtterance = new SpeechSynthesisUtterance(text);
        currentUtterance.lang = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) ? ALL_LANGS[langKey].tts : 'de-DE';
        currentUtterance.rate = rate;
        
        if (langKey === conf.l3) {
            const voiceSelect = document.getElementById('selAudioVoice');
            if (voiceSelect && voiceSelect.value) {
                const selectedVoice = availableVoices.find(v => v.name === voiceSelect.value);
                if (selectedVoice) currentUtterance.voice = selectedVoice;
            }
        }
        
        currentUtterance.onend = () => { currentUtterance = null; resolve(); };
        currentUtterance.onerror = () => { currentUtterance = null; resolve(); };
        window.speechSynthesis.speak(currentUtterance);
    });
}

const sleepAsync = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function toggleAudioTrainer() {
    const btn = document.getElementById('btnStartAudio');
    if (isAudioRunning) {
        isAudioRunning = false;
        cancelAudio = true;
        window.speechSynthesis.cancel(); 
        btn.innerHTML = "▶️ Audio-Trainer starten";
        btn.style.background = "linear-gradient(135deg, #a855f7, #ec4899)";
        document.getElementById('audioDisplayL1').innerText = "Pausiert.";
        document.getElementById('audioDisplayL3').innerText = "";
        return;
    }
    
    isAudioRunning = true;
    cancelAudio = false;
    btn.innerHTML = "⏹️ Audio-Trainer stoppen";
    btn.style.background = "#EF4444";
    audioTrainerLoop();
}

async function audioTrainerLoop() {
    while (isAudioRunning && !cancelAudio) {
        document.getElementById('audioLoader').style.display = 'block';
        
        const diff = document.getElementById('selAudioDiff').value;
        const tgtLangName = ALL_LANGS[conf.l3].name;
        
        const now = Date.now();
        audioHistory = audioHistory.filter(item => (now - item.ts) < 1800000); 
        
        const avoidList = audioHistory.map(i => i.text).join('", "');
        const avoidPrompt = avoidList ? `Verwende AUF KEINEN FALL diese Sätze oder ähnliche: ["${avoidList}"]. ` : "";
        
        const topics = ["Einkaufen", "Reisen", "Arbeit", "Freizeit", "Essen und Trinken", "Wetter", "Familie", "Sport", "Gesundheit", "Verkehrsmittel", "Gefühle", "Technik", "Natur", "Wohnen"];
        const randomTopic = topics[Math.floor(Math.random() * topics.length)];
        const randomSeed = Math.floor(Math.random() * 10000); 
        
        const prompt = `Du bist ein Sprachtrainer. Erstelle EINEN realistischen Satz auf Niveau ${diff} zum Thema "${randomTopic}" (ID: ${randomSeed}). ${avoidPrompt}Gib ihn auf Deutsch und auf ${tgtLangName} zurück. JSON-Format: {"l1": "Deutscher Satz", "l3": "Übersetzung in ${tgtLangName}"}`;
        
        const res = await callGemini(prompt);
        document.getElementById('audioLoader').style.display = 'none';

        if (!res || cancelAudio) {
            if(!cancelAudio) await sleepAsync(3000);
            continue;
        }

        let sentenceObj;
        try {
            let cleanStr = res.replace(/`{3}json/gi, '').replace(/`{3}/g, '').trim();
            const sIdx = cleanStr.indexOf('{');
            const eIdx = cleanStr.lastIndexOf('}');
            if (sIdx !== -1 && eIdx !== -1) cleanStr = cleanStr.substring(sIdx, eIdx + 1);
            sentenceObj = JSON.parse(cleanStr);
        } catch (e) {
            await sleepAsync(2000);
            continue;
        }

        const l1Text = sentenceObj.l1;
        const l3Text = sentenceObj.l3;
        
        audioHistory.push({text: l1Text, ts: Date.now()});
        currentAudioSentence = { l1: l1Text, l3: l3Text }; 
        
        document.getElementById('audioDisplayL1').innerText = l1Text;
        document.getElementById('audioDisplayL3').innerText = "";

        const slowRate = parseFloat(document.getElementById('selAudioSlow').value);
        const pauseMs = parseInt(document.getElementById('selAudioPause').value) * 1000;
        const reps = parseInt(document.getElementById('selAudioReps').value) || 1;

        if (cancelAudio) break;
        await speakAsync(l1Text, conf.l1, 1.0);
        
        if (cancelAudio) break;
        await sleepAsync(600);
        document.getElementById('audioDisplayL3').innerText = l3Text;

        if (cancelAudio) break;
        await speakAsync(l3Text, conf.l3, 1.0);
        
        if (cancelAudio) break;
        await sleepAsync(pauseMs);

        for (let i = 0; i < reps; i++) {
            if (cancelAudio) break;
            await speakAsync(l3Text, conf.l3, slowRate);
            
            if (cancelAudio) break;
            await sleepAsync(pauseMs);
        }

        if (cancelAudio) break;
        await speakAsync(l3Text, conf.l3, 1.0);
        
        if (cancelAudio) break;
        await sleepAsync(2000);
    }
}

function saveAudioSentence() {
    if(!currentUser || !db) return showToast("Warte auf Datenbank-Verbindung...", "info");
    if(!currentAudioSentence.l1 || !currentAudioSentence.l3) return showToast("Kein Satz zum Speichern da!", "error");
    
    let d = { 
        [conf.l1]: currentAudioSentence.l1, 
        [conf.l2]: "", 
        [conf.l3]: currentAudioSentence.l3,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        level: 0,
        nextReview: getNextReviewTimestamp(0)
    };
    
    db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).add(d).then(() => {
        playSound('success');
        showToast("✅ Satz in Karteikarten gespeichert!", "success");
        refreshData(); 
    }).catch(e => logCustomError("Speichern Audio-Satz", e));
}

window.onload = () => { try { init(); } catch(e) { console.error("Kritischer Fehler beim Starten:", e); } };
