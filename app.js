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

// --- Kern-Variablen & Firebase ---
let db = null; let currentUser = null; let allWords = []; let conf = { l1: 'de', l2: 'en', l3: 'sv' };
let errorLog = JSON.parse(localStorage.getItem('trainerErrorLog') || '[]');
let geminiApiKey = localStorage.getItem('trainerGeminiKey') || "";
let isAudioRunning = false; let cancelAudio = false; let audioHistory = []; let currentUtterance = null;
let availableVoices = [];

function logCustomError(context, error) { console.error(context, error); }

try {
    firebase.initializeApp({ apiKey: "AIzaSyB4ViTtin8mGcayWbXX-UtpTpPF5E4u68Q", authDomain: "uebersetzer-d-eng-swe.firebaseapp.com", projectId: "uebersetzer-d-eng-swe" });
    db = firebase.firestore();
} catch(err) { console.error("Firebase Fehler", err); }

// --- Audio-Trainer Logik ---
function loadVoices() { availableVoices = window.speechSynthesis.getVoices(); updateVoiceDropdown(); }
window.speechSynthesis.onvoiceschanged = loadVoices;

function updateVoiceDropdown() {
    const vS = document.getElementById('selAudioVoice');
    if(!vS) return;
    const lang = ALL_LANGS[conf.l3].tts.split('-')[0];
    const voices = availableVoices.filter(v => v.lang.startsWith(lang));
    vS.innerHTML = '<option value="">🤖 Standard-Stimme</option>' + voices.map(v => `<option value="${v.name}">${v.name}</option>`).join('');
}

function speakAsync(text, langKey, rate = 1.0) {
    return new Promise((resolve) => {
        if (!('speechSynthesis' in window) || cancelAudio) return resolve();
        currentUtterance = new SpeechSynthesisUtterance(text);
        currentUtterance.lang = ALL_LANGS[langKey].tts;
        currentUtterance.rate = rate;
        if (langKey === conf.l3) {
            const vS = document.getElementById('selAudioVoice');
            if (vS?.value) { const v = availableVoices.find(v => v.name === vS.value); if (v) currentUtterance.voice = v; }
        }
        currentUtterance.onend = () => resolve();
        window.speechSynthesis.speak(currentUtterance);
    });
}

async function toggleAudioTrainer() {
    const btn = document.getElementById('btnStartAudio');
    if (isAudioRunning) {
        isAudioRunning = false; cancelAudio = true; window.speechSynthesis.cancel();
        btn.innerHTML = "▶️ Audio-Trainer starten"; btn.style.background = "var(--primary-gradient)";
        return;
    }
    isAudioRunning = true; cancelAudio = false; btn.innerHTML = "⏹️ Audio-Trainer stoppen"; btn.style.background = "#EF4444";
    
    while (isAudioRunning) {
        document.getElementById('audioLoader').style.display = 'block';
        const prompt = `Erstelle EINEN realistischen Satz auf Niveau ${document.getElementById('selAudioDiff').value}. JSON: {"l1": "Deutscher Satz", "l3": "Übersetzung in ${ALL_LANGS[conf.l3].name}"}`;
        const res = await callGemini(prompt);
        document.getElementById('audioLoader').style.display = 'none';
        if (!res) { await new Promise(r => setTimeout(r, 2000)); continue; }
        const s = JSON.parse(res.replace(/`{3}json/g, '').replace(/`{3}/g, ''));
        document.getElementById('audioDisplayL1').innerText = s.l1;
        document.getElementById('audioDisplayL3').innerText = s.l3;
        
        await speakAsync(s.l1, conf.l1, 1.0);
        await new Promise(r => setTimeout(r, 1000));
        await speakAsync(s.l3, conf.l3, 1.0);
        
        const reps = parseInt(document.getElementById('selAudioReps').value);
        for(let i=0; i<reps; i++) {
            if(cancelAudio) break;
            await new Promise(r => setTimeout(r, parseInt(document.getElementById('selAudioPause').value)*1000));
            await speakAsync(s.l3, conf.l3, parseFloat(document.getElementById('selAudioSlow').value));
        }
        if(!cancelAudio) await speakAsync(s.l3, conf.l3, 1.0);
        await new Promise(r => setTimeout(r, 2000));
    }
}

// --- Kern-API Logik ---
async function callGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey.split(',')[0]}`;
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

// --- Die restlichen App-Funktionen (Liste, Flashcards, Speichern) ---
function refreshData() {
    if(!currentUser || !db) return;
    db.collection('users').doc(currentUser.uid).collection('words_'+currentCollIndex).orderBy("ts", "desc").get()
      .then(s => { allWords = s.docs.map(d => ({id: d.id, ...d.data()})); document.getElementById('wordCount').innerText = allWords.length; renderList(); });
}

function renderList() { 
    if(!document.getElementById('listCont')) return;
    document.getElementById('listCont').innerHTML = allWords.map(w => `<div class="card">${escapeHTML(w[conf.l1])} | ${escapeHTML(w[conf.l3])}</div>`).join(''); 
}

function init() {
    loadVoices();
    if(typeof firebase !== 'undefined') {
        firebase.auth().signInAnonymously();
        firebase.auth().onAuthStateChanged(user => { if(user) { currentUser = user; refreshData(); } });
    }
}

window.onload = init;
