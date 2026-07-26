/**
 * Diagnostic script — run this on the server to verify how many messages
 * can be fetched from the source channel before starting the full bot.
 *
 * Usage: node diagnose.js
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

const sourceChannelId = process.env.SOURCE_CHANNEL_ID;
const LIMIT = 500;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Scan QR to log in:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\n✅ Connected to WhatsApp.\n');

    if (!sourceChannelId) {
        console.error('❌ SOURCE_CHANNEL_ID not set in .env');
        process.exit(1);
    }

    try {
        // --- Test 1: Can we find the channel? ---
        console.log(`[Test 1] Looking for channel "${sourceChannelId}" in chat list...`);
        const chats = await client.getChats();
        const chat = chats.find(c => c.id._serialized === sourceChannelId);

        if (!chat) {
            console.error(`❌ Channel not found. Available channels & groups:`);
            chats.filter(c => c.isGroup || c.isChannel).forEach(c => {
                console.log(`  - "${c.name}" → ${c.id._serialized}`);
            });
            process.exit(1);
        }
        console.log(`✅ Found channel: "${chat.name}"`);

        // --- Test 2: How many messages can we fetch? ---
        console.log(`\n[Test 2] Fetching up to ${LIMIT} messages (this may take 30-60s)...`);
        const messages = await chat.fetchMessages({ limit: LIMIT });
        console.log(`✅ Fetched ${messages.length} messages.`);

        if (messages.length > 0) {
            const oldest = new Date(messages[0].timestamp * 1000).toLocaleString();
            const newest = new Date(messages[messages.length - 1].timestamp * 1000).toLocaleString();
            console.log(`   Oldest message: ${oldest}`);
            console.log(`   Newest message: ${newest}`);
        }

        // --- Test 3: How many are within 5 days? ---
        const fiveDaysAgo = Math.floor(Date.now() / 1000) - (60 * 60 * 24 * 5);
        const recent = messages.filter(m => m.timestamp >= fiveDaysAgo);
        console.log(`\n[Test 3] Messages from last 5 days: ${recent.length} of ${messages.length}`);

        console.log('\n✅ Diagnosis complete. Exiting.');
    } catch (err) {
        console.error('❌ Error during diagnosis:', err);
    }

    process.exit(0);
});

client.initialize();
