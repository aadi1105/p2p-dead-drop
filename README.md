# DeadDrop P2P - Serverless Command Console, VoIP & File Share

DeadDrop is a serverless, zero-cloud peer-to-peer (P2P) web terminal that enables two users to establish a secure, direct communication link. It features a retro glowing CRT command console aesthetic and facilitates real-time chat, automated self-destruct timers, direct VoIP voice calls, and flow-controlled file streaming.

By utilizing **WebRTC Data Channels and Media Transceivers**, DeadDrop bypasses standard cloud uploads, allowing users to communicate and share files directly browser-to-browser.

---

## Key Features

- **No Signaling Servers:** Handshakes are performed manually by copying and pasting compressed connection tokens.
- **SDP Deflate Compression:** Shrinks SDP signaling tokens using the browser's native `CompressionStream` API (deflate algorithm), compressing tokens by **~60%** to comfortably fit within standard chat app limits (such as Discord's 2,000-character limit).
- **Bilateral Voice Call (VoIP):** Real-time voice calls using microphone streams pre-configured through audio transceivers, enabling dynamic call toggling without renegotiating connection codes. Includes real-time voice call state synchronization (microphone active/mute states and warning logs).
- **Auto-Syncing Burn Mode:** Self-destructing messages with a 10-second countdown. Toggling the mode synchronizes the state across both peers instantly and triggers warning synth ticks.
- **CLI Command Shell:** Chat input acts as a mock Unix terminal shell. Commands include:
  - `/net` - Queries `RTCPeerConnection` stats reports to show candidate types, RTT latency, bytes TX/RX, and packet loss.
  - `/ping` - Calculates real-time round-trip latency (RTT) between browsers.
  - `/status` - Displays link specifications, active state, and session statistics (bytes TX/RX).
  - `/voice` - Toggles the VoIP line.
  - `/burn` - Toggles self-destruct mode.
  - `/clear` - Wipes the console logs.
- **O(1) Space Complexity File Streaming:** Divides files into `16KB` chunks and throttles transmission speed using WebRTC backpressure queue checks. Bypasses browser memory limits by streaming bytes directly to/from the file system via the native **File System Access API**, maintaining a low, constant memory footprint regardless of file size.
- **Real-Time Cryptographic File Verification:** Computes SHA-256 checksums incrementally on the fly as data slices are sent and received. Detects packet corruption or disk-write issues without pre-hash delays or post-transfer file re-reads.
- **DTLS Short Authentication String (SAS) Verification:** Derives a 6-character authentication string from the lexicographically sorted SHA-256 hash of both peers' DTLS certificate fingerprints to prevent Man-in-the-Middle (MitM) attacks.
- **Decoupled Event-Driven Architecture:** Core networking and protocol state are built on top of the native browser `EventTarget` class, cleanly separating UI rendering and DOM logic from connection states.
- **Retro Audio Synthesizer:** Programmatic sound generation (link success, message beeps, file completion sweeps, and warning ticks) powered by the browser's native **Web Audio API** (zero asset downloads).

---

## How It Works (The WebRTC Handshake)

DeadDrop removes WebSocket signaling dependencies by replacing them with manual copy-pasting:

```mermaid
sequenceDiagram
    autonumber
    actor Host as Peer A (Host)
    actor Joiner as Peer B (Joiner)
    
    Host->>Host: Initialize RTCPeerConnection & Data Channels
    Host->>Host: Pre-allocate Audio Transceivers (sendrecv)
    Host->>Host: Generate Local Offer (SDP)
    Note over Host: Deflate compresses & Base64 encodes Offer
    Host-->>Joiner: Send Offer Token (via Discord/Email)
    Joiner->>Joiner: Paste Offer Token & Decompress
    Joiner->>Joiner: Set Remote Description
    Joiner->>Joiner: Generate Local Answer (SDP)
    Note over Joiner: Deflate compresses & Base64 encodes Answer
    Joiner-->>Host: Send Answer Token
    Host->>Host: Paste Answer Token & Decompress
    Host->>Host: Set Remote Description & Open Tunnel
    Note over Host, Joiner: Secure P2P Link Active! (Synth Chime plays)
```

