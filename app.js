/**
 * DeadDrop P2P - UI Orchestration & Event Binding Layer
 * Exposes DOM bindings, handles screens transitions, and feeds user events
 * into the DeadDropConnection WebRTC backend.
 * Integrates Web Audio API Synthesizer, Self-Destructing Messages,
 * a CLI Command Parser, and a File History Log.
 * 
 * Refactored to eliminate global state pollution, encapsulate app context,
 * and bind all events programmatically (removing inline HTML handlers).
 */

document.addEventListener('DOMContentLoaded', () => {
    // Encapsulated state variables
    let p2p = null;
    let isAudioCalling = false;
    let isBurnActive = false;

    // Session statistics
    let filesSentCount = 0;
    let filesReceivedCount = 0;
    let totalBytesSent = 0;
    let totalBytesReceived = 0;

    // ================================================================== //
    // WEB AUDIO SYNTHESIZER
    // ================================================================== //
    const synth = {
        ctx: null,
        init() {
            if (!this.ctx) {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            }
        },
        playTone(freq, type, duration, gainStart) {
            try {
                this.init();
                if (this.ctx.state === 'suspended') {
                    this.ctx.resume();
                }
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                
                osc.type = type || 'sine';
                osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
                
                gain.gain.setValueAtTime(gainStart || 0.1, this.ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
                
                osc.connect(gain);
                gain.connect(this.ctx.destination);
                
                osc.start();
                osc.stop(this.ctx.currentTime + duration);
            } catch (e) {
                console.warn("Synth playback failed:", e);
            }
        },
        playConnect() {
            this.playTone(523.25, 'sine', 0.15); // C5
            setTimeout(() => this.playTone(659.25, 'sine', 0.15), 100); // E5
            setTimeout(() => this.playTone(783.99, 'sine', 0.25), 200); // G5
        },
        playMessage() {
            this.playTone(880, 'triangle', 0.04, 0.05);
            setTimeout(() => this.playTone(880, 'triangle', 0.04, 0.05), 60);
        },
        playSuccessSweep() {
            try {
                this.init();
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(440, this.ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.35);
                gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.35);
                osc.connect(gain);
                gain.connect(this.ctx.destination);
                osc.start();
                osc.stop(this.ctx.currentTime + 0.35);
            } catch (e) {
                console.warn("Synth success sweep failed:", e);
            }
        },
        playTick() {
            this.playTone(600, 'triangle', 0.02, 0.04);
        }
    };

    // Helper to format bytes cleanly
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    // Initialize connection and register native custom events
    function initConnectionHandle() {
        p2p = new DeadDropConnection();

        // Listen for connection state changes
        p2p.addEventListener('statuschange', (e) => {
            const { text, type } = e.detail;
            updateStatusUI(text, type);
            if (type === 'connected') {
                synth.playConnect();
                showScreen('screenWorkspace');
            } else if (type === 'disconnected') {
                resetUI();
            }
        });

        // Listen for SDP ICE gathering completions
        p2p.addEventListener('icegathered', (e) => {
            const { token } = e.detail;
            if (p2p.isHost) {
                document.getElementById('hostOfferText').value = token;
                document.getElementById('connectBtn').disabled = false;
                updateStatusUI('Waiting for Friend', 'connecting');
            } else {
                document.getElementById('joinAnswerText').value = token;
                document.getElementById('joinResponseStep').classList.remove('hidden');
                updateStatusUI('Handshake Pending', 'connecting');
            }
        });

        // Listen for incoming chat messages
        p2p.addEventListener('message', (e) => {
            const { text, side, selfDestruct } = e.detail;
            synth.playMessage();
            appendChatMessage(text, side, selfDestruct);
        });

        // Listen for incoming control/signaling events
        p2p.addEventListener('control', (e) => {
            const packet = e.detail;
            if (packet.action === 'toggle-burn') {
                toggleBurnMode(true, packet.value);
            } else if (packet.action === 'ping') {
                if (p2p) p2p.sendControl('pong', packet.value);
            } else if (packet.action === 'pong') {
                const latency = Date.now() - packet.value;
                synth.playMessage();
                appendChatMessage(`>>> [System: Pong received. RTT latency: ${latency}ms]`, 'system');
            }
        });

        // Listen for incoming metadata packets
        p2p.addEventListener('fileincoming', (e) => {
            const { name, size } = e.detail;
            synth.playMessage();
            const modal = document.getElementById('incomingFileModal');
            document.getElementById('incomingFileName').innerText = name;
            document.getElementById('incomingFileSize').innerText = formatBytes(size);
            modal.classList.remove('hidden');

            const streamBtn = document.getElementById('acceptStreamBtn');
            if (!window.showSaveFilePicker) {
                streamBtn.classList.add('hidden');
            } else {
                streamBtn.classList.remove('hidden');
            }
        });

        // Listen for incremental file progress updates
        p2p.addEventListener('fileprogress', (e) => {
            const { percent, action } = e.detail;
            updateProgress(percent, action === 'sending' ? 'Uploading...' : 'Downloading...');
        });

        // Listen for completed file transfer events
        p2p.addEventListener('filecompleted', (e) => {
            const { blob, filename, isDirectSave, verified } = e.detail;
            synth.playSuccessSweep();
            document.getElementById('incomingFileModal').classList.add('hidden');

            let size = 0;
            let direction = 'sent';

            if (blob || isDirectSave) {
                direction = 'received';
                size = p2p.receivedMetadata ? p2p.receivedMetadata.size : 0;
                filesReceivedCount++;
                totalBytesReceived += size;

                if (blob) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    updateProgress(100, verified ? 'Verified & saved!' : 'CORRUPTED FILE SAVED!');
                } else {
                    updateProgress(100, verified ? 'Verified & saved directly!' : 'CHECKSUM VERIFICATION FAILED!');
                }
            } else {
                direction = 'sent';
                size = p2p.sendingFile ? p2p.sendingFile.size : 0;
                filesSentCount++;
                totalBytesSent += size;
                updateProgress(100, 'Sent & verified!');
            }
            
            // Add file entry to the File Log
            logFileTransfer(filename, size, direction, isDirectSave, verified);

            setTimeout(() => {
                document.getElementById('progressCard').classList.add('hidden');
            }, 3500);
        });

        // Listen for remote microphone track events
        p2p.addEventListener('remotestream', (e) => {
            const { stream } = e.detail;
            const audio = document.getElementById('remoteAudio');
            audio.srcObject = stream;
            audio.play().catch(err => console.error("Audio autoplay blocked by browser policy:", err));
            synth.playConnect();
            appendChatMessage("[System: Secure P2P voice channel opened]", 'system');
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
        synth.playMessage();
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
        document.getElementById('chatMessages').innerHTML = '<div class="msg msg-system">Link established. Network traffic is end-to-end encrypted.</div>';
        document.getElementById('incomingFileModal').classList.add('hidden');
        document.getElementById('progressCard').classList.add('hidden');
        
        // Clear audio UI elements
        const audioCallBtn = document.getElementById('audioCallBtn');
        if (audioCallBtn) {
            audioCallBtn.innerText = "[ Start Voice Call ]";
        }
        isAudioCalling = false;
        document.getElementById('remoteAudio').srcObject = null;

        // Reset Self-Destruct
        isBurnActive = false;
        const burnBtn = document.getElementById('burnToggle');
        if (burnBtn) {
            burnBtn.innerText = "[ Burn: OFF ]";
            burnBtn.className = "btn btn-sm btn-secondary";
        }

        // Reset File Log
        document.getElementById('fileLogContainer').classList.add('hidden');
        document.getElementById('fileLogList').innerHTML = '';
        filesSentCount = 0;
        filesReceivedCount = 0;
        totalBytesSent = 0;
        totalBytesReceived = 0;
        
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

    // Bind local Host connect trigger
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
    // CHAT & COMMAND FUNCTIONALITY
    // ================================================================== //
    function sendChatMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text) return;

        // Command parser routing
        if (text.startsWith('/')) {
            executeConsoleCommand(text);
        } else {
            if (!p2p) return;
            p2p.sendMessage(text, isBurnActive);
        }
        input.value = '';
    }

    function executeConsoleCommand(text) {
        const parts = text.substring(1).trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        
        // Echo the command in local chat stream
        appendChatMessage(`> ${text}`, 'sent');
        
        switch (cmd) {
            case 'ping':
                appendChatMessage("[System: Direct P2P ping request sent...]", 'system');
                if (p2p && p2p.chatChannel && p2p.chatChannel.readyState === 'open') {
                    p2p.sendControl('ping', Date.now());
                } else {
                    appendChatMessage("[System Error: Connection link inactive]", 'system');
                }
                break;
                
            case 'clear':
                document.getElementById('chatMessages').innerHTML = '<div class="msg msg-system">Console feed cleared.</div>';
                break;
                
            case 'status':
                const role = p2p ? (p2p.isHost ? 'Host' : 'Joiner') : 'None';
                const state = p2p && p2p.peerConnection ? p2p.peerConnection.iceConnectionState : 'Disconnected';
                const voice = isAudioCalling ? 'Active' : 'Inactive';
                const burn = isBurnActive ? 'Active (10s)' : 'Inactive';
                
                appendChatMessage(`[ System Link Report ]`, 'system');
                appendChatMessage(`- Mode: ${role}`, 'system');
                appendChatMessage(`- Connection: ${state.toUpperCase()}`, 'system');
                appendChatMessage(`- Voice Line: ${voice}`, 'system');
                appendChatMessage(`- Auto-Burn: ${burn}`, 'system');
                appendChatMessage(`- Session Tx: ${filesSentCount} files (${formatBytes(totalBytesSent)})`, 'system');
                appendChatMessage(`- Session Rx: ${filesReceivedCount} files (${formatBytes(totalBytesReceived)})`, 'system');
                break;
                
            case 'burn':
                toggleBurnMode();
                break;
                
            case 'voice':
                toggleAudioCall();
                break;
                
            case 'help':
            default:
                appendChatMessage(`[ Console Commands ]`, 'system');
                appendChatMessage(`/ping   - Measure round-trip P2P latency`, 'system');
                appendChatMessage(`/status - Display secure link metadata`, 'system');
                appendChatMessage(`/voice  - Toggle VoIP microphone stream`, 'system');
                appendChatMessage(`/burn   - Toggle self-destruct mode`, 'system');
                appendChatMessage(`/clear  - Flush console feed logs`, 'system');
                appendChatMessage(`/help   - Display command instructions`, 'system');
                break;
        }
    }

    function appendChatMessage(text, side, selfDestruct) {
        const chatMessages = document.getElementById('chatMessages');
        const msgEl = document.createElement('div');
        msgEl.className = `msg msg-${side}`;
        
        // Add raw text
        const textSpan = document.createElement('span');
        textSpan.innerText = text;
        msgEl.appendChild(textSpan);

        // Apply self-destruct countdown timer
        if (selfDestruct && side !== 'system') {
            let secondsLeft = 10;
            const timerSpan = document.createElement('span');
            timerSpan.className = 'burn-timer';
            timerSpan.innerText = ` [${secondsLeft}s]`;
            msgEl.appendChild(timerSpan);

            const countdownInterval = setInterval(() => {
                secondsLeft--;
                timerSpan.innerText = ` [${secondsLeft}s]`;
                
                // Play countdown ticks for the final 3 seconds
                if (secondsLeft <= 3 && secondsLeft > 0) {
                    synth.playTick();
                }

                if (secondsLeft <= 0) {
                    clearInterval(countdownInterval);
                    msgEl.style.opacity = '0';
                    msgEl.style.transition = 'opacity 0.4s ease-out';
                    setTimeout(() => {
                        msgEl.remove();
                    }, 400);
                }
            }, 1000);
        }

        chatMessages.appendChild(msgEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Toggle self-destructing message mode
    function toggleBurnMode(isRemoteTrigger = false, forcedValue = null) {
        synth.playMessage();
        const btn = document.getElementById('burnToggle');
        
        if (forcedValue !== null) {
            isBurnActive = forcedValue;
        } else {
            isBurnActive = !isBurnActive;
        }
        
        if (isBurnActive) {
            btn.innerText = "[ Burn: 10s ]";
            btn.className = "btn btn-sm btn-burn-active";
            if (isRemoteTrigger) {
                appendChatMessage("[System: Burn Mode activated by peer]", 'system');
            } else if (p2p) {
                p2p.sendControl('toggle-burn', true);
            }
        } else {
            btn.innerText = "[ Burn: OFF ]";
            btn.className = "btn btn-sm btn-secondary";
            if (isRemoteTrigger) {
                appendChatMessage("[System: Burn Mode deactivated by peer]", 'system');
            } else if (p2p) {
                p2p.sendControl('toggle-burn', false);
            }
        }
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

    // File selected trigger
    function handleFileSelected(event) {
        const files = event.target.files;
        if (files.length > 0) {
            p2p.sendFile(files[0]);
        }
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

    // Append file entry to the File Log
    function logFileTransfer(filename, size, direction, isDirectSave, verified) {
        const list = document.getElementById('fileLogList');
        const container = document.getElementById('fileLogContainer');
        container.classList.remove('hidden');
        
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const mode = isDirectSave ? 'Disk' : 'RAM';
        const directionLabel = direction === 'sent' ? 'TX' : 'RX';
        
        const item = document.createElement('div');
        if (direction === 'received') {
            const verifyLabel = verified ? ' [VERIFIED]' : ' [CORRUPT]';
            item.style.color = verified ? '#a3ffa3' : 'var(--danger-red)';
            item.innerText = `[${time}] ${directionLabel}: ${filename} (${formatBytes(size)}) - ${mode}${verifyLabel}`;
        } else {
            item.style.color = 'var(--term-green)';
            item.innerText = `[${time}] ${directionLabel}: ${filename} (${formatBytes(size)}) - ${mode} [VERIFIED]`;
        }
        
        list.appendChild(item);
        list.scrollTop = list.scrollHeight;
    }

    // ================================================================== //
    // VOICE CALL FUNCTIONALITY
    // ================================================================== //
    async function toggleAudioCall() {
        const btn = document.getElementById('audioCallBtn');
        
        if (!isAudioCalling) {
            btn.innerText = "[ Initializing mic... ]";
            try {
                await p2p.startAudioCall();
                isAudioCalling = true;
                btn.innerText = "[ Disconnect Voice ]";
                appendChatMessage("[System: Your microphone is now live on the connection]", 'system');
            } catch (err) {
                btn.innerText = "[ Start Voice Call ]";
                alert("Could not access microphone: " + err.message);
            }
        } else {
            await p2p.stopAudioCall();
            isAudioCalling = false;
            btn.innerText = "[ Start Voice Call ]";
            appendChatMessage("[System: Your microphone has been muted/disconnected]", 'system');
        }
    }

    // ================================================================== //
    // DOM EVENT BINDING LAYER
    // ================================================================== //

    // 1. Role Screen selection triggers
    document.getElementById('btnHostChoice').addEventListener('click', initHost);
    document.getElementById('btnJoinChoice').addEventListener('click', initJoin);

    // 2. Setup Screen actions
    document.getElementById('hostOfferText').addEventListener('click', function() { this.select(); });
    document.getElementById('joinAnswerText').addEventListener('click', function() { this.select(); });
    
    document.getElementById('btnHostCopyOffer').addEventListener('click', () => copyToken('hostOfferText'));
    document.getElementById('btnJoinCopyAnswer').addEventListener('click', () => copyToken('joinAnswerText'));

    document.getElementById('connectBtn').addEventListener('click', hostConnect);

    document.getElementById('btnHostAbort').addEventListener('click', resetState);
    document.getElementById('btnJoinAbort').addEventListener('click', resetState);

    document.getElementById('joinOfferText').addEventListener('input', handleOfferInput);

    // 3. Workspace Chat inputs
    document.getElementById('burnToggle').addEventListener('click', () => toggleBurnMode());
    document.getElementById('btnSendChat').addEventListener('click', sendChatMessage);
    
    document.getElementById('chatInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });

    // 4. File Dropzone triggers
    const dropzone = document.getElementById('dropzone');
    dropzone.addEventListener('click', triggerFileSelect);
    document.getElementById('fileInput').addEventListener('change', handleFileSelected);

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

    // 5. File accept modals
    document.getElementById('acceptStreamBtn').addEventListener('click', acceptStreamToDisk);
    document.getElementById('acceptMemoryBtn').addEventListener('click', acceptSaveToMemory);

    // 6. Voice Audio lines
    document.getElementById('audioCallBtn').addEventListener('click', toggleAudioCall);
});
