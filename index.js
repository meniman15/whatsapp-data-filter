const { Client, LocalAuth } = require('whatsapp-web.js');
const Message = require('whatsapp-web.js/src/structures/Message');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

// Override console methods to prepend timestamps to every log line
const _originalLog = console.log;
const _originalError = console.error;
const _originalWarn = console.warn;

function formatTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

console.log = (...args) => _originalLog(formatTimestamp(), ...args);
console.error = (...args) => _originalError(formatTimestamp(), ...args);
console.warn = (...args) => _originalWarn(formatTimestamp(), ...args);
const { isJobRelevant, isJobRelevantKeywords } = require('./filter');
const fs = require('fs');
const path = require('path');

const sourceChannelId = process.env.SOURCE_CHANNEL_ID;
const destinationChannelIds = (process.env.DESTINATION_CHANNEL_ID || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
const destinationChannelId = destinationChannelIds[0] || null; // fallback reference
const BROADCAST_DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '3000', 10); // default 3 seconds delay between group sends
const POLLING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const AMOUNT_OF_TIME_BEFORE = 60 * 60 * 24 * 5; // 5 days in seconds

// Path to persist processed messages
const processedFile = path.join(__dirname, 'processed_messages.json');
let processedMessages = new Set();

// Load already processed messages from disk
if (fs.existsSync(processedFile)) {
    try {
        const data = JSON.parse(fs.readFileSync(processedFile, 'utf8'));
        processedMessages = new Set(data.filter(id => id !== null && id !== undefined));
    } catch (e) {
        console.error('Error loading processed messages file:', e);
    }
}

function saveProcessedMessages() {
    try {
        fs.writeFileSync(processedFile, JSON.stringify([...processedMessages]), 'utf8');
    } catch (e) {
        console.error('Error saving processed messages file:', e);
    }
}

// Prune old processed message IDs every hour to keep Node memory lightweight
setInterval(() => {
    if (processedMessages.size > 3000) {
        console.log('🧹 Pruning old processed message IDs from memory...');
        const arr = Array.from(processedMessages);
        processedMessages = new Set(arr.slice(-1500));
        saveProcessedMessages();
    }
}, 60 * 60 * 1000);

// We only process messages received in the last 5 days
let startTime = Math.floor(Date.now() / 1000) - AMOUNT_OF_TIME_BEFORE;

const client = new Client({
    authStrategy: new LocalAuth(),
    authTimeoutMs: 600000, // 10 minutes — generous for slow Oracle VMs, but still catches genuine freezes
    takeoverOnConflict: true,
    takeoverTimeoutMs: 120000,
    puppeteer: {
        protocolTimeout: 300000, // 5 minutes CDP protocol timeout for slow VMs
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--disable-extensions',
            '--renderer-process-limit=2',
            '--js-flags=--max-old-space-size=400',
            '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        ]
    }
});

client.on('qr', (qr) => {
    if (startupSpinner) {
        clearInterval(startupSpinner);
        startupSpinner = null;
    }
    console.log('--- QR CODE ---');
    console.log('Scan this QR code with your WhatsApp app to log in:');
    qrcode.generate(qr, { small: true });
});

let pollIntervalId = null;

// Startup progress logger — prints every 15s while browser/WhatsApp initializes
let startupSpinner = null;
let startupSeconds = 0;
console.log('🚀 Launching browser and connecting to WhatsApp...');
startupSpinner = setInterval(async () => {
    startupSeconds += 5;
    if (startupSeconds % 15 === 0) {
        console.log(`   ⏳ Still starting up... ${startupSeconds}s elapsed`);
    }
    // Watchdog: If WhatsApp Web fails to reach 'ready' state within 10 minutes, force clean restart.
    // 10 min is generous enough for the slowest Oracle Cloud loads, but catches genuine Chrome freezes.
    if (startupSeconds >= 600) {
        console.error('❌ Startup watchdog timeout: WhatsApp Web did not reach ready state within 10 minutes. Triggering clean restart...');
        if (startupSpinner) {
            clearInterval(startupSpinner);
            startupSpinner = null;
        }
        try {
            await client.destroy();
        } catch (_) {}
        setTimeout(() => process.exit(1), 3000);
    }
}, 5000);

