/**
 * DeadDrop P2P - UI Orchestration & Event Binding Layer
 * Exposes DOM bindings, handles screens transitions, and feeds user events
 * into the DeadDropConnection WebRTC backend.
 */

// Global connection handle
let p2p = null;

// Helper to format bytes cleanly
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Initialize connection callbacks
function initConnectionHandle() {
    p2p = new DeadDropConnection({
        onStatusChange: (text, type) => {
            updateStatusUI(text, type);
            if (type === 'connected') {
                showScreen('screenWorkspace');
            } else if (type === 'disconnected') {
                resetUI();
            }
        },
        onIceGathered: (base64SDP) => {
            if (p2p.isHost) {
                document.getElementById('hostOfferText').value = base64SDP;
                document.getElementById('connectBtn').disabled = false;
                updateStatusUI('Waiting for Friend', 'connecting');
            } else {
                document.getElementById('joinAnswerText').value = base64SDP;
                document.getElementById('joinResponseStep').classList.remove('hidden');
                updateStatusUI('Handshake Pending', 'connecting');
            }
        },
        onMessageReceived: (text, side) => {
            appendChatMessage(text, side);
        },
        onFileIncoming: (filename, size) => {
            // Display the incoming file approval panel
            const modal = document.getElementById('incomingFileModal');
            document.getElementById('incomingFileName').innerText = filename;
            document.getElementById('incomingFileSize').innerText = formatBytes(size);
            modal.classList.remove('hidden');

            // Hide "Stream to Disk" button if browser doesn't support the File System Access API
            const streamBtn = document.getElementById('acceptStreamBtn');
            if (!window.showSaveFilePicker) {
                streamBtn.classList.add('hidden');
            } else {
                streamBtn.classList.remove('hidden');
            }
        },
        onFileProgress: (percent, action) => {
            updateProgress(percent, action === 'sending' ? 'Uploading...' : 'Downloading...');
        },
        onFileCompleted: (blob, filename, isDirectSave) => {
            // Hide incoming dialog if open
            document.getElementById('incomingFileModal').classList.add('hidden');

            if (isDirectSave) {
                // Already saved direct to disk!
                updateProgress(100, 'Saved directly to disk!');
            } else if (blob) {
                // Fallback in-memory assembly: Trigger automatic browser download
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                updateProgress(100, 'Assembled in memory & saved!');
            } else {
                // We are the sender
                updateProgress(100, 'Sent successfully!');
            }
            
            setTimeout(() => {
                document.getElementById('progressCard').classList.add('hidden');
            }, 3500);
        }
    });
}

// UI Screen Routing
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function updateStatusUI(text, type) {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    statusDot.className = 'status-dot';
    statusText.innerText = `State: ${text}`;

    if (type === 'connecting') {
        statusDot.classList.add('pulsing');
    } else if (type === 'connected') {
        statusDot.classList.add('connected');
    }
}

function showToast() {
    const toast = document.getElementById('toast');
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
}

function copyToken(elementId) {
    const textarea = document.getElementById(elementId);
    textarea.select();
    document.execCommand('copy');
    showToast();
}

function resetUI() {
    document.getElementById('hostOfferText').value = '';
    document.getElementById('hostAnswerText').value = '';
    document.getElementById('joinOfferText').value = '';
    document.getElementById('joinAnswerText').value = '';
    document.getElementById('joinResponseStep').classList.add('hidden');
    document.getElementById('connectBtn').disabled = true;
    document.getElementById('chatMessages').innerHTML = '<div class="msg msg-system">Peer connection established. Message history is private and locally cached.</div>';
    document.getElementById('incomingFileModal').classList.add('hidden');
    document.getElementById('progressCard').classList.add('hidden');
    
    updateStatusUI('Disconnected', 'disconnected');
    showScreen('screenRole');
}

// Main back/reset trigger
function resetState() {
    if (p2p) {
        p2p.closeConnection();
    }
    p2p = null;
    resetUI();
}

// ================================================================== //
// HOST SETUP TRIGGER
// ================================================================== //
function initHost() {
    initConnectionHandle();
    p2p.initHost();
    showScreen('screenHost');
}

function hostConnect() {
    const answer = document.getElementById('hostAnswerText').value.trim();
    if (answer) {
        p2p.handleAnswer(answer);
    }
}

// ================================================================== //
// JOIN SETUP TRIGGER
// ================================================================== //
function initJoin() {
    initConnectionHandle();
    p2p.initJoin();
    showScreen('screenJoin');
}

function handleOfferInput() {
    const offer = document.getElementById('joinOfferText').value.trim();
    if (offer) {
        p2p.handleOffer(offer);
    }
}

// ================================================================== //
// CHAT FUNCTIONALITY
// ================================================================== //
function handleChatKeyPress(event) {
    if (event.key === 'Enter') {
        sendChatMessage();
    }
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !p2p) return;

    p2p.sendMessage(text);
    input.value = '';
}

function appendChatMessage(text, side) {
    const chatMessages = document.getElementById('chatMessages');
    const msgEl = document.createElement('div');
    msgEl.className = `msg msg-${side}`;
    msgEl.innerText = text;
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ================================================================== //
// FILE TRANSFER UI FUNCTIONALITY
// ================================================================== //
function triggerFileSelect() {
    if (!p2p || !p2p.fileChannel || p2p.fileChannel.readyState !== 'open') {
        alert("Connect to a peer before sending files.");
        return;
    }
    document.getElementById('fileInput').click();
}

function handleFileSelected(event) {
    const files = event.target.files;
    if (files.length > 0) {
        p2p.sendFile(files[0]);
    }
}

function showProgressCard(filename) {
    const card = document.getElementById('progressCard');
    card.classList.remove('hidden');
    document.getElementById('progressFileName').innerText = filename;
    document.getElementById('progressPercent').innerText = '0%';
    document.getElementById('progressBarFill').style.width = '0%';
}

function updateProgress(percent, statusText) {
    document.getElementById('progressPercent').innerText = `${percent}%`;
    document.getElementById('progressBarFill').style.width = `${percent}%`;
    document.getElementById('progressState').innerText = statusText;
}

// Accept file triggers from prompt modal
async function acceptStreamToDisk() {
    document.getElementById('incomingFileModal').classList.add('hidden');
    showProgressCard(p2p.receivedMetadata.name);
    updateProgress(0, 'Initializing disk write...');
    await p2p.acceptFileTransfer(true);
}

async function acceptSaveToMemory() {
    document.getElementById('incomingFileModal').classList.add('hidden');
    showProgressCard(p2p.receivedMetadata.name);
    updateProgress(0, 'Initializing memory buffer...');
    await p2p.acceptFileTransfer(false);
}

// Wire buttons
document.getElementById('acceptStreamBtn').addEventListener('click', acceptStreamToDisk);
document.getElementById('acceptMemoryBtn').addEventListener('click', acceptSaveToMemory);

// Drag & Drop event bindings
const dropzone = document.getElementById('dropzone');
dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    
    if (!p2p || !p2p.fileChannel || p2p.fileChannel.readyState !== 'open') {
        alert("Connect to a peer before sending files.");
        return;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
        p2p.sendFile(files[0]);
    }
});
