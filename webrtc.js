/**
 * DeadDrop P2P - WebRTC Connection & Streaming Layer
 * Handles serverless signaling (base64 tokens), dual data channels (chat/file),
 * chunked file streaming with flow control backpressure,
 * and P2P Voice Chat (VoIP) audio streaming.
 * Includes native Deflate compression for SDP tokens.
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

class DeadDropConnection {
    constructor(config = {}) {
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

        // Callback hooks for UI bindings
        this.onStatusChange = config.onStatusChange || (() => {});
        this.onIceGathered = config.onIceGathered || (() => {});
        this.onMessageReceived = config.onMessageReceived || (() => {});
        this.onControlEvent = config.onControlEvent || (() => {});
        this.onFileIncoming = config.onFileIncoming || (() => {});
        this.onFileProgress = config.onFileProgress || (() => {});
        this.onFileCompleted = config.onFileCompleted || (() => {});
        this.onRemoteStream = config.onRemoteStream || (() => {});

        // File transfer states
        this.chunkSize = 16384; // 16KB blocks
        this.fileReader = new FileReader();
        this.sendingFile = null;
        this.sendOffset = 0;

        this.receivedMetadata = null;
        this.receivedChunks = [];
        this.receivedSize = 0;
        this.fileWritableStream = null;

        // Audio state
        this.localStream = null;
    }

    /**
     * Initializes the WebRTC connection as the HOST.
     */
    async initHost() {
        this.isHost = true;
        this.onStatusChange('Puncturing NAT...', 'connecting');

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
            this.onStatusChange('Failed to host', 'disconnected');
        }
    }

    /**
     * Initializes the WebRTC connection as the JOINER.
     */
    async initJoin() {
        this.isHost = false;
        this.onStatusChange('Awaiting connection code', 'disconnected');

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
                this.onIceGathered(compressedToken);
            }
        };
    }

    /**
     * Binds media track receiver events.
     */
    bindTrackEvents() {
        this.peerConnection.ontrack = event => {
            const remoteStream = event.streams[0] || new MediaStream([event.track]);
            this.onRemoteStream(remoteStream);
        };
    }

    /**
     * Pastes the Host's offer and generates a local response (Answer).
     */
    async handleOffer(base64Offer) {
        try {
            const decompressed = await decompressToken(base64Offer);
            const sdp = JSON.parse(decompressed);
            this.onStatusChange('Puncturing NAT...', 'connecting');

            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
        } catch (err) {
            console.error("Error handling offer:", err);
            this.onStatusChange('Error processing code', 'disconnected');
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
            this.onStatusChange('Connecting...', 'connecting');
        } catch (err) {
            console.error("Error handling answer:", err);
            throw err;
        }
    }

    /**
     * Binds text chat events.
     */
    bindChannelEvents(channel) {
        channel.onopen = () => {
            this.onStatusChange('Connected', 'connected');
        };

        channel.onclose = () => {
            this.onStatusChange('Disconnected', 'disconnected');
            this.closeConnection();
        };

        channel.onerror = err => {
            console.error("Data channel error:", err);
            this.onStatusChange('Connection Error', 'disconnected');
        };

        channel.onmessage = event => {
            try {
                const packet = JSON.parse(event.data);
                if (packet.type === 'chat') {
                    this.onMessageReceived(packet.text, 'received', !!packet.selfDestruct);
                } else if (packet.type === 'control') {
                    this.onControlEvent(packet);
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

            if (typeof data === "string") {
                try {
                    const packet = JSON.parse(data);
                    
                    if (packet.type === "file-metadata") {
                        this.receivedMetadata = packet;
                        this.receivedSize = 0;
                        this.onFileIncoming(packet.name, packet.size);
                    } 
                    else if (packet.type === "file-ready") {
                        this.startFileStream();
                    }
                } catch (err) {
                    console.error("Error parsing file channel string:", err);
                }
            } 
            else {
                if (!this.receivedMetadata) return;

                if (this.fileWritableStream) {
                    this.fileWritableStream.write(data);
                } else {
                    this.receivedChunks.push(data);
                }

                this.receivedSize += data.byteLength;
                const percent = Math.floor((this.receivedSize / this.receivedMetadata.size) * 100);
                this.onFileProgress(percent, 'receiving');

                if (this.receivedSize === this.receivedMetadata.size) {
                    if (this.fileWritableStream) {
                        await this.fileWritableStream.close();
                        this.fileWritableStream = null;
                        this.onFileCompleted(null, this.receivedMetadata.name, true);
                    } else {
                        const blob = new Blob(this.receivedChunks);
                        this.onFileCompleted(blob, this.receivedMetadata.name, false);
                        this.receivedChunks = [];
                    }
                    this.receivedMetadata = null;
                }
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
            this.onMessageReceived(text, 'sent', selfDestruct);
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
        this.onFileProgress(0, 'sending');
    }

    /**
     * Performs chunked file stream with flow control.
     */
    startFileStream() {
        this.fileChannel.bufferedAmountLowThreshold = 65536; // 64KB threshold

        this.fileReader.onload = event => {
            this.fileChannel.send(event.target.result);
            this.sendOffset += event.target.result.byteLength;

            const percent = Math.floor((this.sendOffset / this.sendingFile.size) * 100);
            this.onFileProgress(percent, 'sending');

            if (this.sendOffset < this.sendingFile.size) {
                streamNext();
            } else {
                this.onFileCompleted(null, this.sendingFile.name, false);
                this.sendingFile = null;
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