---

## Technical Implementations

### 1. SDP Compression (Bypassing Limits)
Browser SDP records are naturally massive (~3.5KB). DeadDrop uses the native browser `CompressionStream` API to deflate the text prior to base64 encoding, preventing truncation when shared over chats:
```javascript
const stream = new Blob([sdpString]).stream();
const compressedStream = stream.pipeThrough(new CompressionStream('deflate'));
const buffer = await new Response(compressedStream).arrayBuffer();
const compressedBase64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
```

### 2. Flow Control & Direct-to-Disk Writing
To prevent browser memory crashes during large file transfers, DeadDrop utilizes backpressure checks alongside the File System Access API:
```javascript
// Flow control: Wait if outgoing WebRTC buffer exceeds 1MB
if (this.fileChannel.bufferedAmount > 1048576) {
    this.fileChannel.onbufferedamountlow = () => {
        this.fileChannel.onbufferedamountlow = null;
        streamNext(); // Resume slice read
    };
    return;
}

// Receiver: Direct disk stream writing
this.fileWritableStream.write(incomingBuffer);
```

### 3. Concurrent SHA-256 File Hashing
Rather than pre-hashing files (which causes noticeable UI freezes on large files) or post-transfer re-reading (which temporarily spikes RAM usage and causes disk I/O bottlenecks), DeadDrop hashes slices concurrently as they flow through the connection:
```javascript
// During transmission:
this.sendHasher.update(arrayBuffer); // Accumulate chunk hash on read

// During receiving:
this.recvHasher.update(incomingBuffer); // Accumulate chunk hash on write
```

### 4. Real-Time Audio VoIP Integration
Using pre-allocated audio transceivers, microphone tracks can be dynamically replaced on active connections without secondary renegotiation cycles:
```javascript
const senders = this.peerConnection.getSenders();
const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
audioSender.replaceTrack(microphoneStream.getAudioTracks()[0]);
```

---

## Security and Trust Model

### DTLS Encryption
All WebRTC data channels and media streams are encrypted end-to-end using DTLS (Datagram Transport Layer Security) and SRTP (Secure Real-time Transport Protocol). Eavesdroppers on the network path cannot read or modify the connection payloads.

### Short Authentication String (SAS) Verification
Because DeadDrop uses manual copy-pasting for signaling, it is vulnerable to an active attacker who can intercept and replace the connection tokens (a Man-in-the-Middle or MitM attack). If an attacker intercepts Peer A's offer, sends their own offer to Peer B, and proxies the traffic, they can decrypt the connection.

To detect this, DeadDrop implements a **Short Authentication String (SAS)** derived from the DTLS fingerprints:
1. Both peers extract the SHA-256 fingerprints of the certificates exchanged during the DTLS handshake.
2. The fingerprints are sorted lexicographically (making the operation order-independent) and concatenated:
   `fingerprints = [localFingerprint, remoteFingerprint].sort().join('|')`
3. The combined string is hashed via SHA-256, and the first 6 hex characters are displayed as a code (e.g., `3D-A4-5C`).
4. If both users verify that their displayed codes match over a trusted out-of-band channel (e.g., reading it aloud during the voice call, or via a separate authenticated message), they gain strong assurance that no attacker has tampered with the signaling exchange.

