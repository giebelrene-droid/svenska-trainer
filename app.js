// --- Das Toast-Benachrichtigungssystem ---
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

// --- Kern-Variablen ---
let db = null; let currentUser = null; let errorLog = JSON.parse(localStorage.getItem('trainerErrorLog') || '[]');
function logCustomError(context, error) { const entry = `[${new Date().toLocaleTimeString()}] ${context}: ${error}`; errorLog.unshift(entry); if (errorLog.length > 50) errorLog.pop(); localStorage.setItem('trainerErrorLog', JSON.stringify(errorLog)); }

try {
    firebase.initializeApp({ apiKey: "AIzaSyB4ViTtin8mGcayWbXX-UtpTpPF5E4u68Q", authDomain: "uebersetzer-d-eng-swe.firebaseapp.com", projectId: "uebersetzer-d-eng-swe" }); 
    db = firebase.firestore(); db.enablePersistence().catch((e)=>{});
} catch(err) { if(document.getElementById('offlineBanner')) document.getElementById('offlineBanner').style.display = 'block'; }

const ALL_LANGS = { 'de':{name:'Deutsch',tts:'de-DE',flag:'🇩🇪'}, 'en':{name:'Englisch',tts:'en-US',flag:'🇬🇧'}, 'sv':{name:'Schwedisch',tts:'sv-SE',flag:'🇸🇪'}, 'fr':{name:'Französisch',tts:'fr-FR',flag:'🇫🇷'}, 'no':{name:'Norwegisch',tts:'nb-NO',flag:'🇳🇴'}, 'es':{name:'Spanisch',tts:'es-ES',flag:'🇪🇸'}, 'it':{name:'Italienisch',tts:'it-IT',flag:'🇮🇹'} };
let userNames = ['Papa', 'Mama', 'Kind 1', 'Kind 2']; let currentCollIndex = 0; let conf = { l1: 'de', l2: 'en', l3: 'sv' }; let allWords = [];
let studyWords = []; let studyIndex = 0; let fcPool = []; let fcIndex = 0; let fcSessionHistory = { spaeter: [], nochmals: [], geuebt: [] }; let currentFcListType = '';
let geminiApiKey = localStorage.getItem('trainerGeminiKey') || ""; let currentApiKeyIndex = 0; let cachedGeminiModel = null;
let isAudioRunning = false; let cancelAudio = false; let audioHistory = []; let currentAudioSentence = { l1: "", l3: "" }; let availableVoices = [];

// --- Init & Hilfsfunktionen ---
function loadVoices() { availableVoices = window.speechSynthesis.getVoices(); updateVoiceDropdown(); }
if(window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = loadVoices; setTimeout(loadVoices, 500); }
function updateVoiceDropdown() { const voiceSelect = document.getElementById('selAudioVoice'); if(!voiceSelect) return; const currentLangCode = ALL_LANGS[conf.l3].tts.split('-')[0]; const matchingVoices = availableVoices.filter(v => v.lang.startsWith(currentLangCode)); let html = '<option value="">🤖 Standard-Stimme</option>'; matchingVoices.forEach(v => { html += `<option value="${v.name}">${v.name}</option>`; }); voiceSelect.innerHTML = html; }

