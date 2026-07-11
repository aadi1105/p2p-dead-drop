/**
 * DeadDrop P2P - WebRTC Connection & Streaming Layer
 * Handles serverless signaling (base64 tokens), dual data channels (chat/file),
 * chunked file streaming with flow control backpressure,
 * and P2P Voice Chat (VoIP) audio streaming.
 * 
 * Refactored to extend EventTarget to decouple UI bindings from connection logic.
 * Derives a Short Authentication String (SAS) from DTLS certificate fingerprints.
 */

// Native browser compression helpers to shrink SDP codes under Discord's 2000char limit
async function compressToken(str) {
    const stream = new Blob([str]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream('deflate'));
    const buffer = await new Response(compressedStream).arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

async function decompressToken(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    const stream = new Blob([bytes]).stream();
    const decompressedStream = stream.pipeThrough(new DecompressionStream('deflate'));
    return await new Response(decompressedStream).text();
}

/**
 * Standard SHA-256 implementation in pure JS.
 * Used for concurrent, block-by-block file hashing, preserving O(1) space complexity.
 */
class SHA256 {
    constructor() {
        this.h = new Uint32Array([
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ]);
        this.k = new Uint32Array([
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ]);
        this.buffer = new Uint8Array(64);
        this.bufferLength = 0;
        this.lengthLow = 0;
        this.lengthHigh = 0;
    }

    update(data) {
        const view = new Uint8Array(data);
        for (let i = 0; i < view.length; i++) {
            this.buffer[this.bufferLength++] = view[i];
            
            this.lengthLow += 8;
            if (this.lengthLow >= 0x100000000) {
                this.lengthLow = this.lengthLow % 0x100000000;
                this.lengthHigh++;
            }
            
            if (this.bufferLength === 64) {
                this.compress(this.buffer);
                this.bufferLength = 0;
            }
        }
    }

    compress(block) {
        const w = new Uint32Array(64);
        const words = new DataView(block.buffer, block.byteOffset, 64);
        for (let i = 0; i < 16; i++) {
            w[i] = words.getUint32(i * 4);
        }
        for (let i = 16; i < 64; i++) {
            const s0 = (this.rotr(w[i - 15], 7) ^ this.rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3));
            const s1 = (this.rotr(w[i - 2], 17) ^ this.rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10));
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }

        let a = this.h[0] | 0;
        let b = this.h[1] | 0;
        let c = this.h[2] | 0;
        let d = this.h[3] | 0;
        let e = this.h[4] | 0;
        let f = this.h[5] | 0;
        let g = this.h[6] | 0;
        let h_val = this.h[7] | 0;

        for (let i = 0; i < 64; i++) {
            const S1 = (this.rotr(e, 6) ^ this.rotr(e, 11) ^ this.rotr(e, 25));
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h_val + S1 + ch + this.k[i] + w[i]) | 0;
            const S0 = (this.rotr(a, 2) ^ this.rotr(a, 13) ^ this.rotr(a, 22));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h_val = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }

        this.h[0] = (this.h[0] + a) | 0;
        this.h[1] = (this.h[1] + b) | 0;
        this.h[2] = (this.h[2] + c) | 0;
        this.h[3] = (this.h[3] + d) | 0;
        this.h[4] = (this.h[4] + e) | 0;
        this.h[5] = (this.h[5] + f) | 0;
        this.h[6] = (this.h[6] + g) | 0;
        this.h[7] = (this.h[7] + h_val) | 0;
    }

    rotr(val, bits) {
        return (val >>> bits) | (val << (32 - bits));
    }

    digest() {
        const padLen = (this.bufferLength < 56) ? (56 - this.bufferLength) : (120 - this.bufferLength);
        const pad = new Uint8Array(padLen);
        pad[0] = 0x80;
        this.update(pad);

        const lengthBytes = new Uint8Array(8);
        const view = new DataView(lengthBytes.buffer);
        view.setUint32(0, this.lengthHigh);
        view.setUint32(4, this.lengthLow);
        this.update(lengthBytes);

        let result = '';
        for (let i = 0; i < 8; i++) {
            let hex = this.h[i].toString(16);
            while (hex.length < 8) hex = '0' + hex;
            result += hex;
        }
        return result;
    }
}