#### Scope of the SAS Model
* **What it protects against:** Eavesdropping or active manipulation of the handshakes during the manual copy-paste exchange.
* **What it does not protect against:** Compromise of the endpoint devices themselves (e.g., screen loggers or browser extension vulnerabilities), or social engineering attacks where a user accepts a connection code from an untrusted party.
* **Assumptions:** The model assumes the out-of-band channel used for SAS verification (e.g., the user's voice) is authentic and hard to forge in real-time.

---

## Performance Benchmarks & Loopback Diagnostics

DeadDrop includes an automated, in-browser **Loopback Benchmarking Suite** located in the `/benchmarks` directory. It programmatically instantiates two peer connections on a single page, mocks the manual signaling handshake, and streams payloads to profile system metrics.

To run the suite, host the repository locally and navigate to `/benchmarks/index.html` (or run it live via GitHub Pages).

### Baseline Performance Metrics
*Measurements below represent a baseline benchmark profile recorded under the following environment: OS: Windows 11, Browser: Chrome 120 (Chromium V8 Engine), Hardware: Intel Core i7 (6 Cores, 2.6GHz).*

#### 1. SDP Token Compression Efficiency
* **Raw Host SDP Size:** ~3.2 KB (3,280 bytes)
* **Deflated Base64 Token Size:** ~1.3 KB (1,312 bytes)
* **Size Reduction:** **60.0%** (easily fits within Discord's 2,000-character message limit).

#### 2. Loopback Throughput & Heap Scaling (20 MB Payload)
| Chunk Size | Loopback Transfer Time | Average Throughput | Peak JS Heap Growth |
|---|---|---|---|
| **8 KB** | 1.48 s | 13.51 MB/s | < 1 MB |
| **16 KB (Default)** | 0.95 s | 21.05 MB/s | < 1 MB |
| **32 KB** | 0.78 s | 25.64 MB/s | < 1 MB |
| **64 KB** | 0.71 s | 28.17 MB/s | < 1 MB |

### Engineering Rationale: Why 16KB is the Default
Although larger chunk sizes (32KB/64KB) show slightly higher throughput in a zero-loss local loopback environment, **16KB is configured as the default** for production-grade WAN/LAN environments due to WebRTC transport limitations:
1. **SCTP Fragmentation & MTU Sizing:** WebRTC Data Channels run over SCTP (Stream Control Transmission Protocol) encapsulated in DTLS/UDP. The Path MTU on internet routes is typically ~1,200 to 1,400 bytes. Chunks larger than 16KB must be heavily fragmented by the browser's SCTP layer.
2. **Head-of-Line Blocking:** If a single fragmented packet of a large chunk (e.g., 64KB) is lost on a WAN route, the receiver's SCTP stack must block all subsequent chunks until the missing packet is retransmitted. This causes head-of-line blocking and collapses real-time throughput.
3. **Congestion Control & Buffer Bloat:** Chunks larger than 16KB can easily flood the browser's internal socket buffers on slower networks, triggering the SCTP congestion window to drop and causing packet loss or connection drops. A 16KB chunk size maximizes stability and prevents buffer exhaustion while maintaining excellent throughput.

### Memory Profile Analysis: O(1) Heap Constancy
The benchmark tracks browser heap growth using the native `performance.memory` API. As shown in the metrics table, peak JS heap growth remains under **1 MB** regardless of file size. 
* **Note on Browser Buffering:** While our JavaScript application-level buffer maintains strict $O(1)$ space complexity by recycling a single array buffer during chunk reads, the browser's underlying C++ networking engine allocates temporary internal queue buffers to handle flow control backpressure. This buffer growth is managed outside the JavaScript VM heap.

---

## Running Locally

To run and test the project:

1. Clone this repository:
   ```bash
   git clone https://github.com/aadi1105/p2p-dead-drop.git
   cd p2p-dead-drop
   ```
2. Start a local HTTP server:
   ```bash
   python -m http.server 8000
   ```
3. Open `http://127.0.0.1:8000` in two browser tabs.

---

## Deployment

Since this is a client-side application, it can be hosted for free on **GitHub Pages**, **Vercel**, or **Cloudflare Pages**. Enable Pages in your GitHub Repository settings pointing to the `main` branch.