let isAlreadyStarted = false;

client.on('ready', async () => {
    // Stop startup spinner
    if (startupSpinner) {
        clearInterval(startupSpinner);
        startupSpinner = null;
    }

    if (isAlreadyStarted) {
        console.log('⚡ WhatsApp connection restored (background re-sync).');
        return;
    }
    isAlreadyStarted = true;

    const isAiModeStartup = (process.env.FILTER_MODE || 'ai').toLowerCase() === 'ai';
    console.log('\n✅ WhatsApp Client is ready!');
    console.log(`📡 Source Channel: ${sourceChannelId}`);
    console.log(`🎯 Destination Channel(s) [${destinationChannelIds.length}]: ${destinationChannelIds.join(', ')}`);
    if (isAiModeStartup) {
        console.log(`🔎 AI Criteria: "${jobCriteria}"`);
    } else {
        console.log(`🔎 Filter Mode: Keywords (Whitelist/Blacklist)`);
        console.log(`   ✅ Technologies (must match 1): ${process.env.WHITELIST_TECHNOLOGIES || '(none)'}`);
        console.log(`   ✅ Roles (must match 1):        ${process.env.WHITELIST_ROLES || '(none)'}`);
        console.log(`   ❌ Blocked roles (title only):  ${process.env.BLACKLIST_ROLES || '(none)'}`);
        console.log(`   ❌ Blocked technologies (full): ${process.env.BLACKLIST_TECHNOLOGIES || '(none)'}`);
    }
    console.log(`⏱️  Polling Interval: Every ${POLLING_INTERVAL_MS / 1000 / 60} minutes\n`);

    const isReady = sourceChannelId && destinationChannelIds.length > 0 && (!isAiModeStartup || jobCriteria);
    if (isReady) {
        // Send a test connection message to all destination channels
        for (const destId of destinationChannelIds) {
            try {
                await client.sendMessage(destId, "🤖 Job Filter Bot is now connected and listening for job postings!");
                console.log(`✅ Verified write access to Destination Channel (${destId}).`);
            } catch (sendErr) {
                console.error(`❌ Failed to send connection test message to Destination Channel (${destId}). Please verify the destination ID and your permissions.`, sendErr);
            }
        }

        // Clear any existing interval in case of re-initialization
        if (pollIntervalId) {
            clearInterval(pollIntervalId);
        }
        // Wait for WhatsApp Web to fully sync chats on slow VMs before first poll
        const syncWait = 15;
        for (let i = syncWait; i > 0; i--) {
            if (i === syncWait || i % 5 === 0 || i <= 3) {
                console.log(`⏳ Syncing WhatsApp chats... ${i}s remaining`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log('✅ Sync complete! Starting first scan...');

        // Start polling every 10 minutes
        pollIntervalId = setInterval(pollChannel, POLLING_INTERVAL_MS);
        pollChannel(); // initial check
    } else {
        if (!sourceChannelId || !destinationChannelId) {
            console.error('❌ Please set SOURCE_CHANNEL_ID and DESTINATION_CHANNEL_ID in your .env file.');
        } else {
            console.error('❌ AI mode requires JOB_CRITERIA to be set in your .env file.');
        }
    }
});

async function fetchRecentMessages(chatId, limit) {
    const result = await client.pupPage.evaluate(async (chatId, limit) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat || !chat.msgs) return { messages: [], debug: 'no-chat' };

        const msgFilter = (m) => !m.isNotification;
        let msgs = chat.msgs.getModelsArray().filter(msgFilter);

        let attempts = 0;
        let loadLogs = [];
        loadLogs.push(`Initial in-memory: ${msgs.length}`);

        while (msgs.length < limit && attempts < 10) {
            let loadedMessages = [];
            let strategyUsed = 'none';

            // Strategy 1: Standard WAWebChatLoadMessages
            try {
                const loadModule = window.require('WAWebChatLoadMessages');
                if (loadModule && typeof loadModule.loadEarlierMsgs === 'function') {
                    loadedMessages = await loadModule.loadEarlierMsgs({ chat }) || [];
                    if (loadedMessages.length > 0) strategyUsed = 'WAWebChatLoadMessages';
                }
            } catch (e1) { }

            // Strategy 2: Direct model collection load
            if (!loadedMessages || !loadedMessages.length) {
                try {
                    if (chat.msgs && typeof chat.msgs.loadEarlier === 'function') {
                        loadedMessages = await chat.msgs.loadEarlier() || [];
                        if (loadedMessages.length > 0) strategyUsed = 'chat.msgs.loadEarlier';
                    }
                } catch (e2) { }
            }

            // Strategy 3: Local DB msgFindBefore
            if (!loadedMessages || !loadedMessages.length) {
                try {
                    const dbModule = window.require('WAWebDBMessageFindLocal');
                    if (dbModule && typeof dbModule.msgFindBefore === 'function') {
                        const oldestMsg = msgs[0];
                        if (oldestMsg) {
                            loadedMessages = await dbModule.msgFindBefore(chat.id, oldestMsg.id, limit) || [];
                            if (loadedMessages.length > 0) strategyUsed = 'msgFindBefore';
                        }
                    }
                } catch (e3) { }
            }

            loadLogs.push(`Attempt ${attempts + 1} (${strategyUsed}): loaded ${loadedMessages.length}`);
            if (!loadedMessages || !loadedMessages.length) break;

            const getMsgId = (m) => {
                if (!m || !m.id) return null;
                return typeof m.id === 'object' ? (m.id._serialized || m.id.id) : m.id;
            };
            const existingIds = new Set(msgs.map(m => getMsgId(m)).filter(id => id !== null));
            const newMsgs = loadedMessages.filter(m => {
                if (!msgFilter(m)) return false;
                const mId = getMsgId(m);
                return mId !== null && !existingIds.has(mId);
            });

            loadLogs.push(`Attempt ${attempts + 1}: new: ${newMsgs.length}`);
            if (newMsgs.length === 0) break; // no new actual messages loaded

            msgs = [...newMsgs, ...msgs];
            attempts++;
        }

        if (msgs.length > limit) {
            msgs = msgs.slice(msgs.length - limit);
        }
        return {
            messages: msgs.map(m => window.WWebJS.getMessageModel(m)),
            debug: loadLogs.join(' | ')
        };
    }, chatId, limit);

    console.log(`[Debug Fetch] ${result.debug}`);
    return result.messages.map(m => new Message(client, m));
}

async function sendMessageWithRetry(chatId, content, maxRetries = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const sentMsg = await client.sendMessage(chatId, content);
            const msgIdStr = sentMsg ? (
                (typeof sentMsg.id === 'object' && sentMsg.id ? (sentMsg.id._serialized || sentMsg.id.id) : sentMsg.id) || 'unknown'
            ) : 'unknown';
            const ackStatus = (sentMsg && sentMsg.ack !== undefined && sentMsg.ack !== null) ? sentMsg.ack : 'pending/queued';
            console.log(`[Debug Send] Delivered to ${chatId} | Msg ID: ${msgIdStr} | Ack: ${ackStatus}`);
            return sentMsg;
        } catch (err) {
            lastErr = err;
            console.warn(`⚠️ Attempt ${attempt}/${maxRetries} failed to send message: ${err.message}`);
            if (attempt < maxRetries) {
                await new Promise(res => setTimeout(res, attempt * 2000));
            }
        }
    }
    throw lastErr;
}

