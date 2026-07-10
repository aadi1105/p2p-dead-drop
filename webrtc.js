/**
 * DeadDrop P2P - WebRTC Connection & Streaming Layer
 * Handles serverless signaling (base64 tokens), dual data channels (chat/file),
 * and chunked file streaming with flow control backpressure.
 */

class DeadDropConnection {
    constructor(config = {}) {
        // Public Google STUN servers for NAT hole-punching
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
        this.onFileMetadata = config.onFileMetadata || (() => {});
        this.onFileProgress = config.onFileProgress || (() => {});
        this.onFileCompleted = config.onFileCompleted || (() => {});

        // File transfer stats
        this.chunkSize = 16384; // 16KB blocks
        this.fileReader = new FileReader();
        this.receivedMetadata = null;
        this.receivedChunks = [];
        this.receivedSize = 0;
    }

    /**
     * Initializes the WebRTC connection as the HOST.
     */
    async initHost() {
        this.isHost = true;
        this.onStatusChange('Puncturing NAT...', 'connecting');

        this.peerConnection = new RTCPeerConnection(this.rtcConfig);

        // Host opens the data channels explicitly
        this.chatChannel = this.peerConnection.createDataChannel("chat");
        this.fileChannel = this.peerConnection.createDataChannel("file");

        this.bindChannelEvents(this.chatChannel);
        this.bindFileChannelEvents(this.fileChannel);
        this.bindIceEvents();

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

        // Joiner listens for incoming data channels created by Host
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
    }

    /**
     * Handles setting up listeners for the ICE gathering phase.
     */
    bindIceEvents() {
        this.peerConnection.onicegatheringstatechange = () => {
            if (this.peerConnection.iceGatheringState === 'complete') {
                // Compile the description (which includes gathered ICE candidates) into base64
                const base64SDP = btoa(JSON.stringify(this.peerConnection.localDescription));
                this.onIceGathered(base64SDP);
            }
        };
    }

    /**
     * Pastes the Host's offer and generates a local response (Answer).
     */
    async handleOffer(base64Offer) {
        try {
            const sdp = JSON.parse(atob(base64Offer));
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
            const sdp = JSON.parse(atob(base64Answer));
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
                    this.onMessageReceived(packet.text, 'received');
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

        channel.onmessage = event => {
            const data = event.data;

            // JSON strings are metadata packets
            if (typeof data === "string") {
                try {
                    const meta = JSON.parse(data);
                    if (meta.type === "file-metadata") {
                        this.receivedMetadata = meta;
                        this.receivedChunks = [];
                        this.receivedSize = 0;
                        this.onFileMetadata(meta.name, meta.size);
                    }
                } catch (err) {
                    console.error("Error parsing file metadata:", err);
                }
            } 
            // ArrayBuffer represents binary chunks of file
            else {
                if (!this.receivedMetadata) return;

                this.receivedChunks.push(data);
                this.receivedSize += data.byteLength;

                const percent = Math.floor((this.receivedSize / this.receivedMetadata.size) * 100);
                this.onFileProgress(percent, 'receiving');

                if (this.receivedSize === this.receivedMetadata.size) {
                    const blob = new Blob(this.receivedChunks);
                    this.onFileCompleted(blob, this.receivedMetadata.name);

                    // Clear state
                    this.receivedMetadata = null;
                    this.receivedChunks = [];
                }
            }
        };
    }

    /**
     * Send chat message.
     */
    sendMessage(text) {
        if (this.chatChannel && this.chatChannel.readyState === 'open') {
            const packet = { type: 'chat', text: text };
            this.chatChannel.send(JSON.stringify(packet));
            this.onMessageReceived(text, 'sent');
        }
    }

    /**
     * Streams a file through WebRTC with backpressure buffer checks.
     */
    sendFile(file) {
        if (!this.fileChannel || this.fileChannel.readyState !== 'open') return;

        let offset = 0;
        this.fileChannel.bufferedAmountLowThreshold = 65536; // 64KB threshold

        // Send metadata packet first
        const meta = {
            type: "file-metadata",
            name: file.name,
            size: file.size,
            mime: file.type
        };
        this.fileChannel.send(JSON.stringify(meta));
        this.onFileMetadata(file.name, file.size);

        this.fileReader.onload = event => {
            this.fileChannel.send(event.target.result);
            offset += event.target.result.byteLength;

            const percent = Math.floor((offset / file.size) * 100);
            this.onFileProgress(percent, 'sending');

            if (offset < file.size) {
                streamNext();
            } else {
                this.onFileCompleted(null, file.name);
            }
        };

        const streamNext = () => {
            // Flow control: if WebRTC internal buffer is over 1MB, wait for it to clear
            if (this.fileChannel.bufferedAmount > 1048576) {
                this.fileChannel.onbufferedamountlow = () => {
                    this.fileChannel.onbufferedamountlow = null;
                    streamNext();
                };
                return;
            }

            const slice = file.slice(offset, offset + this.chunkSize);
            this.fileReader.readAsArrayBuffer(slice);
        };

        streamNext();
    }

    /**
     * Safely closes the peer connection.
     */
    closeConnection() {
        if (this.peerConnection) {
            this.peerConnection.close();
        }
        this.peerConnection = null;
        this.chatChannel = null;
        this.fileChannel = null;
    }
}
