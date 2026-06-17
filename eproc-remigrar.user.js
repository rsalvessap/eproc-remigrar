// ==UserScript==
// @name         eProc Remigrar Automation
// @namespace    https://github.com/rsalvessap/eproc-remigrar
// @version      2.9
// @description  Robust bulk automation for "Remigrar Processo por Módulo" - handles 195k+ entries
// @author       rsalvessap
// @updateURL    https://raw.githubusercontent.com/rsalvessap/eproc-remigrar/master/eproc-remigrar.user.js
// @downloadURL  https://raw.githubusercontent.com/rsalvessap/eproc-remigrar/master/eproc-remigrar.user.js
// @include      *://eproc*.tjsp.jus.br/eproc/controlador.php*
// @include      *://*-1g-*.tjsp.jus.br/eproc/controlador.php*
// @include      *://*-2g-*.tjsp.jus.br/eproc/controlador.php*
// @include      *://sso-*.tjsc.jus.br/eproc/controlador.php*
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
    const DEBUG = false;
    const log  = (...a) => DEBUG && console.log('[Remigrar]', ...a);
    const warn = (...a) => console.warn('[Remigrar]', ...a);
    const err  = (...a) => console.error('[Remigrar]', ...a);

    const CONFIG = {
        CHECKPOINT_KEY:     'eproc_remigrar_checkpoint',
        SETTINGS_KEY:       'eproc_remigrar_settings',
        RESULTS_KEY:        'eproc_remigrar_results',
        RESULTS_BUFFER_SIZE: 100,
        SUBMIT_DELAY_MS:    300,
        RESULT_TIMEOUT_MS:  120000,
        RATE_LIMIT_DELAY_MS: 30000,
        get REMIGRAR_URL() {
            return `${window.location.origin}/eproc/controlador.php?acao=remigrar_processo`;
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE DETECTION
    // ═══════════════════════════════════════════════════════════════════════════
    function isRemigrarPage() {
        return new URLSearchParams(window.location.search).get('acao') === 'remigrar_processo';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════
    function hashString(str) {
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
        if (ms < 60000)   return `${Math.round(ms / 1000)}s`;
        if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
        const h = Math.floor(ms / 3600000);
        const m = Math.round((ms % 3600000) / 60000);
        return `${h}h ${m}min`;
    }

    function formatDateTime(timestamp) {
        return new Date(timestamp).toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }

    function downloadFile(content, filename, mimeType = 'text/csv;charset=utf-8') {
        const BOM  = '\uFEFF';
        const blob = new Blob([BOM + content], { type: mimeType });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function exportResults(results, instanceId = 1) {
        if (!results || results.length === 0) { log('No results to export'); return 0; }
        const headers = 'caso,timestamp,cas_status,cas_msg,zip_status,zip_msg,vid_status,vid_msg,resumo';
        const escape  = (s) => `"${(s || '').replace(/"/g, '""')}"`;
        const rows    = results.map(e => [
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
        const csv      = headers + '\n' + rows.join('\n');
        const filename = `remigrar_${new Date().toISOString().slice(0,10)}_inst${instanceId}_${results.length}casos.csv`;
        downloadFile(csv, filename);
        log(`✅ Exported ${results.length} results`);
        return results.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SESSION MANAGER
    // ═══════════════════════════════════════════════════════════════════════════
    const Session = {
        getId()     { return sessionStorage.getItem('remigrar_instance_id'); },
        setId(id)   { sessionStorage.setItem('remigrar_instance_id', id); },
        clear()     { sessionStorage.removeItem('remigrar_instance_id'); }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // STORAGE MODULE
    // ═══════════════════════════════════════════════════════════════════════════
    const Storage = {
        _getKey(baseKey, instanceId = null) {
            const id = instanceId || Session.getId();
            return id ? `${baseKey}_inst_${id}` : baseKey;
        },
        debugKeys() {
            if (!DEBUG) return;
            try {
                const keys = GM_listValues();
                log('🛠️ STORAGE INSPECTOR: Found', keys.length, 'keys');
                keys.forEach(k => log(` - ${k} (${GM_getValue(k)?.length || 0} bytes)`));
            } catch (e) { err('Storage inspect failed:', e); }
        },
        loadCheckpoint(instanceId = null) {
            try {
                const key = this._getKey(CONFIG.CHECKPOINT_KEY, instanceId);
                log(`Loading checkpoint from: ${key}`);
                return JSON.parse(GM_getValue(key, 'null'));
            } catch (e) { err('Failed to load checkpoint:', e); return null; }
        },
        saveCheckpoint(checkpoint) {
            checkpoint.lastCheckpoint = Date.now();
            const key = this._getKey(CONFIG.CHECKPOINT_KEY, checkpoint.instanceId);
            GM_setValue(key, JSON.stringify(checkpoint));
        },
        clearCheckpoint(instanceId = null) {
            GM_deleteValue(this._getKey(CONFIG.CHECKPOINT_KEY, instanceId));
        },
        loadSettings() {
            try { return JSON.parse(GM_getValue(CONFIG.SETTINGS_KEY, '{}')); }
            catch (e) { return {}; }
        },
        saveSettings(settings) { GM_setValue(CONFIG.SETTINGS_KEY, JSON.stringify(settings)); }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // RESULT CLASSIFIER
    // ═══════════════════════════════════════════════════════════════════════════
    const ResultType = {
        SUCCESS:      'success',
        INFO:         'info',
        ERROR:        'error',
        EMPTY:        'empty',
        RATE_LIMITED: 'rate_limited',
        SILENT:       'silent'
    };

    function waitForResult(timeout = 120000) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const immediate = classifyResponse();
            if (immediate.type !== ResultType.EMPTY) { resolve(immediate); return; }
            const checkInterval = setInterval(() => {
                const result = classifyResponse();
                if (result.type !== ResultType.EMPTY) { clearInterval(checkInterval); resolve(result); return; }
                if (Date.now() - startTime > timeout) { clearInterval(checkInterval); resolve({ type: ResultType.EMPTY, message: 'Timeout aguardando resposta' }); }
            }, 200);
        });
    }

    function classifyResponse() {
        const mainContent = document.querySelector('.infraAreaTelaD, #divInfraAreaTelaD, main, .conteudo') || document.body;
        const successCards = mainContent.querySelectorAll('.msg-SUCESSO, .msgSucesso, [class*="sucesso"]:not(.remigrar-hud)');
        for (const card of successCards) {
            if (card.closest('.remigrar-hud')) continue;
            const items = card.querySelectorAll('li, .msg-text, p');
            return { type: ResultType.SUCCESS, message: `${items.length || 1} documento(s) remigrado(s)` };
        }
        const infoCards = mainContent.querySelectorAll('.msg-INFO, .msgInfo');
        for (const card of infoCards) {
            if (card.closest('.remigrar-hud')) continue;
            const items = card.querySelectorAll('li, .msg-text, p');
            return { type: ResultType.INFO, message: `${items.length || 1} documento(s) já OK` };
        }
        const errorDiv = mainContent.querySelector('.infraExcecao, .msg-ERRO, .msgErro');
        if (errorDiv) return { type: ResultType.ERROR, message: errorDiv.textContent.trim().substring(0, 100) };
        const bodyText = mainContent.textContent || '';
        if (bodyText.includes('muitas requisições') || bodyText.includes('too many')) return { type: ResultType.RATE_LIMITED, message: 'Rate limited' };
        if (document.getElementById('txtNumProcesso')) return { type: ResultType.SILENT, message: 'Página carregada (sem mensagem da operação)' };
        return { type: ResultType.EMPTY, message: 'Aguardando resultado...' };
    }

    function summarizeResults(casResult, zipResult, videosResult) {
        const results = [casResult, zipResult, videosResult];
        if (results.some(r => r && r.type === ResultType.RATE_LIMITED)) return 'rate_limited';
        if (results.some(r => r && r.type === ResultType.ERROR))        return 'error';
        if (results.some(r => r && r.type === ResultType.SUCCESS))      return 'success';
        const nonInfoOrSilent = results.filter(r => r && r.type !== ResultType.INFO && r.type !== ResultType.SILENT);
        if (nonInfoOrSilent.length === 0) return 'info';
        return 'empty';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FILE PROCESSOR
    // ═══════════════════════════════════════════════════════════════════════════
    const FileProcessor = {
        _fileCases:   [], _manualCases: [],
        _fileHash:    null, _manualHash: null, _fileName: null,
        activeMode:   'file',
        get allCases()  { return this.activeMode === 'manual' ? this._manualCases : this._fileCases; },
        get fileHash()  { return this.activeMode === 'manual' ? this._manualHash  : this._fileHash; },
        get fileName()  { return this.activeMode === 'manual' ? 'Entrada Manual'  : this._fileName; },
        parseFile(content) {
            return content.split(/[\n\r]+/).map(l => l.trim().replace(/[^\d.-]/g, '')).filter(l => l.length >= 20);
        },
        loadFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const content = e.target.result;
                    this._fileCases = this.parseFile(content);
                    this._fileHash  = hashString(content);
                    this._fileName  = file.name;
                    resolve({ totalCases: this._fileCases.length, fileName: file.name, fileHash: this._fileHash });
                };
                reader.onerror = reject;
                reader.readAsText(file);
            });
        },
        loadText(text) {
            this._manualCases = this.parseFile(text);
            this._manualHash  = hashString(text);
            return { totalCases: this._manualCases.length, fileName: 'Entrada Manual', fileHash: this._manualHash };
        },
        getSlice(instanceId, totalInstances) {
            const total     = this.allCases.length;
            const sliceSize = Math.ceil(total / totalInstances);
            const start     = (instanceId - 1) * sliceSize;
            const end       = Math.min(start + sliceSize, total);
            return { start, end, count: end - start };
        },
        getCase(absoluteIndex) { return this.allCases[absoluteIndex] || null; }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // RESULTS BUFFER
    // ═══════════════════════════════════════════════════════════════════════════
    const ResultsBuffer = {
        buffer: [], chunkNumber: 1, totalExported: 0, instanceId: 1,
        _load(instanceId = null) {
            try {
                const key    = Storage._getKey(CONFIG.RESULTS_KEY, instanceId);
                const parsed = JSON.parse(GM_getValue(key, 'null'));
                if (parsed) { this.buffer = parsed.buffer || []; this.chunkNumber = parsed.chunkNumber || 1; this.totalExported = parsed.totalExported || 0; this.instanceId = parsed.instanceId || 1; }
            } catch (e) { err('Failed to load results buffer:', e); }
        },
        _save() {
            const key = Storage._getKey(CONFIG.RESULTS_KEY, this.instanceId);
            GM_setValue(key, JSON.stringify({ buffer: this.buffer, chunkNumber: this.chunkNumber, totalExported: this.totalExported, instanceId: this.instanceId }));
        },
        init(instanceId, startChunk = 1, forceReset = false) {
            this.instanceId = instanceId;
            if (forceReset) { this.chunkNumber = startChunk; this.buffer = []; this.totalExported = 0; this._save(); }
            else { this._load(instanceId); if (startChunk > this.chunkNumber) this.chunkNumber = startChunk; }
        },
        add(entry) {
            this.buffer.push(entry); this._save();
            if (this.buffer.length >= CONFIG.RESULTS_BUFFER_SIZE) this.flush();
        },
        flush() {
            if (!this.buffer.length) return 0;
            const headers = 'caso,timestamp,cas_status,cas_msg,zip_status,zip_msg,vid_status,vid_msg,resumo';
            const rows    = this.buffer.map(e => {
                const esc = (s) => `"${(s || '').replace(/"/g, '""')}"`;
                return [e.caseNumber, formatDateTime(e.timestamp), e.casResult.type, esc(e.casResult.message), e.zipResult.type, esc(e.zipResult.message), e.videosResult.type, esc(e.videosResult.message), e.summary].join(',');
            });
            const filename = `remigrar_results_inst${this.instanceId}_chunk${String(this.chunkNumber).padStart(3,'0')}.csv`;
            downloadFile(headers + '\n' + rows.join('\n'), filename);
            const exportedCount = this.buffer.length;
            this.totalExported += exportedCount; this.chunkNumber++; this.buffer = []; this._save();
            return exportedCount;
        },
        clear() { this.buffer = []; this.chunkNumber = 1; this.totalExported = 0; GM_deleteValue(Storage._getKey(CONFIG.RESULTS_KEY, this.instanceId)); },
        getStats() { return { buffered: this.buffer.length, exported: this.totalExported, chunks: this.chunkNumber - 1 }; }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTOMATION ENGINE
    // ═══════════════════════════════════════════════════════════════════════════
    const Automation = {
        isRunning: false, isPaused: false, currentCheckpoint: null,
        onProgressUpdate: null, onStatusUpdate: null, retryCount: 0,

        async start(instanceId, totalInstances) {
            Session.setId(instanceId);
            const slice = FileProcessor.getSlice(instanceId, totalInstances);
            const caseQueue = [];
            for (let i = slice.start; i < slice.end; i++) caseQueue.push(FileProcessor.getCase(i));
            this.currentCheckpoint = {
                inputFileName: FileProcessor.fileName, inputFileHash: FileProcessor.fileHash,
                instanceId, totalInstances, sliceStart: slice.start, sliceEnd: slice.end,
                currentIndex: slice.start, currentStep: 'cas', chunkNumber: 1,
                startedAt: Date.now(), processedCount: 0, results: {}, caseQueue, isActive: true
            };
            Storage.saveCheckpoint(this.currentCheckpoint);
            this.isRunning = true; this.isPaused = false;
            this.processNext();
        },

        resume(checkpoint) {
            if (checkpoint.instanceId) Session.setId(checkpoint.instanceId);
            this.currentCheckpoint = checkpoint; this.isRunning = true; this.isPaused = false;
            log('Resuming from checkpoint:', checkpoint);
        },

        pause() {
            this.isPaused = true;
            if (this.currentCheckpoint) this.currentCheckpoint.isActive = false;
            Storage.saveCheckpoint(this.currentCheckpoint);
            this.updateStatus('⏸️ Pausado');
        },

        unpause()        { this.isPaused = false; this.processNext(); },
        updateStatus(m)  { if (this.onStatusUpdate)   this.onStatusUpdate(m); },

        stop() {
            this.isRunning = false; this.isPaused = false;
            const cp = this.currentCheckpoint || Storage.loadCheckpoint();
            if (cp && cp.completedResults && cp.completedResults.length > 0) {
                exportResults(cp.completedResults, cp.instanceId);
                this.updateStatus(`⏹️ Parado. ${cp.completedResults.length} casos exportados.`);
            } else {
                this.updateStatus('⏹️ Parado');
            }
            Storage.clearCheckpoint(); Session.clear();
        },

        updateProgress() {
            if (!this.onProgressUpdate) return;
            const cp      = this.currentCheckpoint;
            const total   = cp.sliceEnd - cp.sliceStart;
            const current = cp.currentIndex - cp.sliceStart;
            const progress = current / total;
            const elapsed  = Date.now() - cp.startedAt;
            const eta      = progress > 0 ? (elapsed / progress) - elapsed : 0;
            const queueIndex   = cp.currentIndex - cp.sliceStart;
            const caseNumber   = cp.currentCaseNumber || (cp.caseQueue && cp.caseQueue[queueIndex]) || `#${cp.currentIndex}`;
            const completedCount = (cp.completedResults || []).length;
            this.onProgressUpdate({ current, total, percent: Math.round(progress * 100), currentCase: caseNumber, step: cp.currentStep.toUpperCase(), eta: formatTime(eta), completed: completedCount });
            Storage.saveCheckpoint(cp);
        },

        async processNext() {
            log(`processNext called. Running: ${this.isRunning}, Paused: ${this.isPaused}`);
            if (!this.isRunning || this.isPaused) { log('processNext aborted'); return; }

            const cp = this.currentCheckpoint;
            if (cp.currentIndex >= cp.sliceEnd) {
                const results = cp.completedResults || [];
                if (results.length > 0) exportResults(results, cp.instanceId);
                Storage.clearCheckpoint(); Session.clear();
                this.isRunning = false;
                this.updateStatus(`✅ Concluído! ${results.length} casos processados e exportados.`);
                alert(`Processamento concluído!\n${results.length} casos exportados para CSV.`);
                return;
            }

            const queueIndex = cp.currentIndex - cp.sliceStart;
            let caseNumber;
            if (cp.currentStep !== 'cas' && cp.currentCaseNumber) caseNumber = cp.currentCaseNumber;
            else if (cp.caseQueue && cp.caseQueue[queueIndex])    caseNumber = cp.caseQueue[queueIndex];
            else                                                    caseNumber = FileProcessor.getCase(cp.currentIndex);

            if (!caseNumber) { err('No case number at:', cp.currentIndex); this.updateStatus('⚠️ Erro: fila não disponível'); this.isRunning = false; return; }

            let module;
            if (cp.currentStep === 'cas') module = 'documentos_cas';
            else if (cp.currentStep === 'zip') module = 'documentos_zip';
            else module = 'videos';

            const input  = document.getElementById('txtNumProcesso');
            const select = document.getElementById('selModulo');
            const button = document.querySelector('button[type="submit"].infraButton');

            if (!input || !select || !button) {
                cp.currentCaseNumber = caseNumber; cp.isActive = true;
                Storage.saveCheckpoint(cp);
                window.location.href = CONFIG.REMIGRAR_URL; return;
            }

            input.value  = caseNumber; select.value = module;
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));

            this.updateProgress();
            this.updateStatus(`🔄 ${caseNumber} (${cp.currentStep.toUpperCase()})`);

            cp.currentCaseNumber = caseNumber; cp.awaitingResult = true;
            Storage.saveCheckpoint(cp);

            setTimeout(() => {
                const watchdogId = setTimeout(() => {
                    warn('⚠️ Submission watchdog triggered');
                    const currentCp = Storage.loadCheckpoint();
                    if (currentCp && currentCp.awaitingResult) {
                        currentCp.awaitingResult = false; Storage.saveCheckpoint(currentCp);
                        window.location.href = CONFIG.REMIGRAR_URL;
                    }
                }, 10000);
                try { button.click(); } catch (e) { err('Submit click failed:', e); }
            }, CONFIG.SUBMIT_DELAY_MS);
        },

        async handleResult() {
            try {
                const cp = Storage.loadCheckpoint();
                if (!cp || !cp.awaitingResult) return false;

                const caseNumber = cp.currentCaseNumber;
                log(`Waiting for result: ${caseNumber} (${cp.currentStep})`);
                this.updateStatus?.(`⏳ ${caseNumber} (${cp.currentStep.toUpperCase()})`);

                const result = await waitForResult(CONFIG.RESULT_TIMEOUT_MS);
                log('Got result:', result);

                if (result.type === ResultType.RATE_LIMITED) {
                    warn('Rate limited, waiting...');
                    this.updateStatus?.(`⚠️ Rate limited - aguardando ${CONFIG.RATE_LIMIT_DELAY_MS / 1000}s`);
                    setTimeout(() => { cp.awaitingResult = false; Storage.saveCheckpoint(cp); this.currentCheckpoint = cp; this.processNext(); }, CONFIG.RATE_LIMIT_DELAY_MS);
                    return true;
                }

                if (!cp.results) cp.results = {};
                if (cp.currentStep === 'cas')       { cp.results.casResult = result; cp.currentStep = 'zip'; }
                else if (cp.currentStep === 'zip')  { cp.results.zipResult = result; cp.currentStep = 'videos'; }
                else {
                    cp.results.videosResult = result;
                    const entry = { caseNumber, timestamp: Date.now(), casResult: cp.results.casResult, zipResult: cp.results.zipResult, videosResult: cp.results.videosResult, summary: summarizeResults(cp.results.casResult, cp.results.zipResult, cp.results.videosResult) };
                    if (!cp.completedResults) cp.completedResults = [];
                    cp.completedResults.push(entry);
                    cp.currentIndex++; cp.currentStep = 'cas'; cp.results = {};
                }

                cp.awaitingResult = false; Storage.saveCheckpoint(cp); this.currentCheckpoint = cp;

                if (!this.isRunning) { warn('handleResult: forcing resume'); this.isRunning = true; }
                this.processNext();
                return true;
            } catch (error) {
                err('CRITICAL ERROR in handleResult:', error);
                this.updateStatus('❌ Erro no processamento (ver console)');
                return false;
            }
        },

        getProgress() {
            const cp = this.currentCheckpoint || Storage.loadCheckpoint();
            if (!cp) return null;
            const total    = cp.sliceEnd - cp.sliceStart;
            const current  = cp.currentIndex - cp.sliceStart;
            const queueIdx = cp.currentIndex - cp.sliceStart;
            return {
                current, total, percent: Math.round((current / total) * 100),
                currentCase: cp.currentCaseNumber || (cp.caseQueue && cp.caseQueue[queueIdx]) || `#${cp.currentIndex}`,
                step: cp.currentStep ? cp.currentStep.toUpperCase() : 'N/A',
                instanceId: cp.instanceId, isRunning: this.isRunning, isPaused: this.isPaused,
                completed: (cp.completedResults || []).length
            };
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // HUD COMPONENT — usa Bootstrap nativo do eProc
    // ═══════════════════════════════════════════════════════════════════════════
    function injetarEstilosHUD() {
        if (document.getElementById('remigrar-hud-styles')) return;
        const s = document.createElement('style');
        s.id = 'remigrar-hud-styles';
        s.textContent = `
            #remigrar-hud-wrapper { margin-bottom: 16px; }
            #remigrar-hud-wrapper .remigrar-header {
                background: #0887b2;
                color: white;
                padding: 8px 14px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-weight: bold;
                font-size: 13px;
                border-radius: 4px 4px 0 0;
            }
            #remigrar-hud-body.collapsed { display: none !important; }
            #remigrar-hud-wrapper .remigrar-section-title {
                font-size: 11px;
                font-weight: bold;
                text-transform: uppercase;
                color: #0887b2;
                border-bottom: 1px solid #dee2e6;
                padding-bottom: 4px;
                margin-bottom: 8px;
                margin-top: 10px;
            }
            #remigrar-hud-wrapper .remigrar-section-title:first-child { margin-top: 0; }
            #remigrar-hud-wrapper .mode-hidden { display: none !important; }
            #remigrar-hud-wrapper #remigrar-controls .btn,
            #remigrar-hud-wrapper #remigrar-mode-toggle .btn { flex: 1; }
            #remigrar-hud-wrapper .processing-indicator { animation: remigrar-pulse 1.5s infinite; }
            @keyframes remigrar-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function createHUD() {
        injetarEstilosHUD();

        const wrapper = document.createElement('div');
        wrapper.id = 'remigrar-hud-wrapper';
        wrapper.innerHTML = `
            <div class="card" style="border-color:#CBD6E5">
                <div class="remigrar-header">
                    <span>Remigrar por Módulo</span>
                    <button id="remigrar-hud-toggle" class="btn btn-sm" style="color:white;border:1px solid rgba(255,255,255,0.5);padding:1px 7px;line-height:1.4">−</button>
                </div>
                <div class="card-body p-2" id="remigrar-hud-body">

                    <!-- Banner de retomada -->
                    <div id="remigrar-resume-banner" class="alert alert-warning p-2 mb-2 text-center" style="display:none"></div>

                    <!-- ── LINHA 1: Toggle de modo + Controles ── -->
                    <div class="row mb-2">
                        <div class="col-6">
                            <div class="btn-group btn-group-sm w-100" id="remigrar-mode-toggle">
                                <button id="remigrar-mode-casual" class="btn btn-secondary">📝 Lista manual</button>
                                <button id="remigrar-mode-bulk"   class="btn btn-outline-secondary">📁 Arquivo</button>
                            </div>
                        </div>
                        <div class="col-6">
                            <div class="btn-group btn-group-sm w-100" id="remigrar-controls">
                                <button id="remigrar-start" class="btn btn-primary"  disabled>▶ Iniciar</button>
                                <button id="remigrar-pause" class="btn btn-warning"  disabled>⏸ Pausar</button>
                                <button id="remigrar-stop"  class="btn btn-danger"   disabled>⏹ Parar</button>
                            </div>
                        </div>
                    </div>

                    <!-- ── LINHA 2: Entrada (largura total) ── -->

                    <!-- MODO MANUAL -->
                    <div id="remigrar-casual-container">
                        <div class="remigrar-section-title">
                            Números dos Processos
                            <span id="remigrar-manual-count" class="badge badge-info ml-1">0</span>
                        </div>
                        <textarea id="remigrar-manual-input"
                            class="form-control form-control-sm mb-1"
                            style="font-family:Consolas,monospace;resize:none;min-height:80px;overflow:hidden;width:100%"
                            placeholder="Cole os números dos processos aqui (um por linha)..."></textarea>
                        <div id="remigrar-manual-status" class="small text-muted">Cole a lista para iniciar</div>
                    </div>

                    <!-- MODO ARQUIVO -->
                    <div id="remigrar-bulk-container" class="mode-hidden">
                        <div class="row">
                            <div class="col-6">
                                <div class="remigrar-section-title">Arquivo de Entrada</div>
                                <div id="remigrar-file-info" class="alert alert-secondary p-2 mb-2 small">Nenhum arquivo selecionado</div>
                                <input type="file" id="remigrar-file-input" accept=".txt,.csv" style="display:none">
                                <label for="remigrar-file-input" class="btn btn-sm btn-primary btn-block mb-2">📂 Selecionar Arquivo</label>
                            </div>
                            <div class="col-6">
                                <div class="remigrar-section-title">Multi-Instância</div>
                                <div class="form-row">
                                    <div class="form-group col mb-1">
                                        <label class="small mb-0">Esta Instância</label>
                                        <input type="number" id="remigrar-instance-id" class="form-control form-control-sm text-center" min="1" value="1">
                                    </div>
                                    <div class="form-group col mb-1">
                                        <label class="small mb-0">Total de Instâncias</label>
                                        <input type="number" id="remigrar-total-instances" class="form-control form-control-sm text-center" min="1" value="1">
                                    </div>
                                </div>
                                <div id="remigrar-slice-info" class="small text-muted text-center">Carregue um arquivo para ver a distribuição</div>
                            </div>
                        </div>
                    </div>

                    <!-- ── LINHA 3: Progresso + Status + Resultados ── -->
                    <div class="remigrar-section-title mt-2">Progresso</div>
                    <div class="progress mb-2" style="height:18px">
                        <div id="remigrar-progress-fill" class="progress-bar bg-success" role="progressbar"
                            style="width:0%;font-size:11px;font-weight:bold;transition:width 0.3s ease">0%</div>
                    </div>
                    <div class="row">
                        <div class="col-8">
                            <div id="remigrar-status" class="small" style="line-height:1.8">
                                <div class="d-flex justify-content-between"><span class="text-muted">Status:</span>     <span class="font-weight-bold" id="status-state">Aguardando...</span></div>
                                <div class="d-flex justify-content-between"><span class="text-muted">Caso Atual:</span> <span class="font-weight-bold" id="status-case">-</span></div>
                                <div class="d-flex justify-content-between"><span class="text-muted">Etapa:</span>      <span class="font-weight-bold" id="status-step">-</span></div>
                                <div class="d-flex justify-content-between"><span class="text-muted">ETA:</span>        <span class="font-weight-bold" id="status-eta">-</span></div>
                                <div class="d-flex justify-content-between"><span class="text-muted">Velocidade:</span> <span class="font-weight-bold" id="status-rate">-</span></div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="remigrar-section-title" style="margin-top:0">Resultados</div>
                            <div class="d-flex justify-content-between align-items-center small mb-2">
                                <span class="text-muted">Completos:</span>
                                <span class="font-weight-bold" id="completed-count">0</span>
                            </div>
                            <button id="remigrar-export-now" class="btn btn-sm btn-outline-secondary btn-block">📥 Exportar</button>
                        </div>
                    </div>

                </div>
            </div>
        `;

        const container = document.querySelector('#divInfraAreaTelaD')
            || document.querySelector('#divInfraConteudoForm')
            || document.querySelector('#divInfraConteudo')
            || document.querySelector('.infraAreaTelaD')
            || document.body;
        container.insertBefore(wrapper, container.firstChild);

        // ── Elementos ──
        const elements = {
            toggle:          wrapper.querySelector('#remigrar-hud-toggle'),
            modeCasualBtn:   wrapper.querySelector('#remigrar-mode-casual'),
            modeBulkBtn:     wrapper.querySelector('#remigrar-mode-bulk'),
            body:            wrapper.querySelector('#remigrar-hud-body'),
            casualContainer: wrapper.querySelector('#remigrar-casual-container'),
            bulkContainer:   wrapper.querySelector('#remigrar-bulk-container'),
            manualInput:     wrapper.querySelector('#remigrar-manual-input'),
            manualCount:     wrapper.querySelector('#remigrar-manual-count'),
            manualStatus:    wrapper.querySelector('#remigrar-manual-status'),
            fileInput:       wrapper.querySelector('#remigrar-file-input'),
            fileInfo:        wrapper.querySelector('#remigrar-file-info'),
            instanceId:      wrapper.querySelector('#remigrar-instance-id'),
            totalInstances:  wrapper.querySelector('#remigrar-total-instances'),
            sliceInfo:       wrapper.querySelector('#remigrar-slice-info'),
            startBtn:        wrapper.querySelector('#remigrar-start'),
            pauseBtn:        wrapper.querySelector('#remigrar-pause'),
            stopBtn:         wrapper.querySelector('#remigrar-stop'),
            progressFill:    wrapper.querySelector('#remigrar-progress-fill'),
            statusState:     wrapper.querySelector('#status-state'),
            statusCase:      wrapper.querySelector('#status-case'),
            statusStep:      wrapper.querySelector('#status-step'),
            statusEta:       wrapper.querySelector('#status-eta'),
            statusRate:      wrapper.querySelector('#status-rate'),
            completedCount:  wrapper.querySelector('#completed-count'),
            exportBtn:       wrapper.querySelector('#remigrar-export-now'),
            resumeBanner:    wrapper.querySelector('#remigrar-resume-banner')
        };

        // ── Estado ──
        let fileLoaded = false;

        function updateResumeStatus() {
            const targetId = elements.instanceId.value;
            const cp = Storage.loadCheckpoint(targetId);
            log(`Checking resume for ID ${targetId}:`, cp ? 'Found' : 'Null');
            elements.completedCount.textContent = (cp && cp.completedResults) ? cp.completedResults.length : '0';
            if (cp && !window._remigrarPendingAutomation) showResumeBanner(cp);
            else elements.resumeBanner.style.display = 'none';
        }

        const settings = Storage.loadSettings();
        const activeSessionId = Session.getId();
        if (activeSessionId) {
            elements.instanceId.value    = activeSessionId;
            elements.instanceId.disabled = true;
            const cp = Storage.loadCheckpoint(activeSessionId);
            if (cp && cp.totalInstances) { elements.totalInstances.value = cp.totalInstances; elements.totalInstances.disabled = true; }
            else if (settings.totalInstances) elements.totalInstances.value = settings.totalInstances;
        } else {
            if (settings.instanceId)      elements.instanceId.value      = settings.instanceId;
            if (settings.totalInstances)  elements.totalInstances.value  = settings.totalInstances;
        }
        updateResumeStatus();
        elements.instanceId.addEventListener('input', updateResumeStatus);

        // ── Funções de UI ──
        function updateSliceInfo() {
            if (!fileLoaded) { elements.sliceInfo.textContent = 'Carregue um arquivo para ver a distribuição'; return; }
            const instanceId      = parseInt(elements.instanceId.value) || 1;
            const totalInstances  = parseInt(elements.totalInstances.value) || 1;
            const slice = FileProcessor.getSlice(instanceId, totalInstances);
            elements.sliceInfo.innerHTML = `Sua faixa: <strong>${slice.start.toLocaleString()}</strong> → <strong>${(slice.end-1).toLocaleString()}</strong> (<strong>${slice.count.toLocaleString()}</strong> casos)`;
            Storage.saveSettings({ instanceId, totalInstances });
        }

        function updateProgress(progress) {
            elements.progressFill.style.width   = `${progress.percent}%`;
            elements.progressFill.textContent    = `${progress.percent}%`;
            elements.statusCase.textContent      = progress.currentCase || '-';
            elements.statusStep.textContent      = progress.step || '-';
            elements.statusEta.textContent       = progress.eta || '-';
            elements.completedCount.textContent  = progress.completed || 0;
            if (elements.statusRate) elements.statusRate.textContent = '-';
        }

        function updateStatus(message) { elements.statusState.innerHTML = message; }

        function setRunningState(isRunning, isPaused = false) {
            elements.startBtn.disabled       = isRunning;
            elements.pauseBtn.disabled       = !isRunning;
            elements.stopBtn.disabled        = !isRunning;
            elements.fileInput.disabled      = isRunning;
            elements.instanceId.disabled     = isRunning;
            elements.totalInstances.disabled = isRunning;

            if (isPaused) {
                elements.pauseBtn.textContent = '▶ Retomar';
                elements.pauseBtn.classList.remove('btn-warning'); elements.pauseBtn.classList.add('btn-primary');
            } else {
                elements.pauseBtn.textContent = '⏸ Pausar';
                elements.pauseBtn.classList.remove('btn-primary'); elements.pauseBtn.classList.add('btn-warning');
            }
        }

        function showResumeBanner(checkpoint) {
            const elapsed  = formatTime(Date.now() - checkpoint.startedAt);
            const progress = Math.round(((checkpoint.currentIndex - checkpoint.sliceStart) / (checkpoint.sliceEnd - checkpoint.sliceStart)) * 100);
            elements.resumeBanner.style.display = 'block';
            elements.resumeBanner.innerHTML = `
                <strong class="d-block mb-1" style="color:#856404">⚠️ Sessão Anterior Encontrada</strong>
                <small class="d-block text-muted mb-2">
                    Arquivo: ${checkpoint.inputFileName}<br>
                    Instância ${checkpoint.instanceId}/${checkpoint.totalInstances} |
                    Progresso: ${progress}% | Tempo: ${elapsed}
                </small>
                <button id="resume-yes" class="btn btn-sm btn-primary mr-2">▶ Retomar</button>
                <button id="resume-no"  class="btn btn-sm btn-secondary">🔄 Recomeçar</button>
            `;
            elements.resumeBanner.querySelector('#resume-yes').onclick = () => {
                elements.resumeBanner.style.display = 'none';
                if (checkpoint.caseQueue && checkpoint.caseQueue.length > 0) {
                    log('Resuming directly from stored queue');
                    elements.instanceId.value = checkpoint.instanceId;
                    elements.totalInstances.value = checkpoint.totalInstances;
                    updateSliceInfo();
                    elements.fileInfo.classList.remove('empty');
                    elements.fileInfo.innerHTML = `<strong>${checkpoint.inputFileName}</strong> (da sessão anterior)<br>${checkpoint.caseQueue.length.toLocaleString()} casos na fila`;
                    setRunningState(true);
                    Automation.currentCheckpoint = checkpoint;
                    Automation.isRunning = true;
                    Automation.processNext();
                } else {
                    alert(`Por favor, selecione o mesmo arquivo: ${checkpoint.inputFileName}`);
                    window.pendingResume = checkpoint;
                }
            };
            elements.resumeBanner.querySelector('#resume-no').onclick = () => {
                Storage.clearCheckpoint(); elements.resumeBanner.style.display = 'none';
            };
        }

        // ── Toggle collapse ──
        elements.toggle.addEventListener('click', () => {
            elements.body.classList.toggle('collapsed');
            elements.toggle.textContent = elements.body.classList.contains('collapsed') ? '+' : '−';
        });

        // ── Seleção de arquivo ──
        elements.fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                updateStatus('📂 Carregando arquivo...');
                const result = await FileProcessor.loadFile(file);
                elements.fileInfo.innerHTML = `<strong>${result.fileName}</strong><br>${result.totalCases.toLocaleString()} casos válidos`;
                fileLoaded = true;
                elements.startBtn.disabled = false;
                updateSliceInfo();
                if (window.pendingResume) {
                    const cp = window.pendingResume;
                    if (cp.inputFileHash === FileProcessor.fileHash) {
                        elements.instanceId.value = cp.instanceId; elements.totalInstances.value = cp.totalInstances;
                        updateSliceInfo(); Session.setId(cp.instanceId);
                        Automation.resume(cp); setRunningState(true); Automation.processNext();
                        delete window.pendingResume;
                    } else {
                        alert('⚠️ Hash do arquivo não corresponde! Iniciando nova sessão.');
                        Storage.clearCheckpoint(cp.instanceId); delete window.pendingResume;
                    }
                }
                updateStatus('✅ Arquivo carregado');
            } catch (e) { err('File load error:', e); updateStatus('❌ Erro ao carregar arquivo'); }
        });

        elements.instanceId.addEventListener('change', updateSliceInfo);
        elements.totalInstances.addEventListener('change', updateSliceInfo);

        // ── Toggle de modo ──
        let isCasualMode = true;

        function toggleMode(setCasual = null) {
            isCasualMode = setCasual !== null ? setCasual : !isCasualMode;
            FileProcessor.activeMode = isCasualMode ? 'manual' : 'file';

            if (isCasualMode) {
                elements.casualContainer.classList.remove('mode-hidden');
                elements.bulkContainer.classList.add('mode-hidden');
                elements.startBtn.disabled = FileProcessor.allCases.length === 0;
                elements.modeCasualBtn.classList.remove('btn-outline-secondary'); elements.modeCasualBtn.classList.add('btn-secondary');
                elements.modeBulkBtn.classList.remove('btn-secondary');           elements.modeBulkBtn.classList.add('btn-outline-secondary');
            } else {
                elements.casualContainer.classList.add('mode-hidden');
                elements.bulkContainer.classList.remove('mode-hidden');
                elements.startBtn.disabled = !fileLoaded;
                elements.modeBulkBtn.classList.remove('btn-outline-secondary');   elements.modeBulkBtn.classList.add('btn-secondary');
                elements.modeCasualBtn.classList.remove('btn-secondary');          elements.modeCasualBtn.classList.add('btn-outline-secondary');
            }
            Storage.saveSettings({ ...Storage.loadSettings(), isCasualMode });
        }

        elements.modeCasualBtn.addEventListener('click', () => toggleMode(true));
        elements.modeBulkBtn.addEventListener('click',   () => toggleMode(false));
        toggleMode(settings.isCasualMode !== undefined ? settings.isCasualMode : true);

        // ── Entrada manual ──
        elements.manualInput.addEventListener('input', (e) => {
            e.target.style.height = 'auto';
            e.target.style.height = e.target.scrollHeight + 'px';
            const result = FileProcessor.loadText(e.target.value);
            elements.manualCount.textContent = result.totalCases;
            if (result.totalCases > 0) {
                elements.manualStatus.textContent = `✅ ${result.totalCases} casos identificados`;
                elements.manualStatus.className   = 'small text-success';
                elements.startBtn.disabled = false;
            } else {
                elements.manualStatus.textContent = 'Aguardando entrada válida...';
                elements.manualStatus.className   = 'small text-muted';
                elements.startBtn.disabled = true;
            }
        });

        // ── Botão Iniciar ──
        elements.startBtn.addEventListener('click', () => {
            let instanceId = 1, totalInstances = 1;
            if (isCasualMode) {
                const result = FileProcessor.loadText(elements.manualInput.value);
                if (result.totalCases === 0) { alert('Nenhum caso válido encontrado!'); return; }
            } else {
                instanceId = parseInt(elements.instanceId.value) || 1;
                totalInstances = parseInt(elements.totalInstances.value) || 1;
                if (instanceId < 1 || instanceId > totalInstances) { alert('ID da instância deve estar entre 1 e o total de instâncias'); return; }
            }
            setRunningState(true);
            Automation.start(instanceId, totalInstances);
        });

        // ── Botão Pausar ──
        elements.pauseBtn.addEventListener('click', () => {
            if (Automation.isPaused) { Automation.unpause(); setRunningState(true, false); }
            else                     { Automation.pause();   setRunningState(true, true);  }
        });

        // ── Botão Parar ──
        elements.stopBtn.addEventListener('click', () => {
            if (confirm('Parar processamento? O progresso será perdido.')) { Automation.stop(); setRunningState(false); }
        });

        // ── Botão Exportar ──
        elements.exportBtn.addEventListener('click', () => {
            const cp = Storage.loadCheckpoint();
            if (!cp || !cp.completedResults || !cp.completedResults.length) { updateStatus('ℹ️ Nenhum resultado para exportar'); return; }
            updateStatus(`📥 Exportados ${exportResults(cp.completedResults, cp.instanceId)} resultados`);
        });

        // ── Conecta callbacks ──
        Automation.onProgressUpdate = updateProgress;
        Automation.onStatusUpdate   = updateStatus;

        // ── Verifica checkpoint existente ──
        const existingCheckpoint = Storage.loadCheckpoint();
        if (existingCheckpoint && !existingCheckpoint.awaitingResult && !existingCheckpoint.isActive && !window._remigrarPendingAutomation) {
            showResumeBanner(existingCheckpoint);
        }

        return { updateProgress, updateStatus, setRunningState };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    log('========== SCRIPT STARTING ==========');
    log('URL:', window.location.href);
    log('isRemigrarPage:', isRemigrarPage());
    Storage.debugKeys();

    let checkpoint = Storage.loadCheckpoint();

    const isResultPage = window.location.search.includes('remigrar_processo_modulo');
    if (isResultPage && !checkpoint) {
        warn('Result page detected but no checkpoint/session found! attempting auto-discovery...');
        const keys = GM_listValues();
        for (const key of keys) {
            if (key.startsWith(CONFIG.CHECKPOINT_KEY + '_inst_')) {
                const possibleCp = JSON.parse(GM_getValue(key));
                if (possibleCp && possibleCp.awaitingResult) {
                    log(`🎯 Found orphaned active checkpoint: ${key} (Instance ${possibleCp.instanceId})`);
                    Session.setId(possibleCp.instanceId);
                    checkpoint = possibleCp; break;
                }
            }
        }
    }

    log('Checkpoint (final):', checkpoint ? { awaitingResult: checkpoint.awaitingResult, isActive: checkpoint.isActive, currentStep: checkpoint.currentStep, currentCaseNumber: checkpoint.currentCaseNumber, instanceId: checkpoint.instanceId } : 'none');

    const hasPendingAutomation = checkpoint && (checkpoint.awaitingResult || checkpoint.isActive);
    if (hasPendingAutomation) window._remigrarPendingAutomation = true;

    const activeSession  = Session.getId();
    const shouldShowHUD  = isRemigrarPage() || (checkpoint && (checkpoint.awaitingResult || checkpoint.isActive)) || !!activeSession;
    const isResultPageFull = window.location.search.includes('remigrar_processo_modulo');

    if (shouldShowHUD) {
        log('Initializing HUD — Page:', isRemigrarPage(), 'Checkpoint:', !!checkpoint);
        const hudControls = createHUD();
        console.log('[eProc Remigrar v2.7] HUD initialized');

        if (checkpoint) {
            const forceResultProcessing = isResultPageFull && checkpoint.isActive;
            if (checkpoint.awaitingResult || forceResultProcessing) {
                log('Processing result for:', checkpoint.currentCaseNumber);
                hudControls.setRunningState(true);
                Automation.isRunning = true;
                if (forceResultProcessing && !checkpoint.awaitingResult) { checkpoint.awaitingResult = true; Storage.saveCheckpoint(checkpoint); }
                hudControls.updateStatus(`🔄 Processando resultado: ${checkpoint.currentCaseNumber} (${checkpoint.currentStep?.toUpperCase()})`);
                setTimeout(() => { Automation.handleResult(); }, 500);
            } else if (checkpoint.isActive && !checkpoint.awaitingResult) {
                log('Continuing automation, step:', checkpoint.currentStep, 'case:', checkpoint.currentCaseNumber);
                hudControls.setRunningState(true);
                Automation.isRunning = true;
                hudControls.updateStatus(`🔄 Continuando: ${checkpoint.currentCaseNumber || '...'} (${checkpoint.currentStep?.toUpperCase()})`);
                const total = checkpoint.sliceEnd - checkpoint.sliceStart;
                const current = checkpoint.currentIndex - checkpoint.sliceStart;
                hudControls.updateProgress({ current, total, percent: Math.round((current/total)*100), currentCase: checkpoint.currentCaseNumber || '...', step: checkpoint.currentStep?.toUpperCase() || 'N/A', eta: '-', completed: (checkpoint.completedResults||[]).length });
                setTimeout(() => { Automation.currentCheckpoint = checkpoint; Automation.isRunning = true; Automation.processNext(); }, 300);
            }
        }
    }
})();