async function processSingleMessage(msg) {
    const msgId = msg.id && typeof msg.id === 'object'
        ? (msg.id._serialized || msg.id.id)
        : (msg.id || `${msg.timestamp}_${msg.author || msg.from}`);
    const text = msg.body;

    if (msg.timestamp < startTime) return;
    if (processedMessages.has(msgId)) return;
    if (!text || text.trim() === '') {
        processedMessages.add(msgId);
        saveProcessedMessages();
        return;
    }

    const isAiMode = (process.env.FILTER_MODE || 'ai').toLowerCase() === 'ai';

    console.log('\n=================== NEW JOB POST RECEIVED ===================');
    console.log(text);
    console.log('-------------------------------------------------------------');
    if (isAiMode) {
        console.log('🤖 Analyzing with Gemini AI...');
    } else {
        console.log('🔍 Analyzing with Keywords (Whitelist/Blacklist)...');
    }

    let isRelevant = false;
    let reason = '';
    let usedFallback = false;

    try {
        const result = await isJobRelevant(text);
        isRelevant = result.matched;
        reason = result.reason;
    } catch (apiErr) {
        console.warn(`⚠️ Gemini API error (quota/limit exceeded): ${apiErr.message}`);
        console.warn('🔄 Falling back to local whitelist/blacklist keyword filtering...');
        const result = isJobRelevantKeywords(text);
        isRelevant = result.matched;
        reason = result.reason;
        usedFallback = true;
    }

    if (isRelevant) {
        if (usedFallback) {
            console.log(`➡️  FALLBACK DECISION: ✅ FILTER IN — ${reason}`);
        } else if (isAiMode) {
            console.log(`➡️  AI DECISION: ✅ FILTER IN — ${reason}`);
        } else {
            console.log(`➡️  DECISION: ✅ FILTER IN — ${reason}`);
        }
        let anyFailed = false;
        let fatalConnectionErr = null;
        let isFirstGroup = true;

        let postDateStr = '';
        if (msg.timestamp) {
            const timestampMs = msg.timestamp > 1e11 ? msg.timestamp : msg.timestamp * 1000;
            const dateObj = new Date(timestampMs);
            const dateFormatted = dateObj.toLocaleDateString('en-GB', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                timeZone: 'Asia/Jerusalem'
            });
            const timeFormatted = dateObj.toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: 'Asia/Jerusalem'
            });
            postDateStr = `📅 Posted: ${dateFormatted} at ${timeFormatted}\n\n`;
        }

        for (const destId of destinationChannelIds) {
            if (!isFirstGroup && BROADCAST_DELAY_MS > 0) {
                // Add a small random jitter (+-500ms) to simulate human typing/sending speed
                const jitter = Math.floor(Math.random() * 1000) - 500;
                const actualDelay = Math.max(500, BROADCAST_DELAY_MS + jitter);
                console.log(`⏳ Anti-spam delay: Waiting ${(actualDelay / 1000).toFixed(1)}s before broadcasting to next group (${destId})...`);
                await new Promise(resolve => setTimeout(resolve, actualDelay));
            }
            isFirstGroup = false;

            try {
                await sendMessageWithRetry(destId, `[Filtered Job]\n${postDateStr}${text}`);
                console.log(`📤 Successfully forwarded job to destination group (${destId})!`);
            } catch (sendErr) {
                anyFailed = true;
                console.error(`❌ Failed to forward message to destination (${destId}) after retries:`, sendErr.message);
                if (
                    sendErr.message.includes('detached Frame') ||
                    sendErr.message.includes('Protocol error') ||
                    sendErr.message.includes('ProtocolError') ||
                    sendErr.message.includes('Runtime.callFunctionOn') ||
                    sendErr.message.includes('Target closed') ||
                    sendErr.message.includes('Session closed') ||
                    sendErr.message.includes('timed out')
                ) {
                    fatalConnectionErr = sendErr;
                }
            }
        }

        if (!anyFailed) {
            // Only mark as processed AFTER successful delivery to all destination channels
            processedMessages.add(msgId);
            saveProcessedMessages();
        } else if (fatalConnectionErr) {
            console.log('🔄 Browser connection issue during message delivery. Exiting for clean PM2 restart so message can be retried...');
            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
            }
            try {
                await client.destroy();
            } catch (_) { }
            setTimeout(() => process.exit(1), 3000);
        }
    } else {
        if (usedFallback) {
            console.log(`➡️  FALLBACK DECISION: ❌ FILTER OUT — ${reason}`);
        } else if (isAiMode) {
            console.log(`➡️  AI DECISION: ❌ FILTER OUT — ${reason}`);
        } else {
            console.log(`➡️  DECISION: ❌ FILTER OUT — ${reason}`);
        }
        // Mark filtered out messages as processed so they aren't re-evaluated
        processedMessages.add(msgId);
        saveProcessedMessages();
    }
    console.log('=============================================================\n');
}

