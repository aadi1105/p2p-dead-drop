/**
 * DeadDrop P2P - WebRTC Connection & Streaming Layer
 * Handles serverless signaling (base64 tokens), dual data channels (chat/file),
 * and chunked file streaming with flow control backpressure.
 * Supports direct-to-disk file streaming via File System Access API.
 */

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
        this.onFileIncoming = config.onFileIncoming || (() => {});
        this.onFileProgress = config.onFileProgress || (() => {});
        this.onFileCompleted = config.onFileCompleted || (() => {});

        // File transfer states
        this.chunkSize = 16384; // 16KB blocks
        this.fileReader = new FileReader();
        this.sendingFile = null;
        this.sendOffset = 0;

        this.receivedMetadata = null;
        this.receivedChunks = [];
        this.receivedSize = 0;
        this.fileWritableStream = null;
    }

    /**
     * Initializes the WebRTC connection as the HOST.
     */
    async initHost() {
        this.isHost = true;
        this.onStatusChange('Puncturing NAT...', 'connecting');

        this.peerConnection = new RTCPeerConnection(this.rtcConfig);

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

        channel.onmessage = async event => {
            const data = event.data;

            // 1. JSON strings are metadata or control packets
            if (typeof data === "string") {
                try {
                    const packet = JSON.parse(data);
                    
                    if (packet.type === "file-metadata") {
                        // Received file info from sender. Prompt user to accept.
                        this.receivedMetadata = packet;
                        this.receivedSize = 0;
                        this.onFileIncoming(packet.name, packet.size);
                    } 
                    else if (packet.type === "file-ready") {
                        // Receiver is ready to stream. Start transmission.
                        this.startFileStream();
                    }
                } catch (err) {
                    console.error("Error parsing file channel string:", err);
                }
            } 
            // 2. ArrayBuffer represents binary chunks of file
            else {
                if (!this.receivedMetadata) return;

                if (this.fileWritableStream) {
                    // Stream directly to disk (async write, browser handles queuing)
                    this.fileWritableStream.write(data);
                } else {
                    // Fallback: Buffer in RAM
                    this.receivedChunks.push(data);
                }

                this.receivedSize += data.byteLength;
                const percent = Math.floor((this.receivedSize / this.receivedMetadata.size) * 100);
                this.onFileProgress(percent, 'receiving');

                // Check completion
                if (this.receivedSize === this.receivedMetadata.size) {
                    if (this.fileWritableStream) {
                        // Flush and close the file stream
                        await this.fileWritableStream.close();
                        this.fileWritableStream = null;
                        this.onFileCompleted(null, this.receivedMetadata.name, true);
                    } else {
                        // Assemble the memory buffer
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
     * @param {boolean} useFileSystemAccess - True to use showSaveFilePicker
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

        // Send handshake signal to sender that we are ready to receive binary chunks
        this.fileChannel.send(JSON.stringify({ type: "file-ready" }));
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
     * Initiates the file sending process by sharing metadata.
     * @param {File} file 
     */
    sendFile(file) {
        if (!this.fileChannel || this.fileChannel.readyState !== 'open') return;

        this.sendingFile = file;
        this.sendOffset = 0;

        // Step 1: Send metadata packet.
        const meta = {
            type: "file-metadata",
            name: file.name,
            size: file.size,
            mime: file.type
        };
        this.fileChannel.send(JSON.stringify(meta));
        this.onFileProgress(0, 'sending');
        
        // Wait for receiver to trigger "file-ready" before streaming
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
            // Flow control: if WebRTC internal buffer is over 1MB, wait for it to clear
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
     * Safely closes the peer connection.
     */
    closeConnection() {
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
}
