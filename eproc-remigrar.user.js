// ==UserScript==
// @name         eProc Remigrar Automation v2.0
// @namespace    eproc-tjsp
// @version      2.0
// @description  Robust bulk automation for "Remigrar Processo por Módulo" - handles 195k+ entries
// @author       Helpdesk Automation
// @match        https://eproc1g.tjsp.jus.br/eproc/controlador.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    const CONFIG = {
        // Storage keys
        CHECKPOINT_KEY: 'eproc_remigrar_checkpoint',
        SETTINGS_KEY: 'eproc_remigrar_settings',
        RESULTS_KEY: 'eproc_remigrar_results',

        // Processing parameters
        RESULTS_BUFFER_SIZE: 100,     // Export results every N cases

        // Timing - reduced since we now poll for actual result
        SUBMIT_DELAY_MS: 300,         // Small delay before submitting (form prep)
        RESULT_TIMEOUT_MS: 120000,    // Max wait for server response (2 minutes)
        RATE_LIMIT_DELAY_MS: 30000,   // Delay when rate-limited

        // URLs
        REMIGRAR_URL: 'https://eproc1g.tjsp.jus.br/eproc/controlador.php?acao=remigrar_processo'
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE DETECTION
    // ═══════════════════════════════════════════════════════════════════════════
    function isRemigrarPage() {
        const params = new URLSearchParams(window.location.search);
        return params.get('acao') === 'remigrar_processo';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════
    function hashString(str) {
        // Simple hash for file identification (first 1000 chars)
        const sample = str.substring(0, 1000);
        let hash = 0;
        for (let i = 0; i < sample.length; i++) {
            const char = sample.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    function formatTime(ms) {
        if (ms < 60000) return `${Math.round(ms / 1000)}s`;
        if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
        const hours = Math.floor(ms / 3600000);
        const mins = Math.round((ms % 3600000) / 60000);
        return `${hours}h ${mins}min`;
    }

    function formatDateTime(timestamp) {
        return new Date(timestamp).toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function downloadFile(content, filename, mimeType = 'text/csv;charset=utf-8') {
        const BOM = '\uFEFF';
        const blob = new Blob([BOM + content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function exportResults(results, instanceId = 1) {
        if (!results || results.length === 0) {
            console.log('[Remigrar] No results to export');
            return 0;
        }

        const headers = 'caso,timestamp,cas_status,cas_msg,zip_status,zip_msg,vid_status,vid_msg,resumo';
        const escape = (s) => `"${(s || '').replace(/"/g, '""')}"`;

        const rows = results.map(e => [
            e.caseNumber,
            formatDateTime(e.timestamp),
            e.casResult?.type || 'unknown',
            escape(e.casResult?.message || ''),
            e.zipResult?.type || 'unknown',
            escape(e.zipResult?.message || ''),
            e.videosResult?.type || 'unknown',
            escape(e.videosResult?.message || ''),
            e.summary || ''
        ].join(','));

        const csv = headers + '\n' + rows.join('\n');
        const timestamp = new Date().toISOString().slice(0, 10);
        const filename = `remigrar_${timestamp}_inst${instanceId}_${results.length}casos.csv`;
        downloadFile(csv, filename);

        console.log(`[Remigrar] ✅ Exported ${results.length} results to ${filename}`);
        return results.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SESSION MANAGER (Multi-Tab Isolation)
    // ═══════════════════════════════════════════════════════════════════════════
    const Session = {
        getId() {
            return sessionStorage.getItem('remigrar_instance_id');
        },
        setId(id) {
            sessionStorage.setItem('remigrar_instance_id', id);
        },
        clear() {
            sessionStorage.removeItem('remigrar_instance_id');
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // STORAGE MODULE
    // ═══════════════════════════════════════════════════════════════════════════
    const Storage = {
        _getKey(baseKey, instanceId = null) {
            // Priority: Explicit ID provided > Session ID > Default baseKey
            const id = instanceId || Session.getId();
            return id ? `${baseKey}_inst_${id}` : baseKey;
        },

        debugKeys() {
            try {
                const keys = GM_listValues();
                console.log('[Remigrar] 🛠️ STORAGE INSPECTOR: Found', keys.length, 'keys');
                keys.forEach(k => {
                    const val = GM_getValue(k);
                    const size = val ? val.length : 0;
                    console.log(` - ${k} (${size} bytes)`);
                });
            } catch (e) {
                console.error('[Remigrar] Storage inspect failed:', e);
            }
        },

        loadCheckpoint(instanceId = null) {
            try {
                const key = this._getKey(CONFIG.CHECKPOINT_KEY, instanceId);
                console.log(`[Remigrar] Attempting to load checkpoint from key: ${key}`);
                const data = GM_getValue(key, 'null');
                return JSON.parse(data);
            } catch (e) {
                console.error('[Remigrar] Failed to load checkpoint:', e);
                return null;
            }
        },

        saveCheckpoint(checkpoint) {
            checkpoint.lastCheckpoint = Date.now();
            // Always save to the instance defined in the checkpoint itself if available
            const key = this._getKey(CONFIG.CHECKPOINT_KEY, checkpoint.instanceId);
            GM_setValue(key, JSON.stringify(checkpoint));
        },

        clearCheckpoint(instanceId = null) {
            const key = this._getKey(CONFIG.CHECKPOINT_KEY, instanceId);
            GM_deleteValue(key);
        },

        loadSettings() {
            try {
                // Settings are global/shared to remember last used values
                const data = GM_getValue(CONFIG.SETTINGS_KEY, '{}');
                return JSON.parse(data);
            } catch (e) {
                return {};
            }
        },

        saveSettings(settings) {
            GM_setValue(CONFIG.SETTINGS_KEY, JSON.stringify(settings));
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // RESULT CLASSIFIER
    // ═══════════════════════════════════════════════════════════════════════════
    const ResultType = {
        SUCCESS: 'success',
        INFO: 'info',
        ERROR: 'error',
        EMPTY: 'empty',
        RATE_LIMITED: 'rate_limited',
        SILENT: 'silent'
    };

    // Wait for result to appear on page (server response)
    function waitForResult(timeout = 120000) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            // Check immediately first
            const immediate = classifyResponse();
            if (immediate.type !== ResultType.EMPTY) {
                console.log('[Remigrar] Result found immediately:', immediate);
                resolve(immediate);
                return;
            }

            // Poll for changes (simpler than MutationObserver for this use case)
            const checkInterval = setInterval(() => {
                const result = classifyResponse();
                if (result.type !== ResultType.EMPTY) {
                    clearInterval(checkInterval);
                    console.log('[Remigrar] Result found after', Date.now() - startTime, 'ms:', result);
                    resolve(result);
                    return;
                }

                if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    console.log('[Remigrar] Timeout waiting for result');
                    resolve({ type: ResultType.EMPTY, message: 'Timeout aguardando resposta' });
                }
            }, 200); // Check every 200ms
        });
    }

    function classifyResponse() {
        // Get the main content area (exclude our HUD)
        const mainContent = document.querySelector('.infraAreaTelaD, #divInfraAreaTelaD, main, .conteudo')
            || document.body;

        // Look for result containers - eProc uses specific patterns
        // Success: green cards with remigration results
        const successCards = mainContent.querySelectorAll('.msg-SUCESSO, .msgSucesso, [class*="sucesso"]:not(.remigrar-hud)');
        for (const card of successCards) {
            if (card.closest('.remigrar-hud')) continue; // Skip our HUD
            const items = card.querySelectorAll('li, .msg-text, p');
            const count = items.length || 1;
            console.log('[Remigrar] SUCCESS detected:', count, 'items');
            return { type: ResultType.SUCCESS, message: `${count} documento(s) remigrado(s)` };
        }

        // Info: blue/gray cards for "already OK"
        const infoCards = mainContent.querySelectorAll('.msg-INFO, .msgInfo');
        for (const card of infoCards) {
            if (card.closest('.remigrar-hud')) continue;
            const items = card.querySelectorAll('li, .msg-text, p');
            const count = items.length || 1;
            console.log('[Remigrar] INFO detected:', count, 'items');
            return { type: ResultType.INFO, message: `${count} documento(s) já OK` };
        }

        // Error: red cards or exception divs
        const errorDiv = mainContent.querySelector('.infraExcecao, .msg-ERRO, .msgErro');
        if (errorDiv) {
            const msg = errorDiv.textContent.trim().substring(0, 100);
            console.log('[Remigrar] ERROR detected:', msg);
            return { type: ResultType.ERROR, message: msg };
        }

        // Rate limiting
        const bodyText = mainContent.textContent || '';
        if (bodyText.includes('muitas requisições') || bodyText.includes('too many')) {
            return { type: ResultType.RATE_LIMITED, message: 'Rate limited' };
        }

        // NEW: Check for silent load (Form present implies page loaded but no message)
        // This is common for the "Videos" module when there is nothing to do
        if (document.getElementById('txtNumProcesso')) {
            return { type: ResultType.SILENT, message: 'Página carregada (sem mensagem da operação)' };
        }

        // Default: no result found yet (page might still be loading)
        return { type: ResultType.EMPTY, message: 'Aguardando resultado...' };
    }

    function summarizeResults(casResult, zipResult, videosResult) {
        const results = [casResult, zipResult, videosResult];

        if (results.some(r => r && r.type === ResultType.RATE_LIMITED)) return 'rate_limited';
        if (results.some(r => r && r.type === ResultType.ERROR)) return 'error';
        if (results.some(r => r && r.type === ResultType.SUCCESS)) return 'success';

        // If all are Info or Silent, it's Info (valid/clean)
        const nonInfoOrSilent = results.filter(r => r && r.type !== ResultType.INFO && r.type !== ResultType.SILENT);
        if (nonInfoOrSilent.length === 0) return 'info';

        return 'empty';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FILE PROCESSOR
    // ═══════════════════════════════════════════════════════════════════════════
    const FileProcessor = {
        _fileCases: [],
        _manualCases: [],
        _fileHash: null,
        _manualHash: null,
        _fileName: null,
        activeMode: 'file',

        get allCases() {
            return this.activeMode === 'manual' ? this._manualCases : this._fileCases;
        },

        get fileHash() {
            return this.activeMode === 'manual' ? this._manualHash : this._fileHash;
        },

        get fileName() {
            return this.activeMode === 'manual' ? 'Entrada Manual' : this._fileName;
        },

        parseFile(content) {
            return content
                .split(/[\n\r]+/)
                .map(line => line.trim().replace(/[^\d.-]/g, ''))
                .filter(line => line.length >= 20);
        },

        loadFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const content = e.target.result;
                    this._fileCases = this.parseFile(content);
                    this._fileHash = hashString(content);
                    this._fileName = file.name;
                    resolve({
                        totalCases: this._fileCases.length,
                        fileName: file.name,
                        fileHash: this._fileHash
                    });
                };
                reader.onerror = reject;
                reader.readAsText(file);
            });
        },

        loadText(text) {
            this._manualCases = this.parseFile(text);
            this._manualHash = hashString(text);
            return {
                totalCases: this._manualCases.length,
                fileName: 'Entrada Manual',
                fileHash: this._manualHash
            };
        },

        getSlice(instanceId, totalInstances) {
            const cases = this.allCases;
            const total = cases.length;
            const sliceSize = Math.ceil(total / totalInstances);
            const start = (instanceId - 1) * sliceSize;
            const end = Math.min(start + sliceSize, total);
            return { start, end, count: end - start };
        },

        getCase(absoluteIndex) {
            return this.allCases[absoluteIndex] || null;
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // RESULTS BUFFER (PERSISTED)
    // ═══════════════════════════════════════════════════════════════════════════
    const ResultsBuffer = {
        buffer: [],
        chunkNumber: 1,
        totalExported: 0,
        instanceId: 1,

        // Load persisted buffer from storage
        _load(instanceId = null) {
            try {
                const key = Storage._getKey(CONFIG.RESULTS_KEY, instanceId);
                const data = GM_getValue(key, 'null');
                const parsed = JSON.parse(data);
                if (parsed) {
                    this.buffer = parsed.buffer || [];
                    this.chunkNumber = parsed.chunkNumber || 1;
                    this.totalExported = parsed.totalExported || 0;
                    this.instanceId = parsed.instanceId || 1;
                    console.log(`[Remigrar] Loaded ${this.buffer.length} buffered results from storage (${key})`);
                }
            } catch (e) {
                console.error('[Remigrar] Failed to load results buffer:', e);
            }
        },

        // Save buffer to storage
        _save() {
            const key = Storage._getKey(CONFIG.RESULTS_KEY, this.instanceId);
            GM_setValue(key, JSON.stringify({
                buffer: this.buffer,
                chunkNumber: this.chunkNumber,
                totalExported: this.totalExported,
                instanceId: this.instanceId
            }));
        },

        // Initialize - load existing or start fresh
        init(instanceId, startChunk = 1, forceReset = false) {
            this.instanceId = instanceId;

            if (forceReset) {
                // Starting new session - clear everything
                this.chunkNumber = startChunk;
                this.buffer = [];
                this.totalExported = 0;
                this._save();
            } else {
                // Try to load existing data first
                this._load(instanceId);
                if (startChunk > this.chunkNumber) this.chunkNumber = startChunk;
            }
        },

        add(entry) {
            this.buffer.push(entry);
            this._save();  // Persist immediately
            console.log(`[Remigrar] Added result for ${entry.caseNumber}, buffer size: ${this.buffer.length}`);

            if (this.buffer.length >= CONFIG.RESULTS_BUFFER_SIZE) {
                this.flush();
            }
        },

        flush() {
            if (this.buffer.length === 0) {
                console.log('[Remigrar] Buffer empty, nothing to export');
                return 0;
            }

            const headers = 'caso,timestamp,cas_status,cas_msg,zip_status,zip_msg,vid_status,vid_msg,resumo';
            const rows = this.buffer.map(e => {
                const escape = (s) => `"${(s || '').replace(/"/g, '""')}"`;
                return [
                    e.caseNumber,
                    formatDateTime(e.timestamp),
                    e.casResult.type,
                    escape(e.casResult.message),
                    e.zipResult.type,
                    escape(e.zipResult.message),
                    e.videosResult.type,
                    escape(e.videosResult.message),
                    e.summary
                ].join(',');
            });

            const csv = headers + '\n' + rows.join('\n');
            const filename = `remigrar_results_inst${this.instanceId}_chunk${String(this.chunkNumber).padStart(3, '0')}.csv`;
            downloadFile(csv, filename);

            const exportedCount = this.buffer.length;
            this.totalExported += exportedCount;
            this.chunkNumber++;
            this.buffer = [];
            this._save();  // Persist the cleared buffer

            console.log(`[Remigrar] ✅ Exported chunk ${this.chunkNumber - 1} (${exportedCount} results)`);
            return exportedCount;
        },

        // Clear all persisted data (for new session)
        clear() {
            this.buffer = [];
            this.chunkNumber = 1;
            this.totalExported = 0;
            const key = Storage._getKey(CONFIG.RESULTS_KEY, this.instanceId);
            GM_deleteValue(key);
            console.log('[Remigrar] Results buffer cleared');
        },

        getStats() {
            return {
                buffered: this.buffer.length,
                exported: this.totalExported,
                chunks: this.chunkNumber - 1
            };
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTOMATION ENGINE
    // ═══════════════════════════════════════════════════════════════════════════
    const Automation = {
        isRunning: false,
        isPaused: false,
        currentCheckpoint: null,
        onProgressUpdate: null,
        onStatusUpdate: null,
        retryCount: 0,

        async start(instanceId, totalInstances) {
            // Lock session to this instance
            Session.setId(instanceId);

            const slice = FileProcessor.getSlice(instanceId, totalInstances);

            // Build queue of all case numbers for this slice
            // This allows processing without needing file after page reloads
            const caseQueue = [];
            for (let i = slice.start; i < slice.end; i++) {
                caseQueue.push(FileProcessor.getCase(i));
            }

            this.currentCheckpoint = {
                inputFileName: FileProcessor.fileName,
                inputFileHash: FileProcessor.fileHash,
                instanceId: instanceId,
                totalInstances: totalInstances,
                sliceStart: slice.start,
                sliceEnd: slice.end,
                currentIndex: slice.start,
                currentStep: 'cas',
                chunkNumber: 1,
                startedAt: Date.now(),
                processedCount: 0,
                results: {},
                caseQueue: caseQueue, // All cases for this slice stored in checkpoint
                isActive: true
            };

            Storage.saveCheckpoint(this.currentCheckpoint);

            this.isRunning = true;
            this.isPaused = false;
            this.processNext();
        },

        resume(checkpoint) {
            // Ensure session matches checkpoint
            if (checkpoint.instanceId) {
                Session.setId(checkpoint.instanceId);
            }
            this.currentCheckpoint = checkpoint;
            this.isRunning = true;
            this.isPaused = false;
            console.log('[Remigrar] Resuming from checkpoint:', checkpoint);
        },

        pause() {
            this.isPaused = true;
            if (this.currentCheckpoint) {
                this.currentCheckpoint.isActive = false;
            }
            Storage.saveCheckpoint(this.currentCheckpoint);
            this.updateStatus('⏸️ Pausado');
        },

        unpause() {
            this.isPaused = false;
            this.processNext();
        },

        stop() {
            this.isRunning = false;
            this.isPaused = false;

            // Export any results we have
            const cp = this.currentCheckpoint || Storage.loadCheckpoint();
            if (cp && cp.completedResults && cp.completedResults.length > 0) {
                exportResults(cp.completedResults, cp.instanceId);
                this.updateStatus(`⏹️ Parado. ${cp.completedResults.length} casos exportados.`);
            } else {
                this.updateStatus('⏹️ Parado');
            }

            Storage.clearCheckpoint();
            Session.clear(); // Clear session binding on stop
        },

        updateStatus(message) {
            if (this.onStatusUpdate) this.onStatusUpdate(message);
        },

        updateProgress() {
            if (this.onProgressUpdate) {
                const cp = this.currentCheckpoint;
                const total = cp.sliceEnd - cp.sliceStart;
                const current = cp.currentIndex - cp.sliceStart;
                const progress = current / total;
                const elapsed = Date.now() - cp.startedAt;
                const eta = progress > 0 ? (elapsed / progress) - elapsed : 0;

                const queueIndex = cp.currentIndex - cp.sliceStart;
                const caseNumber = cp.currentCaseNumber ||
                    (cp.caseQueue && cp.caseQueue[queueIndex]) ||
                    `#${cp.currentIndex}`;

                const completedCount = (cp.completedResults || []).length;

                this.onProgressUpdate({
                    current: current,
                    total: total,
                    percent: Math.round(progress * 100),
                    currentCase: caseNumber,
                    step: cp.currentStep.toUpperCase(),
                    eta: formatTime(eta),
                    completed: completedCount
                });

                // CRITICAL: Save checkpoint on progress update to ensure we never lose state
                // even if browser crashes mid-operation
                Storage.saveCheckpoint(cp);
            }
        },

        async processNext() {
            // Log entry to debug "going nowhere" issues
            console.log(`[Remigrar] processNext called. Running: ${this.isRunning}, Paused: ${this.isPaused}`);

            // Double check session ID integrity
            const currentSession = Session.getId();
            if (this.currentCheckpoint && currentSession && this.currentCheckpoint.instanceId != currentSession) {
                console.error(`[Remigrar] Session mismatch! Stored: ${this.currentCheckpoint.instanceId} vs Session: ${currentSession}`);
                // This shouldn't happen with the new isolation, but good to catch
            }

            if (!this.isRunning || this.isPaused) {
                console.log('[Remigrar] processNext aborted (not running or paused)');
                return;
            }

            const cp = this.currentCheckpoint;

            // 1. Check if we're done
            if (cp.currentIndex >= cp.sliceEnd) {
                // Export results from checkpoint
                const results = cp.completedResults || [];
                if (results.length > 0) {
                    exportResults(results, cp.instanceId);
                }

                const totalProcessed = results.length;
                Storage.clearCheckpoint();
                Session.clear();
                this.isRunning = false;
                this.updateStatus(`✅ Concluído! ${totalProcessed} casos processados e exportados.`);
                alert(`Processamento concluído!\n${totalProcessed} casos exportados para CSV.`);
                return;
            }

            // 2. Get case number for current step
            const queueIndex = cp.currentIndex - cp.sliceStart;
            let caseNumber;

            if (cp.currentStep !== 'cas' && cp.currentCaseNumber) {
                // Continuing same case (ZIP or VID step)
                caseNumber = cp.currentCaseNumber;
            } else if (cp.caseQueue && cp.caseQueue[queueIndex]) {
                // Starting new case
                caseNumber = cp.caseQueue[queueIndex];
            } else {
                // Fallback
                caseNumber = FileProcessor.getCase(cp.currentIndex);
            }

            if (!caseNumber) {
                console.error('[Remigrar] No case number available at index:', cp.currentIndex);
                this.updateStatus('⚠️ Erro: fila de casos não disponível');
                this.isRunning = false;
                return;
            }

            // 3. Determine module
            let module;
            if (cp.currentStep === 'cas') module = 'documentos_cas';
            else if (cp.currentStep === 'zip') module = 'documentos_zip';
            else module = 'videos';

            // 4. Fill form (works on both main page and result page)
            const input = document.getElementById('txtNumProcesso');
            const select = document.getElementById('selModulo');
            const button = document.querySelector('button[type="submit"].infraButton');

            if (!input || !select || !button) {
                console.log('[Remigrar] Form elements not found (Input:', !!input, 'Select:', !!select, 'Button:', !!button, '), redirecting to fresh page...');
                // Save state so we resume immediately after load
                cp.currentCaseNumber = caseNumber;
                cp.isActive = true;
                Storage.saveCheckpoint(cp);
                window.location.href = CONFIG.REMIGRAR_URL;
                return;
            }

            input.value = caseNumber;
            select.value = module;

            // Trigger events to ensure internal state updates (React/Frameworks/Validation)
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));

            this.updateProgress();
            this.updateStatus(`🔄 ${caseNumber} (${cp.currentStep.toUpperCase()})`);

            // 5. Update checkpoint BEFORE submit
            cp.currentCaseNumber = caseNumber;
            cp.awaitingResult = true;
            Storage.saveCheckpoint(cp);

            // 6. Submit after brief delay
            console.log(`[Remigrar] Submitting: ${caseNumber} / ${module}`);
            setTimeout(() => {
                // Determine if we need to clean up first (try to find and click 'Limpar' if exists? No, relying on overwrite)

                // Watchdog: If page doesn't unload/reload within 10 seconds, assume stuck and retry
                const watchdogId = setTimeout(() => {
                    console.warn('[Remigrar] ⚠️ Submission watchdog triggered - page did not reload.');

                    // Revert state to retry this step
                    const currentCp = Storage.loadCheckpoint();
                    if (currentCp && currentCp.awaitingResult) {
                        currentCp.awaitingResult = false; // Cancel expectation of result since we failed to submit
                        Storage.saveCheckpoint(currentCp);

                        console.log('[Remigrar] Redirecting to clean page to retry...');
                        window.location.href = CONFIG.REMIGRAR_URL;
                    }
                }, 10000); // 10 seconds timeout

                // Attempt submit
                try {
                    button.click();
                    // If successful, page unloads and watchdog is killed by browser
                } catch (e) {
                    console.error('[Remigrar] Submit click failed:', e);
                    // Watchdog will catch this if logic flow continues
                }
            }, CONFIG.SUBMIT_DELAY_MS);
        },

        async handleResult() {
            try {
                const cp = Storage.loadCheckpoint();
                if (!cp || !cp.awaitingResult) return false;

                const caseNumber = cp.currentCaseNumber;
                console.log(`[Remigrar] Waiting for result: ${caseNumber} (${cp.currentStep})`);
                this.updateStatus?.(`⏳ ${caseNumber} (${cp.currentStep.toUpperCase()})`);

                // Wait for result to appear
                const result = await waitForResult(CONFIG.RESULT_TIMEOUT_MS);
                console.log('[Remigrar] Got result:', result);

                // Handle rate limiting
                if (result.type === ResultType.RATE_LIMITED) {
                    console.warn('[Remigrar] Rate limited, waiting...');
                    this.updateStatus?.(`⚠️ Rate limited - aguardando ${CONFIG.RATE_LIMIT_DELAY_MS / 1000}s`);
                    setTimeout(() => {
                        cp.awaitingResult = false;
                        Storage.saveCheckpoint(cp);
                        this.currentCheckpoint = cp;
                        this.processNext();
                    }, CONFIG.RATE_LIMIT_DELAY_MS);
                    return true;
                }

                // Store result for current step
                console.log('[Remigrar] Storing result for step:', cp.currentStep);
                if (!cp.results) cp.results = {};

                if (cp.currentStep === 'cas') {
                    cp.results.casResult = result;
                    cp.currentStep = 'zip';
                    console.log('[Remigrar] Advanced to ZIP');
                } else if (cp.currentStep === 'zip') {
                    cp.results.zipResult = result;
                    cp.currentStep = 'videos';
                    console.log('[Remigrar] Advanced to VIDEOS');
                } else {
                    cp.results.videosResult = result;
                    console.log('[Remigrar] Finished case');

                    // All steps done - save entry
                    const entry = {
                        caseNumber: caseNumber,
                        timestamp: Date.now(),
                        casResult: cp.results.casResult,
                        zipResult: cp.results.zipResult,
                        videosResult: cp.results.videosResult,
                        summary: summarizeResults(
                            cp.results.casResult,
                            cp.results.zipResult,
                            cp.results.videosResult
                        )
                    };

                    if (!cp.completedResults) cp.completedResults = [];
                    cp.completedResults.push(entry);
                    console.log(`[Remigrar] ✅ ${caseNumber} done. Total: ${cp.completedResults.length}`);

                    // Move to next case
                    cp.currentIndex++;
                    cp.currentStep = 'cas';
                    cp.results = {};
                }

                console.log('[Remigrar] Saving checkpoint...');
                cp.awaitingResult = false;
                Storage.saveCheckpoint(cp);
                this.currentCheckpoint = cp;
                console.log('[Remigrar] Checkpoint saved.');

                // Continue immediately on the same page
                console.log('[Remigrar] handleResult calling processNext(). isRunning:', this.isRunning);

                // Critical safety check
                if (!this.isRunning) {
                    console.warn('[Remigrar] handleResult detected stopped state, forcing resume');
                    this.isRunning = true;
                }

                this.processNext();
                return true;
            } catch (error) {
                console.error('[Remigrar] CRITICAL ERROR in handleResult:', error);
                this.updateStatus('❌ Erro no processamento (ver console)');
                return false;
            }
        },



        getProgress() {
            const cp = this.currentCheckpoint || Storage.loadCheckpoint();
            if (!cp) return null;

            const total = cp.sliceEnd - cp.sliceStart;
            const current = cp.currentIndex - cp.sliceStart;
            const queueIndex = cp.currentIndex - cp.sliceStart;

            return {
                current,
                total,
                percent: Math.round((current / total) * 100),
                currentCase: cp.currentCaseNumber || (cp.caseQueue && cp.caseQueue[queueIndex]) || `#${cp.currentIndex}`,
                step: cp.currentStep ? cp.currentStep.toUpperCase() : 'N/A',
                instanceId: cp.instanceId,
                isRunning: this.isRunning,
                isPaused: this.isPaused,
                completed: (cp.completedResults || []).length
            };
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // HUD COMPONENT
    // ═══════════════════════════════════════════════════════════════════════════
    function createHUD() {
        const hud = document.createElement('div');
        hud.id = 'remigrar-hud';
        hud.innerHTML = `
            <style>
                #remigrar-hud {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 420px;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    border: 1px solid #4a5568;
                    border-radius: 12px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
                    font-family: 'Segoe UI', Tahoma, sans-serif;
                    font-size: 13px;
                    color: #e2e8f0;
                    z-index: 99999;
                    overflow: hidden;
                }
                #remigrar-hud-header {
                    background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
                    padding: 12px 15px;
                    font-weight: 600;
                    font-size: 14px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: move;
                }
                #remigrar-hud-header span {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #remigrar-hud-toggle {
                    background: rgba(255,255,255,0.2);
                    border: none;
                    color: white;
                    width: 24px;
                    height: 24px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                }
                #remigrar-hud-body {
                    padding: 15px;
                }
                #remigrar-hud-body.collapsed {
                    display: none;
                }
                .remigrar-section {
                    margin-bottom: 15px;
                    padding-bottom: 15px;
                    border-bottom: 1px solid #4a5568;
                }
                .remigrar-section:last-child {
                    margin-bottom: 0;
                    padding-bottom: 0;
                    border-bottom: none;
                }
                .remigrar-section-title {
                    font-weight: 600;
                    margin-bottom: 10px;
                    color: #a0aec0;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .remigrar-file-info {
                    background: #2d3748;
                    padding: 10px;
                    border-radius: 6px;
                    margin-bottom: 10px;
                }
                .remigrar-file-info.empty {
                    text-align: center;
                    color: #718096;
                }
                #remigrar-file-input {
                    display: none;
                }
                .remigrar-file-btn {
                    display: block;
                    width: 100%;
                    padding: 12px;
                    background: linear-gradient(90deg, #4299e1 0%, #3182ce 100%);
                    border: none;
                    border-radius: 6px;
                    color: white;
                    font-weight: 600;
                    cursor: pointer;
                    text-align: center;
                }
                .remigrar-file-btn:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(66, 153, 225, 0.4);
                }
                .remigrar-instance-row {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                }
                .remigrar-instance-group {
                    flex: 1;
                }
                .remigrar-instance-group label {
                    display: block;
                    font-size: 11px;
                    color: #a0aec0;
                    margin-bottom: 4px;
                }
                .remigrar-instance-group input {
                    width: 100%;
                    padding: 8px;
                    background: #2d3748;
                    border: 1px solid #4a5568;
                    border-radius: 4px;
                    color: #e2e8f0;
                    font-size: 14px;
                    text-align: center;
                    box-sizing: border-box;
                }
                .remigrar-slice-info {
                    background: #2d3748;
                    padding: 8px 10px;
                    border-radius: 4px;
                    font-size: 12px;
                    text-align: center;
                }
                #remigrar-controls {
                    display: flex;
                    gap: 8px;
                }
                .remigrar-btn {
                    flex: 1;
                    padding: 10px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 600;
                    font-size: 13px;
                    transition: all 0.2s;
                }
                .remigrar-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .remigrar-btn-primary {
                    background: linear-gradient(90deg, #48bb78 0%, #38a169 100%);
                    color: white;
                }
                .remigrar-btn-primary:hover:not(:disabled) {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(72, 187, 120, 0.4);
                }
                .remigrar-btn-warning {
                    background: linear-gradient(90deg, #ed8936 0%, #dd6b20 100%);
                    color: white;
                }
                .remigrar-btn-danger {
                    background: linear-gradient(90deg, #f56565 0%, #e53e3e 100%);
                    color: white;
                }
                .remigrar-btn-secondary {
                    background: #4a5568;
                    color: white;
                }
                #remigrar-progress-container {
                    margin-bottom: 10px;
                }
                #remigrar-progress-bar {
                    width: 100%;
                    height: 20px;
                    background: #2d3748;
                    border-radius: 10px;
                    overflow: hidden;
                    position: relative;
                }
                #remigrar-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #48bb78 0%, #38a169 100%);
                    transition: width 0.3s ease;
                    border-radius: 10px;
                }
                #remigrar-progress-text {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    font-size: 11px;
                    font-weight: 600;
                    color: white;
                    text-shadow: 0 1px 2px rgba(0,0,0,0.5);
                }
                #remigrar-status {
                    background: #2d3748;
                    padding: 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    line-height: 1.6;
                }
                .status-row {
                    display: flex;
                    justify-content: space-between;
                }
                .status-label {
                    color: #a0aec0;
                }
                .status-value {
                    font-weight: 600;
                }
                #remigrar-export-stats {
                    background: #1a365d;
                    padding: 10px;
                    border-radius: 6px;
                    font-size: 12px;
                }
                .processing-indicator {
                    animation: pulse 1.5s infinite;
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
                .resume-banner {
                    background: linear-gradient(90deg, #ed8936 0%, #dd6b20 100%);
                    padding: 15px;
                    border-radius: 6px;
                    margin-bottom: 15px;
                    text-align: center;
                }
                .resume-banner-title {
                    font-weight: 600;
                    margin-bottom: 5px;
                }
                .resume-banner-info {
                    font-size: 11px;
                    opacity: 0.9;
                    margin-bottom: 10px;
                }
                .resume-banner-buttons {
                    display: flex;
                    gap: 8px;
                    justify-content: center;
                }
                /* New Casual Mode Styles */
                #remigrar-manual-input {
                    width: 100%;
                    height: 120px;
                    background: #2d3748;
                    border: 1px solid #4a5568;
                    border-radius: 6px;
                    color: #e2e8f0;
                    padding: 10px;
                    font-family: 'Consolas', monospace;
                    font-size: 12px;
                    resize: vertical;
                    box-sizing: border-box;
                    margin-bottom: 5px;
                }
                #remigrar-manual-input:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.3);
                }
                .mode-hidden {
                    display: none !important;
                }
                #remigrar-mode-btn {
                    background: rgba(255,255,255,0.15);
                    border: none;
                    color: #e2e8f0;
                    cursor: pointer;
                    width: 28px;
                    height: 24px;
                    margin-right: 5px;
                    border-radius: 4px;
                    transition: all 0.2s;
                    font-size: 14px;
                }
                #remigrar-mode-btn:hover {
                    background: rgba(255,255,255,0.3);
                    color: white;
                    transform: scale(1.05);
                }
                .input-count-badge {
                    float: right;
                    background: #4a5568;
                    padding: 2px 6px;
                    border-radius: 10px;
                    font-size: 10px;
                    color: #a0aec0;
                }
            </style>
            <div id="remigrar-hud-header">
                <span>⚡ Remigrar <span id="remigrar-mode-label" style="opacity:0.7; font-weight:normal; font-size:12px; margin-left:5px">Casual</span></span>
                <div style="display:flex; align-items:center">
                    <button id="remigrar-mode-btn" title="Alternar Modo Casual/Bulk">🔄</button>
                    <button id="remigrar-hud-toggle">−</button>
                </div>
            </div>
            <div id="remigrar-hud-body">
                <div id="remigrar-resume-banner" style="display: none;"></div>

                <!-- CASUAL MODE CONTAINER -->
                <div id="remigrar-casual-container">
                    <div class="remigrar-section">
                        <div class="remigrar-section-title">
                            📝 Entrada Manual
                            <span id="remigrar-manual-count" class="input-count-badge">0</span>
                        </div>
                        <textarea id="remigrar-manual-input" placeholder="Cole os números dos processos aqui (um por linha)..."></textarea>
                        <div id="remigrar-manual-status" class="remigrar-slice-info" style="text-align:left; color:#a0aec0; padding:5px;">
                            Cole a lista para iniciar
                        </div>
                    </div>
                </div>

                <!-- BULK MODE CONTAINER -->
                <div id="remigrar-bulk-container" class="mode-hidden">
                    <div class="remigrar-section">
                        <div class="remigrar-section-title">📁 Arquivo de Entrada</div>
                        <div id="remigrar-file-info" class="remigrar-file-info empty">
                            Nenhum arquivo selecionado
                        </div>
                        <input type="file" id="remigrar-file-input" accept=".txt,.csv">
                        <label for="remigrar-file-input" class="remigrar-file-btn">📂 Selecionar Arquivo</label>
                    </div>

                    <div class="remigrar-section">
                        <div class="remigrar-section-title">🖥️ Multi-Instância</div>
                        <div class="remigrar-instance-row">
                            <div class="remigrar-instance-group">
                                <label>Esta Instância</label>
                                <input type="number" id="remigrar-instance-id" min="1" value="1">
                            </div>
                            <div class="remigrar-instance-group">
                                <label>Total de Instâncias</label>
                                <input type="number" id="remigrar-total-instances" min="1" value="1">
                            </div>
                        </div>
                        <div id="remigrar-slice-info" class="remigrar-slice-info">
                            Carregue um arquivo para ver a distribuição
                        </div>
                    </div>
                </div>

                <div class="remigrar-section">
                    <div class="remigrar-section-title">🎮 Controles</div>
                    <div id="remigrar-controls">
                        <button id="remigrar-start" class="remigrar-btn remigrar-btn-primary" disabled>▶ Iniciar</button>
                        <button id="remigrar-pause" class="remigrar-btn remigrar-btn-warning" disabled>⏸ Pausar</button>
                        <button id="remigrar-stop" class="remigrar-btn remigrar-btn-danger" disabled>⏹ Parar</button>
                    </div>
                </div>

                <div class="remigrar-section">
                    <div class="remigrar-section-title">📊 Progresso</div>
                    <div id="remigrar-progress-container">
                        <div id="remigrar-progress-bar">
                            <div id="remigrar-progress-fill" style="width: 0%"></div>
                            <span id="remigrar-progress-text">0%</span>
                        </div>
                    </div>
                    <div id="remigrar-status">
                        <div class="status-row">
                            <span class="status-label">Status:</span>
                            <span class="status-value" id="status-state">Aguardando...</span>
                        </div>
                        <div class="status-row">
                            <span class="status-label">Caso Atual:</span>
                            <span class="status-value" id="status-case">-</span>
                        </div>
                        <div class="status-row">
                            <span class="status-label">Etapa:</span>
                            <span class="status-value" id="status-step">-</span>
                        </div>
                        <div class="status-row">
                            <span class="status-label">ETA:</span>
                            <span class="status-value" id="status-eta">-</span>
                        </div>
                    </div>
                </div>

                <div class="remigrar-section">
                    <div class="remigrar-section-title">� Resultados</div>
                    <div id="remigrar-export-stats">
                        <div class="status-row">
                            <span class="status-label">Casos Completos:</span>
                            <span class="status-value" id="completed-count">0</span>
                        </div>
                    </div>
                    <button id="remigrar-export-now" class="remigrar-btn remigrar-btn-secondary" style="margin-top: 10px; width: 100%;">
                        📥 Exportar Agora
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(hud);

        // ═══════════════════════════════════════════════════════════════════════
        // HUD ELEMENTS
        // ═══════════════════════════════════════════════════════════════════════
        const elements = {
            toggle: hud.querySelector('#remigrar-hud-toggle'),
            modeBtn: hud.querySelector('#remigrar-mode-btn'),
            modeLabel: hud.querySelector('#remigrar-mode-label'),
            body: hud.querySelector('#remigrar-hud-body'),
            // Containers
            casualContainer: hud.querySelector('#remigrar-casual-container'),
            bulkContainer: hud.querySelector('#remigrar-bulk-container'),
            // Manual Inputs
            manualInput: hud.querySelector('#remigrar-manual-input'),
            manualCount: hud.querySelector('#remigrar-manual-count'),
            manualStatus: hud.querySelector('#remigrar-manual-status'),
            // Bulk Inputs
            fileInput: hud.querySelector('#remigrar-file-input'),
            fileInfo: hud.querySelector('#remigrar-file-info'),
            instanceId: hud.querySelector('#remigrar-instance-id'),
            totalInstances: hud.querySelector('#remigrar-total-instances'),
            sliceInfo: hud.querySelector('#remigrar-slice-info'),
            // Controls
            startBtn: hud.querySelector('#remigrar-start'),
            pauseBtn: hud.querySelector('#remigrar-pause'),
            stopBtn: hud.querySelector('#remigrar-stop'),
            progressFill: hud.querySelector('#remigrar-progress-fill'),
            progressText: hud.querySelector('#remigrar-progress-text'),
            statusState: hud.querySelector('#status-state'),
            statusCase: hud.querySelector('#status-case'),
            statusStep: hud.querySelector('#status-step'),
            statusEta: hud.querySelector('#status-eta'),
            completedCount: hud.querySelector('#completed-count'),
            exportBtn: hud.querySelector('#remigrar-export-now'),
            resumeBanner: hud.querySelector('#remigrar-resume-banner')
        };

        // ═══════════════════════════════════════════════════════════════════════
        // HUD STATE & RESUME LOGIC
        // ═══════════════════════════════════════════════════════════════════════
        let fileLoaded = false;

        // Function to check for resume based on input
        function updateResumeStatus() {
            // Check based on INPUT value, explicitly ignoring current session state
            // This allows finding "lost" sessions after a browser restart
            const targetId = elements.instanceId.value;
            const cp = Storage.loadCheckpoint(targetId);

            // Console log to debug what we are finding
            console.log(`[Remigrar] Checking resume for ID ${targetId}:`, cp ? 'Found' : 'Null');

            // Update completed count from this potential checkpoint
            if (cp && cp.completedResults) {
                elements.completedCount.textContent = cp.completedResults.length;
            } else {
                elements.completedCount.textContent = '0';
            }

            // Show/Hide resume banner
            // We show it if we found a checkpoint that is NOT actively running (isActive=false) or if we just loaded it
            // Note: On browser restart, isActive might still be true if it crashed, so we should arguably show it regardless
            if (cp && !window._remigrarPendingAutomation) {
                showResumeBanner(cp);
            } else {
                elements.resumeBanner.style.display = 'none';
            }
        }

        // Load saved settings
        const settings = Storage.loadSettings();

        // Priority: Session ID > Settings > Default
        const activeSessionId = Session.getId();

        if (activeSessionId) {
            elements.instanceId.value = activeSessionId;
            elements.instanceId.disabled = true; // Lock it if session is active
            console.log('[Remigrar] Locked to Session Instance:', activeSessionId);

            // Also try to restore totalInstances from checkpoint if possible
            const cp = Storage.loadCheckpoint(activeSessionId);
            if (cp && cp.totalInstances) {
                elements.totalInstances.value = cp.totalInstances;
                elements.totalInstances.disabled = true;
            } else if (settings.totalInstances) {
                elements.totalInstances.value = settings.totalInstances;
            }
        } else {
            // Setup mode - use last saved settings
            if (settings.instanceId) elements.instanceId.value = settings.instanceId;
            if (settings.totalInstances) elements.totalInstances.value = settings.totalInstances;
        }

        // Initial check for resume based on whatever ID is in the box
        updateResumeStatus();

        // Add listener to update resume status when ID changes
        elements.instanceId.addEventListener('input', updateResumeStatus);

        // ═══════════════════════════════════════════════════════════════════════
        // HUD FUNCTIONS
        // ═══════════════════════════════════════════════════════════════════════
        function updateSliceInfo() {
            if (!fileLoaded) {
                elements.sliceInfo.textContent = 'Carregue um arquivo para ver a distribuição';
                return;
            }

            const instanceId = parseInt(elements.instanceId.value) || 1;
            const totalInstances = parseInt(elements.totalInstances.value) || 1;
            const slice = FileProcessor.getSlice(instanceId, totalInstances);

            elements.sliceInfo.innerHTML = `
                Sua faixa: <strong>${slice.start.toLocaleString()}</strong> → 
                <strong>${(slice.end - 1).toLocaleString()}</strong> 
                (<strong>${slice.count.toLocaleString()}</strong> casos)
            `;

            // Save settings
            Storage.saveSettings({ instanceId, totalInstances });
        }

        function updateProgress(progress) {
            elements.progressFill.style.width = `${progress.percent}%`;
            elements.progressText.textContent = `${progress.percent}%`;
            elements.statusCase.textContent = progress.currentCase || '-';
            elements.statusStep.textContent = progress.step || '-';
            elements.statusEta.textContent = progress.eta || '-';
            elements.completedCount.textContent = progress.completed || 0;
        }

        function updateStatus(message) {
            elements.statusState.innerHTML = message;
        }

        function setRunningState(isRunning, isPaused = false) {
            elements.startBtn.disabled = isRunning;
            elements.pauseBtn.disabled = !isRunning;
            elements.stopBtn.disabled = !isRunning;
            elements.fileInput.disabled = isRunning;
            elements.instanceId.disabled = isRunning;
            elements.totalInstances.disabled = isRunning;

            if (isPaused) {
                elements.pauseBtn.textContent = '▶ Retomar';
                elements.pauseBtn.classList.remove('remigrar-btn-warning');
                elements.pauseBtn.classList.add('remigrar-btn-primary');
            } else {
                elements.pauseBtn.textContent = '⏸ Pausar';
                elements.pauseBtn.classList.add('remigrar-btn-warning');
                elements.pauseBtn.classList.remove('remigrar-btn-primary');
            }
        }

        function showResumeBanner(checkpoint) {
            const elapsed = formatTime(Date.now() - checkpoint.startedAt);
            const progress = Math.round(((checkpoint.currentIndex - checkpoint.sliceStart) / (checkpoint.sliceEnd - checkpoint.sliceStart)) * 100);

            elements.resumeBanner.style.display = 'block';
            elements.resumeBanner.innerHTML = `
                <div class="resume-banner-title">⚠️ Sessão Anterior Encontrada</div>
                <div class="resume-banner-info">
                    Arquivo: ${checkpoint.inputFileName}<br>
                    Instância ${checkpoint.instanceId}/${checkpoint.totalInstances} | 
                    Progresso: ${progress}% | Tempo: ${elapsed}
                </div>
                <div class="resume-banner-buttons">
                    <button id="resume-yes" class="remigrar-btn remigrar-btn-primary">▶ Retomar</button>
                    <button id="resume-no" class="remigrar-btn remigrar-btn-secondary">🔄 Recomeçar</button>
                </div>
            `;

            elements.resumeBanner.querySelector('#resume-yes').onclick = () => {
                elements.resumeBanner.style.display = 'none';

                // Check if we have caseQueue in checkpoint (new format)
                if (checkpoint.caseQueue && checkpoint.caseQueue.length > 0) {
                    // Can resume directly without file
                    console.log('[Remigrar] Resuming directly from stored queue');
                    elements.instanceId.value = checkpoint.instanceId;
                    elements.totalInstances.value = checkpoint.totalInstances;
                    updateSliceInfo();

                    // Update file info display
                    elements.fileInfo.classList.remove('empty');
                    elements.fileInfo.innerHTML = `
                        <strong>${checkpoint.inputFileName}</strong> (da sessão anterior)<br>
                        ${checkpoint.caseQueue.length.toLocaleString()} casos na fila
                    `;

                    setRunningState(true);
                    Automation.currentCheckpoint = checkpoint;
                    Automation.isRunning = true;
                    Automation.processNext();
                } else {
                    // Old format - need file reload
                    alert(`Por favor, selecione o mesmo arquivo: ${checkpoint.inputFileName}`);
                    window.pendingResume = checkpoint;
                }
            };

            elements.resumeBanner.querySelector('#resume-no').onclick = () => {
                Storage.clearCheckpoint();
                elements.resumeBanner.style.display = 'none';
            };
        }

        // ═══════════════════════════════════════════════════════════════════════
        // HUD EVENT HANDLERS
        // ═══════════════════════════════════════════════════════════════════════

        // Toggle collapse
        elements.toggle.addEventListener('click', () => {
            elements.body.classList.toggle('collapsed');
            elements.toggle.textContent = elements.body.classList.contains('collapsed') ? '+' : '−';
        });

        // File selection
        elements.fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                updateStatus('📂 Carregando arquivo...');
                const result = await FileProcessor.loadFile(file);

                elements.fileInfo.classList.remove('empty');
                elements.fileInfo.innerHTML = `
                    <strong>${result.fileName}</strong><br>
                    ${result.totalCases.toLocaleString()} casos válidos
                `;

                fileLoaded = true;
                elements.startBtn.disabled = false;
                updateSliceInfo();

                // Check for pending resume
                if (window.pendingResume) {
                    const checkpoint = window.pendingResume;
                    if (checkpoint.inputFileHash === FileProcessor.fileHash) {
                        elements.instanceId.value = checkpoint.instanceId;
                        elements.totalInstances.value = checkpoint.totalInstances;
                        updateSliceInfo();

                        // Resume and BIND session
                        Session.setId(checkpoint.instanceId);
                        Automation.resume(checkpoint);
                        setRunningState(true);
                        Automation.processNext();
                        delete window.pendingResume;
                    } else {
                        alert('⚠️ Hash do arquivo não corresponde! Não é possível retomar. Iniciando nova sessão.');
                        Storage.clearCheckpoint(checkpoint.instanceId);
                        delete window.pendingResume;
                    }
                }

                updateStatus('✅ Arquivo carregado');
            } catch (err) {
                console.error('[Remigrar] File load error:', err);
                updateStatus('❌ Erro ao carregar arquivo');
            }
        });

        // Instance settings change
        elements.instanceId.addEventListener('change', updateSliceInfo);
        elements.totalInstances.addEventListener('change', updateSliceInfo);

        // Toggle Mode logic
        let isCasualMode = true; // Default to casual

        function toggleMode(setCasual = null) {
            isCasualMode = setCasual !== null ? setCasual : !isCasualMode;

            // Sync FileProcessor mode
            FileProcessor.activeMode = isCasualMode ? 'manual' : 'file';

            if (isCasualMode) {
                elements.modeLabel.textContent = 'Casual';
                elements.casualContainer.classList.remove('mode-hidden');
                elements.bulkContainer.classList.add('mode-hidden');

                // Update button state based on manual input
                const count = FileProcessor.allCases.length;
                elements.startBtn.disabled = count === 0;
            } else {
                elements.modeLabel.textContent = 'Bulk';
                elements.casualContainer.classList.add('mode-hidden');
                elements.bulkContainer.classList.remove('mode-hidden');
                elements.startBtn.disabled = !fileLoaded;
            }

            Storage.saveSettings({ ...Storage.loadSettings(), isCasualMode });
        }

        elements.modeBtn.addEventListener('click', () => toggleMode());

        // Restore mode setting
        if (settings.isCasualMode !== undefined) {
            toggleMode(settings.isCasualMode);
        } else {
            toggleMode(true); // Default
        }

        // Manual Input Handler
        elements.manualInput.addEventListener('input', (e) => {
            const text = e.target.value;
            const result = FileProcessor.loadText(text);

            elements.manualCount.textContent = result.totalCases;
            if (result.totalCases > 0) {
                elements.manualStatus.textContent = `✅ ${result.totalCases} casos identificados`;
                elements.manualStatus.style.color = '#48bb78';
                elements.startBtn.disabled = false;
            } else {
                elements.manualStatus.textContent = 'Aguardando entrada válida...';
                elements.manualStatus.style.color = '#a0aec0';
                elements.startBtn.disabled = true;
            }
        });

        // Start button
        elements.startBtn.addEventListener('click', () => {
            let instanceId = 1;
            let totalInstances = 1;

            if (isCasualMode) {
                // In casual mode, we use the text input and force instance 1/1
                const text = elements.manualInput.value;
                const result = FileProcessor.loadText(text);
                if (result.totalCases === 0) {
                    alert('Nenhum caso válido encontrado no texto!');
                    return;
                }
                // Instance ID and Total are always 1 for casual
            } else {
                // Bulk mode checks
                instanceId = parseInt(elements.instanceId.value) || 1;
                totalInstances = parseInt(elements.totalInstances.value) || 1;

                if (instanceId < 1 || instanceId > totalInstances) {
                    alert('ID da instância deve estar entre 1 e o total de instâncias');
                    return;
                }
            }

            setRunningState(true);
            Automation.start(instanceId, totalInstances);
        });

        // Pause button
        elements.pauseBtn.addEventListener('click', () => {
            if (Automation.isPaused) {
                Automation.unpause();
                setRunningState(true, false);
            } else {
                Automation.pause();
                setRunningState(true, true);
            }
        });

        // Stop button
        elements.stopBtn.addEventListener('click', () => {
            if (confirm('Parar processamento? O progresso será perdido.')) {
                Automation.stop();
                setRunningState(false);
            }
        });

        // Export button - exports results from checkpoint
        elements.exportBtn.addEventListener('click', () => {
            const cp = Storage.loadCheckpoint();

            if (!cp || !cp.completedResults || cp.completedResults.length === 0) {
                updateStatus('ℹ️ Nenhum resultado para exportar');
                return;
            }

            const exported = exportResults(cp.completedResults, cp.instanceId);
            updateStatus(`📥 Exportados ${exported} resultados`);
        });

        // Connect automation callbacks
        Automation.onProgressUpdate = updateProgress;
        Automation.onStatusUpdate = updateStatus;

        // Make draggable
        let isDragging = false;
        let offsetX, offsetY;
        const header = hud.querySelector('#remigrar-hud-header');

        header.addEventListener('mousedown', (e) => {
            if (e.target === elements.toggle) return;
            isDragging = true;
            offsetX = e.clientX - hud.offsetLeft;
            offsetY = e.clientY - hud.offsetTop;
            hud.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            hud.style.left = (e.clientX - offsetX) + 'px';
            hud.style.top = (e.clientY - offsetY) + 'px';
            hud.style.right = 'auto';
            hud.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        // ═══════════════════════════════════════════════════════════════════════
        // CHECK FOR EXISTING CHECKPOINT
        // ═══════════════════════════════════════════════════════════════════════
        const existingCheckpoint = Storage.loadCheckpoint();
        // Only show banner if checkpoint exists but automation is not auto-continuing
        // (i.e., paused or stopped state - not awaitingResult and not isActive)
        // Skip showing banner if pendingAutomation flag is set (will auto-continue)
        if (existingCheckpoint && !existingCheckpoint.awaitingResult && !existingCheckpoint.isActive && !window._remigrarPendingAutomation) {
            showResumeBanner(existingCheckpoint);
        }

        return { updateProgress, updateStatus, setRunningState };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('[Remigrar] ========== SCRIPT STARTING ==========');
    console.log('[Remigrar] URL:', window.location.href);
    console.log('[Remigrar] isRemigrarPage:', isRemigrarPage());

    // Debug storage immediately
    Storage.debugKeys();

    // Try to load checkpoint using default logic (session ID if present)
    let checkpoint = Storage.loadCheckpoint();

    // AUTO-RECOVERY LOGIC FOR RESULT PAGES
    // If we are on a result page (remigrar_processo_modulo) but found no checkpoint
    // (likely because Session.getId() is empty after browser restart),
    // we must aggressively hunt for the correct checkpoint to latch onto.
    const isResultPage = window.location.search.includes('remigrar_processo_modulo');
    if (isResultPage && !checkpoint) {
        console.warn('[Remigrar] Result page detected but no checkpoint/session found! attempting auto-discovery...');

        const keys = GM_listValues();
        for (const key of keys) {
            if (key.startsWith(CONFIG.CHECKPOINT_KEY + '_inst_')) {
                const possibleCp = JSON.parse(GM_getValue(key));
                // If this checkpoint is waiting for a result AND isActive, it's our candidate
                if (possibleCp && possibleCp.awaitingResult) {
                    console.log(`[Remigrar] 🎯 Found orphaned active checkpoint: ${key} (Instance ${possibleCp.instanceId})`);

                    // BIND SESSION immediately so subsequent calls work
                    Session.setId(possibleCp.instanceId);
                    checkpoint = possibleCp;
                    break;
                }
            }
        }
    }

    console.log('[Remigrar] Checkpoint (final):', checkpoint ? {
        awaitingResult: checkpoint.awaitingResult,
        isActive: checkpoint.isActive,
        currentStep: checkpoint.currentStep,
        currentCaseNumber: checkpoint.currentCaseNumber,
        instanceId: checkpoint.instanceId
    } : 'none');

    // Determine if we have pending automation BEFORE creating HUD
    // This prevents the resume banner from showing when we should auto-continue
    const hasPendingAutomation = checkpoint && (checkpoint.awaitingResult || checkpoint.isActive);
    if (hasPendingAutomation) {
        window._remigrarPendingAutomation = true;
    }

    // Only proceed on remigrar page OR if we are expecting a result (which might be on a diff URL)
    // Check session ID as well - if we have an active session, we should always show HUD to allow control
    const activeSession = Session.getId();
    const shouldShowHUD = isRemigrarPage() || (checkpoint && (checkpoint.awaitingResult || checkpoint.isActive)) || !!activeSession;

    const isResultPageFullCheck = window.location.search.includes('remigrar_processo_modulo');

    if (shouldShowHUD) {
        console.log('[Remigrar] Initializing HUD (Page match:', isRemigrarPage(), 'Checkpoint:', !!checkpoint, ')');
        // Create HUD first - this connects callback handlers
        const hudControls = createHUD();
        console.log('[eProc Remigrar v2.0] HUD initialized');

        // Now handle pending automation (after HUD callbacks are connected)
        if (checkpoint) {
            // FIX: If we are physically on a result page, we MUST process the result, 
            // even if the checkpoint says awaitingResult=false (which can happen if save failed)
            const forceResultProcessing = isResultPageFullCheck && checkpoint.isActive;

            if (checkpoint.awaitingResult || forceResultProcessing) {
                // We just came back from a submission - handle result immediately
                console.log('[Remigrar] Processing result for:', checkpoint.currentCaseNumber);
                hudControls.setRunningState(true);
                Automation.isRunning = true; // CRITICAL FIX: execution cannot proceed without this

                // If we forced processing, ensure 'awaitingResult' matches reality for logic downstream
                if (forceResultProcessing && !checkpoint.awaitingResult) {
                    checkpoint.awaitingResult = true;
                    Storage.saveCheckpoint(checkpoint);
                }

                hudControls.updateStatus(`🔄 Processando resultado: ${checkpoint.currentCaseNumber} (${checkpoint.currentStep?.toUpperCase()})`);
                setTimeout(() => {
                    Automation.handleResult();
                }, 500);
            } else if (checkpoint.isActive && !checkpoint.awaitingResult) {
                // We're continuing automation after handling a result
                console.log('[Remigrar] Continuing automation, step:', checkpoint.currentStep, 'case:', checkpoint.currentCaseNumber);
                hudControls.setRunningState(true);
                Automation.isRunning = true; // CRITICAL FIX
                hudControls.updateStatus(`🔄 Continuando: ${checkpoint.currentCaseNumber || '...'} (${checkpoint.currentStep?.toUpperCase()})`);

                // Update progress display immediately
                const total = checkpoint.sliceEnd - checkpoint.sliceStart;
                const current = checkpoint.currentIndex - checkpoint.sliceStart;
                const completed = (checkpoint.completedResults || []).length;
                hudControls.updateProgress({
                    current: current,
                    total: total,
                    percent: Math.round((current / total) * 100),
                    currentCase: checkpoint.currentCaseNumber || '...',
                    step: checkpoint.currentStep?.toUpperCase() || 'N/A',
                    eta: '-',
                    completed: completed
                });

                setTimeout(() => {
                    Automation.currentCheckpoint = checkpoint;
                    Automation.isRunning = true;
                    Automation.processNext();
                }, 300);
            }
            // Otherwise, checkpoint exists but isActive is false (paused/stopped)
            // The HUD will show the resume banner
        }
    }
})();