async function pollChannel() {
    try {
        console.log('🔄 Loading message history from the last 5 days (Please wait, it is NOT stuck)...');

        // Fetch recent messages safely using enhanced multi-strategy in-memory fetcher
        const messages = await fetchRecentMessages(sourceChannelId, 500);

        if (messages.length === 0) {
            console.log('⚠️  No messages found. The source channel may still be syncing. Will retry next cycle.');
            return;
        }

        let skippedOld = 0;
        let skippedProcessed = 0;
        const messagesToProcess = [];

        for (const msg of messages) {
            const msgId = msg.id && typeof msg.id === 'object'
                ? (msg.id._serialized || msg.id.id)
                : (msg.id || `${msg.timestamp}_${msg.author || msg.from}`);
            
            if (msg.timestamp < startTime) {
                skippedOld++;
            } else if (processedMessages.has(msgId)) {
                skippedProcessed++;
            } else {
                messagesToProcess.push(msg);
            }
        }

        console.log(`📊 Scan Stats — Fetched: ${messages.length} | Old (<5d): ${skippedOld} | Already Processed: ${skippedProcessed} | New to Analyze: ${messagesToProcess.length}`);

        if (messagesToProcess.length > 0) {
            let index = 1;
            for (const msg of messagesToProcess) {
                console.log(`📋 Analyzing message ${index} of ${messagesToProcess.length}...`);
                await processSingleMessage(msg);
                index++;
                // Add a small 100ms pacing delay between messages so Chrome V8 engine doesn't choke during bulk scans
                await new Promise(r => setTimeout(r, 100));
            }
        } else {
            console.log('📥 No new messages to analyze from the last 5 days.');
        }
        console.log('📡 Channel poll cycle completed successfully.');
    } catch (err) {
        console.error('Error polling channel:', err);
        if (
            err.message.includes('detached Frame') ||
            err.message.includes('Protocol error') ||
            err.message.includes('ProtocolError') ||
            err.message.includes('Runtime.callFunctionOn') ||
            err.message.includes('Target closed') ||
            err.message.includes('Session closed') ||
            err.message.includes('timed out')
        ) {
            console.log('🔄 Detected browser connection issue. Exiting for clean restart (PM2 will auto-restart)...');
            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
            }
            try {
                await client.destroy();
            } catch (_) { }
            setTimeout(() => process.exit(1), 3000);
        }
    }
}

