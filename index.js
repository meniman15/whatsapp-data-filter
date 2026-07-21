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
        protocolTimeout: 60000, // Extend CDP protocol timeout for slow VMs
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('--- QR CODE ---');
    console.log('Scan this QR code with your WhatsApp app to log in:');
    qrcode.generate(qr, { small: true });
});

let pollIntervalId = null;

client.on('ready', async () => {
    console.log('\n✅ WhatsApp Client is ready!');
    console.log(`📡 Source Channel: ${sourceChannelId}`);
    console.log(`🎯 Destination Channel: ${destinationChannelId}`);
    console.log(`🔎 Filter Criteria: "${jobCriteria}"`);
    console.log(`⏱️  Polling Interval: Every ${POLLING_INTERVAL_MS / 1000 / 60} minutes\n`);

    if (sourceChannelId && destinationChannelId && jobCriteria) {
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
        // Start polling
        pollIntervalId = setInterval(pollChannel, POLLING_INTERVAL_MS);
        pollChannel(); // initial check
    } else {
        console.error('❌ Please fill out the .env file with your IDs and criteria.');
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
    let usedFallback = false;

    try {
        isRelevant = await isJobRelevant(text);
    } catch (apiErr) {
        console.warn(`⚠️ Gemini API error (quota/limit exceeded): ${apiErr.message}`);
        console.warn('🔄 Falling back to local whitelist/blacklist keyword filtering...');
        isRelevant = isJobRelevantKeywords(text);
        usedFallback = true;
    }

    if (isRelevant) {
        if (usedFallback) {
            console.log('➡️  FALLBACK DECISION: ✅ FILTER IN (Keywords matched - Forwarding)');
        } else if (isAiMode) {
            console.log('➡️  AI DECISION: ✅ FILTER IN (Relevant - Forwarding to destination)');
        } else {
            console.log('➡️  DECISION: ✅ FILTER IN (Keywords matched - Forwarding)');
        }
        try {
            await client.sendMessage(destinationChannelId, `[Filtered Job]\n\n${text}`);
        } catch (sendErr) {
            console.error('❌ Failed to forward message to destination:', sendErr);
        }
    } else {
        if (usedFallback) {
            console.log('➡️  FALLBACK DECISION: ❌ FILTER OUT (Keywords did not match - Ignoring)');
        } else if (isAiMode) {
            console.log('➡️  AI DECISION: ❌ FILTER OUT (Not Relevant - Ignoring)');
        } else {
            console.log('➡️  DECISION: ❌ FILTER OUT (Keywords did not match - Ignoring)');
        }
    }
    console.log('=============================================================\n');
}

async function pollChannel() {
    try {
        const chat = await client.getChatById(sourceChannelId);
        if (!chat) {
            console.error('Source channel not found. Please check SOURCE_CHANNEL_ID.');
            return;
        }

        console.log('🔄 Loading message history from the last 3 days (Please wait, this is NOT stuck)...');

        // Fetch recent messages safely using memory models to avoid wwebjs loadEarlierMsgs infinite loop bug
        const messages = await fetchRecentMessages(sourceChannelId, 150);

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
            err.message.includes('Session closed')
        ) {
            console.log('🔄 Detected browser connection issue. Attempting to recover by restarting the client...');
            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
            }
            try {
                await client.destroy();
            } catch (_) { }
            console.log('Re-initializing client...');
            client.initialize().catch(async (initErr) => {
                console.error('Failed to re-initialize client after crash:', initErr);
                process.exit(1);
            });
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
