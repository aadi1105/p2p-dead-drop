/**
 * DeadDrop P2P - Loopback Benchmarking Framework
 * Programmatically establishes in-process loopback connections
 * to measure SDP compression, chunk size throughput, and memory scaling.
 */

document.addEventListener('DOMContentLoaded', () => {
    const logOutput = document.getElementById('logOutput');
    const btnStart = document.getElementById('btnStartBenchmark');
    const throughputBody = document.getElementById('throughputBody');
    const sdpRaw = document.getElementById('sdpRaw');
    const sdpCompressed = document.getElementById('sdpCompressed');
    const sdpRatio = document.getElementById('sdpRatio');
    const rttMin = document.getElementById('rttMin');
    const rttMax = document.getElementById('rttMax');
    const rttAvg = document.getElementById('rttAvg');
    
    // Environment detection
    detectEnvironment();

    btnStart.addEventListener('click', runBenchmarkSuite);

    function log(message) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        logOutput.textContent += `\n[${time}] ${message}`;
        logOutput.scrollTop = logOutput.scrollHeight;
    }

    function clearLog() {
        logOutput.textContent = "=== DEADDROP LOOPBACK DIAGNOSTIC RUN ===";
    }

    function detectEnvironment() {
        const ua = navigator.userAgent;
        document.getElementById('envBrowser').textContent = ua;

        let os = "Unknown OS";
        if (ua.indexOf("Win") !== -1) os = "Windows";
        else if (ua.indexOf("Mac") !== -1) os = "macOS";
        else if (ua.indexOf("Linux") !== -1) os = "Linux";
        else if (ua.indexOf("Android") !== -1) os = "Android";
        else if (ua.indexOf("like Mac") !== -1) os = "iOS";
        document.getElementById('envOS').textContent = os;
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    /**
     * Programmatically establishes two DeadDropConnection instances in loopback.
     */
    async function establishLoopback() {
        return new Promise((resolve, reject) => {
            log("Initializing Host and Joiner in loopback process...");
            const host = new DeadDropConnection();
            const joiner = new DeadDropConnection();
            
            let hostOffer = null;
            let joinerAnswer = null;

            // Step 1: Hook Host offer generation
            host.addEventListener('icegathered', async (e) => {
                hostOffer = e.detail.token;
                log("Host SDP offer gathered and deflated.");
                
                // Expose raw vs compressed offer sizes
                const rawSDP = JSON.stringify(host.peerConnection.localDescription);
                sdpRaw.textContent = formatBytes(rawSDP.length);
                sdpCompressed.textContent = formatBytes(hostOffer.length);
                const ratio = ((1 - (hostOffer.length / rawSDP.length)) * 100).toFixed(1);
                sdpRatio.textContent = `${ratio}% Reduction`;

                // Step 2: Feed offer to Joiner
                log("Feeding Offer token to Joiner remote context...");
                try {
                    await joiner.handleOffer(hostOffer);
                    log("Joiner processing offer...");
                    await joiner.initJoin();
                } catch (err) {
                    reject(err);
                }
            });

            // Step 3: Hook Joiner answer generation
            joiner.addEventListener('icegathered', async (e) => {
                joinerAnswer = e.detail.token;
                log("Joiner SDP answer gathered and deflated.");
                
                // Step 4: Feed answer back to Host
                log("Feeding Answer token back to Host...");
                try {
                    await host.handleAnswer(joinerAnswer);
                } catch (err) {
                    reject(err);
                }
            });

            // Step 5: Connection confirmation
            host.addEventListener('statuschange', (e) => {
                const { text, type } = e.detail;
                log(`Host state: ${text}`);
                if (type === 'connected') {
                    log("WebRTC Peer link established successfully!");
                    resolve({ host, joiner });
                }
            });

            // Initialize connection sequences
            host.initHost();
        });
    }

    /**
     * Executes RTT tests using control packets.
     */
    async function measureRTT(host, joiner) {
        return new Promise((resolve) => {
            log("Initiating RTT latency tests (10 packet iterations)...");
            const pings = [];
            let pingIndex = 0;

            const sendPing = () => {
                if (pingIndex >= 10) {
                    cleanup();
                    return;
                }
                host.sendControl('ping', Date.now());
            };

            const pongHandler = (e) => {
                const packet = e.detail;
                if (packet.action === 'pong') {
                    const rtt = Date.now() - packet.value;
                    pings.push(rtt);
                    pingIndex++;
                    sendPing();
                }
            };

            const pingHandler = (e) => {
                const packet = e.detail;
                if (packet.action === 'ping') {
                    joiner.sendControl('pong', packet.value);
                }
            };

            host.addEventListener('control', pongHandler);
            joiner.addEventListener('control', pingHandler);

            const cleanup = () => {
                host.removeEventListener('control', pongHandler);
                joiner.removeEventListener('control', pingHandler);
                
                const min = Math.min(...pings);
                const max = Math.max(...pings);
                const avg = (pings.reduce((a, b) => a + b, 0) / pings.length).toFixed(1);
                
                rttMin.textContent = `${min} ms`;
                rttMax.textContent = `${max} ms`;
                rttAvg.textContent = `${avg} ms`;
                log(`RTT tests complete. Min: ${min}ms | Max: ${max}ms | Avg: ${avg}ms`);
                resolve();
            };

            // Start first ping
            sendPing();
        });
    }

    /**
     * Main Orchestrator of the Benchmark Suite.
     */
    async function runBenchmarkSuite() {
        btnStart.disabled = true;
        clearLog();
        throughputBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--term-green);">Initializing link...</td></tr>`;

        try {
            const { host, joiner } = await establishLoopback();
            await measureRTT(host, joiner);

            const chunkSizes = [8192, 16384, 32768, 65536]; // 8KB, 16KB, 32KB, 64KB
            const payloadMB = 20; // 20MB file
            const payloadBytes = payloadMB * 1024 * 1024;
            
            log(`Generating random ${payloadMB} MB mock file payload...`);
            const mockBuffer = new Uint8Array(payloadBytes);
            // Fill with repeating pattern to avoid slow random byte gen
            for (let i = 0; i < mockBuffer.length; i++) {
                mockBuffer[i] = i % 256;
            }
            const mockFile = new File([mockBuffer], "benchmark_payload.bin", { type: "application/octet-stream" });
            
            throughputBody.innerHTML = "";
            
            // Run tests sequentially
            for (const size of chunkSizes) {
                const results = await runThroughputTest(host, joiner, mockFile, size);
                
                // Display results row
                const tr = document.createElement('tr');
                if (size === 16384) {
                    tr.style.backgroundColor = "rgba(0, 255, 0, 0.08)";
                    tr.style.fontWeight = "bold";
                }
                
                const sizeLabel = `${size / 1024} KB${size === 16384 ? ' (Default)' : ''}`;
                tr.innerHTML = `
                    <td>${sizeLabel}</td>
                    <td>${(results.time / 1000).toFixed(2)} s</td>
                    <td>${results.throughput.toFixed(2)} MB/s</td>
                    <td>${results.heapGrowth ? formatBytes(results.heapGrowth) : 'N/A'}</td>
                `;
                throughputBody.appendChild(tr);
            }

            log("All benchmarks complete! The connection was closed.");
            host.closeConnection();
            joiner.closeConnection();

        } catch (err) {
            log(`Benchmark failure: ${err.message}`);
            console.error(err);
            throughputBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger-red);">Test Aborted: ${err.message}</td></tr>`;
        } finally {
            btnStart.disabled = false;
        }
    }

    /**
     * Runs a single throughput test.
     */
    async function runThroughputTest(host, joiner, file, chunkSize) {
        return new Promise((resolve) => {
            log(`Starting transfer test with chunk size: ${chunkSize / 1024} KB...`);
            
            host.chunkSize = chunkSize;
            let startTime = 0;
            let heapStart = performance.memory ? performance.memory.usedJSHeapSize : null;
            let heapEnd = heapStart;

            const progressHandler = (e) => {
                // Periodically capture heap during transfer to check peak sizing
                if (performance.memory) {
                    const currentHeap = performance.memory.usedJSHeapSize;
                    if (currentHeap > heapEnd) heapEnd = currentHeap;
                }
            };

            const completedHandler = (e) => {
                const endTime = performance.now();
                const duration = endTime - startTime;
                
                // Discard data buffers on the joiner to prevent memory creep
                joiner.receivedChunks = [];
                
                // Clean up listeners
                joiner.removeEventListener('filecompleted', completedHandler);
                joiner.removeEventListener('fileprogress', progressHandler);
                
                const throughput = (file.size / (1024 * 1024)) / (duration / 1000);
                const heapGrowth = heapStart ? Math.max(0, heapEnd - heapStart) : null;

                log(`Chunk ${chunkSize / 1024}KB: Transferred in ${(duration / 1000).toFixed(2)}s | Speed: ${throughput.toFixed(2)} MB/s`);
                
                resolve({
                    time: duration,
                    throughput: throughput,
                    heapGrowth: heapGrowth
                });
            };

            joiner.addEventListener('fileprogress', progressHandler);
            joiner.addEventListener('filecompleted', completedHandler);

            // Accept transfer programmatically (Save to RAM to run in-process)
            joiner.addEventListener('fileincoming', async () => {
                // Programmatic simulation of click save to memory
                await joiner.acceptFileTransfer(false);
            }, { once: true });

            // Trigger file transfer from Host
            startTime = performance.now();
            host.sendFile(file);
        });
    }
});