// Handle graceful disconnection (e.g., WhatsApp server key rotation or network drop)
client.on('disconnected', async (reason) => {
    console.log(`⚠️  WhatsApp Client disconnected (Reason: ${reason}). Cleaning up for auto-restart...`);

    for (const destId of destinationChannelIds) {
        try {
            await client.sendMessage(destId, "⚠️ ALERT: WhatsApp bot has disconnected or lost connection. Please check server logs or re-connect.");
            console.log(`📢 Sent disconnect alert to Destination Channel (${destId}).`);
        } catch (sendErr) {
            console.warn(`⚠️ Could not send disconnect alert message to ${destId}:`, sendErr.message);
        }
    }

    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
    try {
        await client.destroy();
    } catch (_) { }
    setTimeout(() => process.exit(1), 3000);
});

// Helper function to remove stale Chrome lock files left behind by unexpected crashes
function cleanupStaleSessionLocks() {
    const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
    if (fs.existsSync(sessionDir)) {
        const lockFile = path.join(sessionDir, 'SingletonLock');
        if (fs.existsSync(lockFile)) {
            try {
                fs.unlinkSync(lockFile);
                console.log('🧹 Removed stale Chromium session lock file (SingletonLock).');
            } catch (err) {
                console.warn('⚠️  Could not remove SingletonLock:', err.message);
            }
        }
    }
}

// Async startup function with built-in 5-second delay to release Chrome locks
async function startBot() {
    console.log('⏳ Pausing 5 seconds on startup to ensure previous Chrome session handles are released...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    cleanupStaleSessionLocks();

    client.initialize().catch(async (err) => {
        console.error('Initialization error:', err);
        try {
            await client.destroy();
        } catch (_) { }
        setTimeout(() => process.exit(1), 3000);
    });
}

startBot();

process.on('SIGINT', async () => {
    console.log('\nShutting down WhatsApp bot...');
    try {
        await client.destroy();
    } catch (_) { }
    process.exit(0);
});
