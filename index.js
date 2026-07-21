const { Client, LocalAuth } = require('whatsapp-web.js');
const Message = require('whatsapp-web.js/src/structures/Message');
const qrcode = require('qrcode-terminal');
require('dotenv').config();
const { isJobRelevant, isJobRelevantKeywords } = require('./filter');
const fs = require('fs');
const path = require('path');

const sourceChannelId = process.env.SOURCE_CHANNEL_ID;
const destinationChannelId = process.env.DESTINATION_CHANNEL_ID;
const jobCriteria = process.env.JOB_CRITERIA;
const POLLING_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const AMOUNT_OF_TIME_BEFORE = 1000 * 60 * 60 * 24 * 5; //all jobs from five days ago

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

// We only process messages received in the last 3 days
let startTime = Math.floor(Date.now() / 1000) - AMOUNT_OF_TIME_BEFORE;

const client = new Client({
    authStrategy: new LocalAuth(),
    authTimeoutMs: 60000, // 60 seconds timeout for slower VM environments
    puppeteer: {
        protocolTimeout: 180000, // Extend CDP protocol timeout for slow VMs (3 minutes)
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
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

// Startup progress logger — prints every 5s while browser/WhatsApp initializes
let startupSpinner = null;
let startupSeconds = 0;
console.log('🚀 Launching browser and connecting to WhatsApp...');
startupSpinner = setInterval(() => {
    startupSeconds += 5;
    console.log(`   ⏳ Still starting up... ${startupSeconds}s elapsed (can take up to 60s on a slow server)`);
}, 5000);

client.on('ready', async () => {
    // Stop startup spinner
    if (startupSpinner) {
        clearInterval(startupSpinner);
        startupSpinner = null;
    }
    const isAiModeStartup = (process.env.FILTER_MODE || 'ai').toLowerCase() === 'ai';
    console.log('\n✅ WhatsApp Client is ready!');
    console.log(`📡 Source Channel: ${sourceChannelId}`);
    console.log(`🎯 Destination Channel: ${destinationChannelId}`);
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

    const isReady = sourceChannelId && destinationChannelId && (!isAiModeStartup || jobCriteria);
    if (isReady) {
        // Send a test connection message to the destination channel
        try {
            await client.sendMessage(destinationChannelId, "🤖 Job Filter Bot is now connected and listening for job postings!");
            console.log("✅ Verified write access to Destination Channel (Test message sent).");
        } catch (sendErr) {
            console.error("❌ Failed to send connection test message to Destination Channel. Please verify the destination ID and your permissions.", sendErr);
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

        // Start polling
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
            const loadedMessages = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
            const firstMsg = loadedMessages[0];
            const sampleIdInfo = firstMsg && firstMsg.id
                ? (typeof firstMsg.id === 'object' ? `obj(keys:${Object.keys(firstMsg.id).join(',')},_ser:${firstMsg.id._serialized},id:${firstMsg.id.id})` : `val:${firstMsg.id}`)
                : 'no-id';
            loadLogs.push(`Attempt ${attempts + 1}: loaded ${loadedMessages.length} (sampleId: ${sampleIdInfo})`);
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

async function processSingleMessage(msg) {
    const msgId = msg.id && typeof msg.id === 'object'
        ? (msg.id._serialized || msg.id.id)
        : (msg.id || `${msg.timestamp}_${msg.author || msg.from}`);
    const text = msg.body;

    if (msg.timestamp < startTime) return;
    if (processedMessages.has(msgId)) return;

    processedMessages.add(msgId);
    saveProcessedMessages();

    if (!text || text.trim() === '') return;

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
        try {
            await client.sendMessage(destinationChannelId, `[Filtered Job]\n\n${text}`);
        } catch (sendErr) {
            console.error('❌ Failed to forward message to destination:', sendErr);
        }
    } else {
        if (usedFallback) {
            console.log(`➡️  FALLBACK DECISION: ❌ FILTER OUT — ${reason}`);
        } else if (isAiMode) {
            console.log(`➡️  AI DECISION: ❌ FILTER OUT — ${reason}`);
        } else {
            console.log(`➡️  DECISION: ❌ FILTER OUT — ${reason}`);
        }
    }
    console.log('=============================================================\n');
}

async function pollChannel() {
    try {
        console.log('🔄 Loading message history from the last 3 days (Please wait, it is currently running)...');

        // Fetch recent messages safely using memory models to avoid wwebjs loadEarlierMsgs infinite loop bug
        const messages = await fetchRecentMessages(sourceChannelId, 150);

        if (messages.length === 0) {
            console.log('⚠️  No messages found. The source channel may still be syncing. Will retry next cycle.');
            return;
        }

        // Filter messages to process in this tick (last 24h and not already processed)
        const messagesToProcess = messages.filter(msg => {
            const msgId = msg.id && typeof msg.id === 'object'
                ? (msg.id._serialized || msg.id.id)
                : (msg.id || `${msg.timestamp}_${msg.author || msg.from}`);
            return msg.timestamp >= startTime && !processedMessages.has(msgId);
        });

        if (messagesToProcess.length > 0) {
            console.log(`✅ History load complete! Found ${messagesToProcess.length} messages to analyze.`);
            let index = 1;
            for (const msg of messagesToProcess) {
                console.log(`📋 Analyzing message ${index} of ${messagesToProcess.length}...`);
                await processSingleMessage(msg);
                index++;
            }
        } else {
            console.log('📥 No new messages to analyze from the last 3 days.');
        }
        console.log('📡 Funnel is ready and listening for new group messages in real-time!');
    } catch (err) {
        console.error('Error polling channel:', err);
        if (
            err.message.includes('detached Frame') ||
            err.message.includes('Protocol error') ||
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
            process.exit(1);
        }
    }
}

// Stream new messages in real-time as they arrive (acting as a pure funnel)
client.on('message', async (msg) => {
    if (msg.from === sourceChannelId) {
        await processSingleMessage(msg);
    }
});

client.initialize().catch(async (err) => {
    console.error('Initialization error:', err);
    try {
        await client.destroy();
    } catch (_) { }
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down WhatsApp bot...');
    try {
        await client.destroy();
    } catch (_) { }
    process.exit(0);
});