class DeadDropConnection extends EventTarget {
    constructor() {
        super();
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        this.peerConnection = null;
        this.chatChannel = null;
        this.fileChannel = null;
        this.isHost = false;
        this.sasCode = null;

        // File transfer states
        this.chunkSize = 16384; // 16KB blocks
        this.fileReader = new FileReader();
        this.sendingFile = null;
        this.sendOffset = 0;
        this.sendHasher = null;

        this.receivedMetadata = null;
        this.receivedSize = 0;
        this.receivedChunks = [];
        this.recvHasher = null;
        this.fileWritableStream = null;

        // Audio state
        this.localStream = null;
    }

    /**
     * Helper to dispatch connection events.
     */
    emit(eventName, detailData) {
        this.dispatchEvent(new CustomEvent(eventName, { detail: detailData }));
    }

    /**
     * Parses SDP to extract the DTLS SHA-256 certificate fingerprint.
     */
    extractFingerprint(sdp) {
        const match = sdp.match(/a=fingerprint:sha-256\s+([A-Fa-f0-9:]+)/i);
        return match ? match[1].toLowerCase().replace(/:/g, '') : null;
    }

    /**
     * Calculates the Short Authentication String (SAS) based on DTLS fingerprints.
     */
    async calculateSAS() {
        try {
            if (!this.peerConnection.localDescription || !this.peerConnection.remoteDescription) return;
            
            const localFP = this.extractFingerprint(this.peerConnection.localDescription.sdp);
            const remoteFP = this.extractFingerprint(this.peerConnection.remoteDescription.sdp);
            
            if (localFP && remoteFP) {
                // Lexicographically sort fingerprints to ensure order-independent outputs
                const sorted = [localFP, remoteFP].sort();
                const combined = sorted.join('|');
                
                const encoder = new TextEncoder();
                const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(combined));
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                
                // Format as XX-XX-XX
                this.sasCode = `${hashHex.substring(0, 2)}-${hashHex.substring(2, 4)}-${hashHex.substring(4, 6)}`.toUpperCase();
                this.emit('sasready', { sas: this.sasCode });
            }
        } catch (err) {
            console.error("Failed to compute DTLS certificate SAS code:", err);
        }
    }

    /**
     * Initializes the WebRTC connection as the HOST.
     */
    async initHost() {
        this.isHost = true;
        this.emit('statuschange', { text: 'Puncturing NAT...', type: 'connecting' });

        this.peerConnection = new RTCPeerConnection(this.rtcConfig);

        // Pre-create audio transceiver for seamless voice call setup
        this.peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

        this.chatChannel = this.peerConnection.createDataChannel("chat");
        this.fileChannel = this.peerConnection.createDataChannel("file");

        this.bindChannelEvents(this.chatChannel);
        this.bindFileChannelEvents(this.fileChannel);
        this.bindIceEvents();
        this.bindTrackEvents();

        try {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
        } catch (err) {
            console.error("Failed to create offer:", err);
            this.emit('statuschange', { text: 'Failed to host', type: 'disconnected' });
        }
    }

    /**
     * Initializes the WebRTC connection as the JOINER.
     */
    async initJoin() {
        this.isHost = false;
        this.emit('statuschange', { text: 'Awaiting connection code', type: 'disconnected' });

        this.peerConnection = new RTCPeerConnection(this.rtcConfig);

        // Pre-create audio transceiver on joiner side as well
        this.peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

        this.peerConnection.ondatachannel = event => {
            const channel = event.channel;
            if (channel.label === "chat") {
                this.chatChannel = channel;
                this.bindChannelEvents(this.chatChannel);
            } else if (channel.label === "file") {
                this.fileChannel = channel;
                this.bindFileChannelEvents(this.fileChannel);
            }
        };

        this.bindIceEvents();
        this.bindTrackEvents();
    }

    /**
     * Handles setting up listeners for the ICE gathering phase.
     */
    bindIceEvents() {
        this.peerConnection.onicegatheringstatechange = async () => {
            if (this.peerConnection.iceGatheringState === 'complete') {
                // Compress the generated local token using native Gzip/Deflate
                const token = JSON.stringify(this.peerConnection.localDescription);
                const compressedToken = await compressToken(token);
                this.emit('icegathered', { token: compressedToken });
            }
        };
    }

    /**
     * Binds media track receiver events.
     */
    bindTrackEvents() {
        this.peerConnection.ontrack = event => {
            const remoteStream = event.streams[0] || new MediaStream([event.track]);
            this.emit('remotestream', { stream: remoteStream });
        };
    }

    /**
     * Pastes the Host's offer and generates a local response (Answer).
     */
    async handleOffer(base64Offer) {
        try {
            const decompressed = await decompressToken(base64Offer);
            const sdp = JSON.parse(decompressed);
            this.emit('statuschange', { text: 'Puncturing NAT...', type: 'connecting' });

            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
        } catch (err) {
            console.error("Error handling offer:", err);
            this.emit('statuschange', { text: 'Error processing code', type: 'disconnected' });
            throw err;
        }
    }

    /**
     * Pastes the Joiner's answer to complete the handshake.
     */
    async handleAnswer(base64Answer) {
        try {
            const decompressed = await decompressToken(base64Answer);
            const sdp = JSON.parse(decompressed);
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            this.emit('statuschange', { text: 'Connecting...', type: 'connecting' });
        } catch (err) {
            console.error("Error handling answer:", err);
            throw err;
        }
    }

    /**
     * Binds text chat events.
     */
    bindChannelEvents(channel) {
        channel.onopen = async () => {
            this.emit('statuschange', { text: 'Connected', type: 'connected' });
            await this.calculateSAS();
        };

        channel.onclose = () => {
            this.emit('statuschange', { text: 'Disconnected', type: 'disconnected' });
            this.closeConnection();
        };

        channel.onerror = err => {
            console.error("Data channel error:", err);
            this.emit('statuschange', { text: 'Connection Error', type: 'disconnected' });
        };

        channel.onmessage = event => {
            try {
                const packet = JSON.parse(event.data);
                if (packet.type === 'chat') {
                    this.emit('message', { text: packet.text, side: 'received', selfDestruct: !!packet.selfDestruct });
                } else if (packet.type === 'control') {
                    this.emit('control', packet);
                }
            } catch (err) {
                console.warn("Could not parse packet:", err);
            }
        };
    }

    /**
     * Binds binary stream and file metadata events.
     */
    bindFileChannelEvents(channel) {
        channel.binaryType = "arraybuffer";

        channel.onmessage = async event => {
            const data = event.data;

            // 1. String control and metadata messages
            if (typeof data === "string") {
                try {
                    const packet = JSON.parse(data);
                    
                    if (packet.type === "file-metadata") {
                        this.receivedMetadata = packet;
                        this.receivedSize = 0;
                        this.recvHasher = new SHA256();
                        this.emit('fileincoming', { name: packet.name, size: packet.size });
                    } 
                    else if (packet.type === "file-ready") {
                        this.sendHasher = new SHA256();
                        this.startFileStream();
                    }
                    else if (packet.type === "file-complete") {
                        const calculatedHash = this.recvHasher.digest();
                        const verified = (calculatedHash === packet.sha256);

                        if (this.fileWritableStream) {
                            await this.fileWritableStream.close();
                            this.fileWritableStream = null;
                            this.emit('filecompleted', { blob: null, filename: this.receivedMetadata.name, isDirectSave: true, verified: verified });
                        } else {
                            const blob = new Blob(this.receivedChunks);
                            this.emit('filecompleted', { blob: blob, filename: this.receivedMetadata.name, isDirectSave: false, verified: verified });
                            this.receivedChunks = [];
                        }
                        this.receivedMetadata = null;
                        this.recvHasher = null;
                    }
                } catch (err) {
                    console.error("Error parsing file channel string:", err);
                }
            } 
            // 2. Binary file chunks
            else {
                if (!this.receivedMetadata) return;

                if (this.recvHasher) {
                    this.recvHasher.update(data);
                }

                if (this.fileWritableStream) {
                    this.fileWritableStream.write(data);
                } else {
                    this.receivedChunks.push(data);
                }

                this.receivedSize += data.byteLength;
                const percent = Math.floor((this.receivedSize / this.receivedMetadata.size) * 100);
                this.emit('fileprogress', { percent: percent, action: 'receiving' });
            }
        };
    }

    /**
     * User accepted incoming file. Setup receiver storage mode and notify sender.
     */
    async acceptFileTransfer(useFileSystemAccess) {
        if (!this.receivedMetadata) return;

        if (useFileSystemAccess && window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: this.receivedMetadata.name
                });
                this.fileWritableStream = await handle.createWritable();
            } catch (err) {
                console.warn("User cancelled file picker or write denied, falling back to memory:", err);
                this.fileWritableStream = null;
                this.receivedChunks = [];
            }
        } else {
            this.fileWritableStream = null;
            this.receivedChunks = [];
        }

        this.fileChannel.send(JSON.stringify({ type: "file-ready" }));
    }

    /**
     * Send chat message.
     */
    sendMessage(text, selfDestruct = false) {
        if (this.chatChannel && this.chatChannel.readyState === 'open') {
            const packet = { type: 'chat', text: text, selfDestruct: selfDestruct };
            this.chatChannel.send(JSON.stringify(packet));
            this.emit('message', { text: text, side: 'sent', selfDestruct: selfDestruct });
        }
    }

    /**
     * Send control instruction to peer
     */
    sendControl(action, value) {
        if (this.chatChannel && this.chatChannel.readyState === 'open') {
            const packet = { type: 'control', action: action, value: value };
            this.chatChannel.send(JSON.stringify(packet));
        }
    }

    /**
     * Initiates the file sending process by sharing metadata.
     */
    sendFile(file) {
        if (!this.fileChannel || this.fileChannel.readyState !== 'open') return;

        this.sendingFile = file;
        this.sendOffset = 0;

        const meta = {
            type: "file-metadata",
            name: file.name,
            size: file.size,
            mime: file.type
        };
        this.fileChannel.send(JSON.stringify(meta));
        this.emit('fileprogress', { percent: 0, action: 'sending' });
    }

    /**
     * Performs chunked file stream with flow control.
     */
    startFileStream() {
        this.fileChannel.bufferedAmountLowThreshold = 65536; // 64KB threshold

        this.fileReader.onload = event => {
            const arrayBuffer = event.target.result;
            this.fileChannel.send(arrayBuffer);
            
            if (this.sendHasher) {
                this.sendHasher.update(arrayBuffer);
            }

            this.sendOffset += arrayBuffer.byteLength;
            const percent = Math.floor((this.sendOffset / this.sendingFile.size) * 100);
            this.emit('fileprogress', { percent: percent, action: 'sending' });

            if (this.sendOffset < this.sendingFile.size) {
                streamNext();
            } else {
                const finalHash = this.sendHasher.digest();
                this.fileChannel.send(JSON.stringify({ type: "file-complete", sha256: finalHash }));
                
                this.emit('filecompleted', { blob: null, filename: this.sendingFile.name, isDirectSave: false, verified: true });
                this.sendingFile = null;
                this.sendHasher = null;
            }
        };

        const streamNext = () => {
            if (this.fileChannel.bufferedAmount > 1048576) {
                this.fileChannel.onbufferedamountlow = () => {
                    this.fileChannel.onbufferedamountlow = null;
                    streamNext();
                };
                return;
            }

            const slice = this.sendingFile.slice(this.sendOffset, this.sendOffset + this.chunkSize);
            this.fileReader.readAsArrayBuffer(slice);
        };

        streamNext();
    }

    /**
     * Starts microphone stream and replaces audio track on the peer connection sender.
     */
    async startAudioCall() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            
            const track = this.localStream.getAudioTracks()[0];
            const senders = this.peerConnection.getSenders();
            const audioSender = senders.find(s => s.track === null || (s.track && s.track.kind === 'audio'));
            
            if (audioSender) {
                await audioSender.replaceTrack(track);
            }
            return this.localStream;
        } catch (err) {
            console.error("Microphone capture failed:", err);
            throw err;
        }
    }

    /**
     * Stops sending microphone track.
     */
    async stopAudioCall() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        const senders = this.peerConnection.getSenders();
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender) {
            await audioSender.replaceTrack(null);
        }
    }

    /**
     * Safely closes the peer connection.
     */
    closeConnection() {
        this.closeAudio();
        if (this.peerConnection) {
            this.peerConnection.close();
        }
        this.peerConnection = null;
        this.chatChannel = null;
        this.fileChannel = null;
        this.sasCode = null;
        if (this.fileWritableStream) {
            this.fileWritableStream.close().catch(() => {});
        }
    }

    closeAudio() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
        }
        this.localStream = null;
    }
}
