/**
 * SprachTutor AI - KOMPLETTE APP.JS (Version 30.0)
 * Alle Funktionen in einer Datei vereint.
 */

// 1. KERN-INITIALISIERUNG
const ALL_LANGS = { 'de':{name:'Deutsch',tts:'de-DE',flag:'🇩🇪'}, 'en':{name:'Englisch',tts:'en-US',flag:'🇬🇧'}, 'sv':{name:'Schwedisch',tts:'sv-SE',flag:'🇸🇪'} };
let db, currentUser, allWords = [], conf = { l1: 'de', l2: 'en', l3: 'sv' }, isAudioRunning = false, cancelAudio = false, availableVoices = [];

function init() {
    firebase.initializeApp({ apiKey: "AIzaSyB4ViTtin8mGcayWbXX-UtpTpPF5E4u68Q", authDomain: "uebersetzer-d-eng-swe.firebaseapp.com", projectId: "uebersetzer-d-eng-swe" });
    db = firebase.firestore();
    firebase.auth().signInAnonymously().then(() => { currentUser = firebase.auth().currentUser; refreshData(); });
    window.speechSynthesis.onvoiceschanged = () => availableVoices = window.speechSynthesis.getVoices();
    showTab('add');
}

// 2. AUDIO-TRAINER & LAUTSPRECHER-LOGIK (GEFIXTER BUTTON-MODUS)
function speak(text, langKey, rate = 1.0) {
    window.speechSynthesis.cancel();
    setTimeout(() => {
        let msg = new SpeechSynthesisUtterance(text);
        msg.lang = ALL_LANGS[langKey]?.tts || 'de-DE';
        msg.rate = rate;
        window.speechSynthesis.speak(msg);
    }, 50);
}

async function toggleAudioTrainer() {
    const btn = document.getElementById('btnStartAudio');
    if (isAudioRunning) {
        isAudioRunning = false; cancelAudio = true; window.speechSynthesis.cancel();
        btn.innerText = "▶️ Audio-Trainer starten"; btn.style.background = "var(--primary)";
        return;
    }
    isAudioRunning = true; cancelAudio = false; btn.innerText = "⏹️ Stoppen"; btn.style.background = "#EF4444";
    while (isAudioRunning) {
        const prompt = `Erstelle einen Satz. JSON: {"l1": "Deutscher Satz", "l3": "Übersetzung"}`;
        const res = await callGemini(prompt);
        if(!res) { await new Promise(r => setTimeout(r, 2000)); continue; }
        const s = JSON.parse(res.replace(/`{3}/g, ''));
        document.getElementById('audioDisplayL1').innerText = s.l1;
        document.getElementById('audioDisplayL3').innerText = s.l3;
        await speakAsync(s.l1, conf.l1);
        await new Promise(r => setTimeout(r, 1000));
        await speakAsync(s.l3, conf.l3);
        await new Promise(r => setTimeout(r, 3000));
    }
}

async function speakAsync(text, langKey, rate = 1.0) {
    return new Promise((res) => {
        let msg = new SpeechSynthesisUtterance(text);
        msg.lang = ALL_LANGS[langKey]?.tts || 'de-DE';
        msg.onend = () => res();
        window.speechSynthesis.speak(msg);
    });
}

// 3. DATENBANK & KI-API
async function refreshData() {
    const s = await db.collection('users').doc(currentUser.uid).collection('words').orderBy("ts", "desc").get();
    allWords = s.docs.map(d => ({id: d.id, ...d.data()}));
    document.getElementById('wordCount').innerText = allWords.length + " Wörter";
}

async function callGemini(prompt) {
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${localStorage.getItem('trainerGeminiKey')}`, {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const d = await res.json();
        return d.candidates[0].content.parts[0].text;
    } catch(e) { return null; }
}

// 4. UI-STEUERUNG
function showTab(n) {
    ['tabAdd', 'tabList', 'tabAudio', 'tabChat'].forEach(id => document.getElementById(id).style.display = (id === 'tab' + n.charAt(0).toUpperCase() + n.slice(1)) ? 'block' : 'none');
}

window.onload = init;