function escapeHTML(str) { return !str ? "" : String(str).replace(/[&<>'"]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[m]); }
function safeJS(str) { return !str ? "" : String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;"); }

function init() { 
    if(document.getElementById('inpGeminiKey')) document.getElementById('inpGeminiKey').value = geminiApiKey; 
    loadUserLangs(); renderRenameInputs(); updateUserDropdown(); populateLangSelects(); refreshData();
    if(typeof firebase !== 'undefined') { firebase.auth().signInAnonymously(); firebase.auth().onAuthStateChanged((user) => { if (user) { currentUser = user; refreshData(); } }); }
}

function showTab(n) { 
    if(isAudioRunning && n !== 'audio') toggleAudioTrainer();
    document.querySelectorAll('.nav-scroll button').forEach(b=>b.classList.remove('active')); 
    const btnMap = { 'add':'btn1', 'flashcards':'btnFlash', 'chat':'btn8', 'live':'btn7', 'study':'btn5', 'list':'btn3', 'arcade':'btnArcade', 'story':'btnStory', 'roleplay':'btnRoleplay', 'audio':'btnAudio' };
    if(btnMap[n] && document.getElementById(btnMap[n])) document.getElementById(btnMap[n]).classList.add('active');
    const tabs = ['tabAdd', 'tabFlashcards', 'tabChat','tabLive','tabStudy','tabList','tabArcade','tabStory','tabRoleplay', 'tabAudio'];
    tabs.forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
    const activeTab = document.getElementById('tab' + n.charAt(0).toUpperCase() + n.slice(1));
    if(activeTab) activeTab.style.display = 'block';
}

// --- AUDIO-TRAINER LOGIK ---
let currentUtterance = null;
function speakAsync(text, langKey, rate = 1.0) {
    return new Promise((resolve) => {
        if (!('speechSynthesis' in window) || cancelAudio) return resolve();
        
        currentUtterance = new SpeechSynthesisUtterance(text);
        currentUtterance.lang = (ALL_LANGS[langKey] && ALL_LANGS[langKey].tts) ? ALL_LANGS[langKey].tts : 'de-DE';
        currentUtterance.rate = rate;
        
        if (langKey === conf.l3) {
            const vS = document.getElementById('selAudioVoice');
            if (vS && vS.value) { const v = availableVoices.find(v => v.name === vS.value); if (v) currentUtterance.voice = v; }
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
        isAudioRunning = false; cancelAudio = true; window.speechSynthesis.cancel();
        btn.innerHTML = "▶️ Audio-Trainer starten"; btn.style.background = "linear-gradient(135deg, #a855f7, #ec4899)";
        return;
    }
    isAudioRunning = true; cancelAudio = false; btn.innerHTML = "⏹️ Audio-Trainer stoppen"; btn.style.background = "#EF4444";
    audioTrainerLoop();
}

async function audioTrainerLoop() {
    while (isAudioRunning && !cancelAudio) {
        document.getElementById('audioLoader').style.display = 'block';
        const prompt = `Erstelle EINEN realistischen Satz auf Niveau ${document.getElementById('selAudioDiff').value}. JSON: {"l1": "Deutscher Satz", "l3": "Übersetzung in ${ALL_LANGS[conf.l3].name}"}`;
        const res = await callGemini(prompt);
        document.getElementById('audioLoader').style.display = 'none';

        if (!res || cancelAudio) { await sleepAsync(2000); continue; }
        let sObj; try { sObj = JSON.parse(res.replace(/`{3}/g, '')); } catch(e) { continue; }

        currentAudioSentence = { l1: sObj.l1, l3: sObj.l3 };
        document.getElementById('audioDisplayL1').innerText = sObj.l1;
        document.getElementById('audioDisplayL3').innerText = "";

        const slowRate = parseFloat(document.getElementById('selAudioSlow').value);
        const pauseMs = parseInt(document.getElementById('selAudioPause').value) * 1000;
        const reps = parseInt(document.getElementById('selAudioReps').value);

        await speakAsync(sObj.l1, conf.l1, 1.0);
        await sleepAsync(600);
        document.getElementById('audioDisplayL3').innerText = sObj.l3;
        await speakAsync(sObj.l3, conf.l3, 1.0);
        await sleepAsync(pauseMs);

        for (let i = 0; i < reps; i++) {
            if (cancelAudio) break;
            await speakAsync(sObj.l3, conf.l3, slowRate);
            await sleepAsync(pauseMs);
        }

        if (!cancelAudio) await speakAsync(sObj.l3, conf.l3, 1.0);
        await sleepAsync(2000);
    }
}

function saveAudioSentence() {
    if(!currentUser || !db) return showToast("Warte auf Datenbank...", "info");
    db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).add({
        [conf.l1]: currentAudioSentence.l1, [conf.l3]: currentAudioSentence.l3,
        ts: firebase.firestore.FieldValue.serverTimestamp(), level: 0, nextReview: getNextReviewTimestamp(0)
    }).then(() => { playSound('success'); showToast("✅ Satz gespeichert!", "success"); refreshData(); });
}

// Basis-Funktionen die in der HTML-Datei aufgerufen werden
function langChanged() { conf.l1 = document.getElementById('selL1').value; conf.l3 = document.getElementById('selL3').value; localStorage.setItem('trainerLangs_' + currentCollIndex, JSON.stringify(conf)); populateLangSelects(); updateVoiceDropdown(); }
function populateLangSelects() { const opts = Object.keys(ALL_LANGS).map(k => `<option value="${k}">${ALL_LANGS[k].flag} ${ALL_LANGS[k].name}</option>`).join(''); ['selL1','selL3'].forEach(id => { const el = document.getElementById(id); if(el) el.value = conf[id.replace('sel', '').toLowerCase()]; }); }
function refreshData() { if(!currentUser || !db) return; db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).orderBy("ts", "desc").get().then(s => { allWords = s.docs.map(d => ({id: d.id, ...d.data()})); }); }
function getNextReviewTimestamp(level) { const days = [0, 1, 3, 7, 14, 30]; const nextDate = new Date(); nextDate.setDate(nextDate.getDate() + (days[level] || 0)); return nextDate.getTime(); }

window.onload = () => { try { init(); } catch(e) {} };
