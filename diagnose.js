/**
 * UI Scrolling Diagnostic for WhatsApp Web Newsletters
 * 
 * This script will:
 * 1. Connect to WhatsApp.
 * 2. Bypass the broken `getChat` by using `getChats()`.
 * 3. Force the UI to open the channel.
 * 4. Scroll the message pane up to force WhatsApp to load older messages.
 * 5. Read the new messages directly from memory.
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
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Scan QR to log in:');
    qrcode.generate(qr, { small: true });
});

async function scrollAndFetch(chatId, targetLimit) {
    console.log(`\n[UI Automation] Preparing to scroll and fetch up to ${targetLimit} messages...`);
    
    return await client.pupPage.evaluate(async (id, limit) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        
        // 1. Bypass the broken getChat API to find our channel
        const chats = await window.WWebJS.getChats();
        const chat = chats.find(c => c.id._serialized === id);
        if (!chat) return { error: 'Channel not found in memory.' };
        
        // 2. Force the WhatsApp UI to open this chat
        try {
            await window.require('WAWebCmd').Cmd.openChatBottom({ chat });
            await sleep(2000); // Wait for UI to render the chat
        } catch (e) {
            return { error: 'Failed to open chat in UI: ' + e.message };
        }
        
        // 3. Find the scrollable message pane
        // WhatsApp Web usually puts the messages in a div with role="region" and aria-label="Message list"
        const messagePane = document.querySelector('div[role="region"][aria-label="Message list"]') 
            || document.querySelector('#main .copyable-area [style*="overflow-y"]'); // Fallback
            
        if (!messagePane) {
            return { error: 'Could not find the scrollable message pane in the DOM.' };
        }
        
        // 4. Scroll loop
        let previousHeight = messagePane.scrollHeight;
        let attempts = 0;
        let scrollLogs = [];
        
        const msgFilter = (m) => !m.isNotification;
        
        while (chat.msgs.getModelsArray().filter(msgFilter).length < limit && attempts < 15) {
            // Scroll to absolute top
            messagePane.scrollTop = 0;
            scrollLogs.push(`Scrolled to top. Waiting for load...`);
            
            // Wait for WhatsApp to fetch and render
            await sleep(2500); 
            
            // Check if height changed (meaning new messages loaded)
            if (messagePane.scrollHeight > previousHeight) {
                scrollLogs.push(`Height increased! New messages loaded. Found: ${chat.msgs.getModelsArray().length}`);
                previousHeight = messagePane.scrollHeight;
                attempts = 0; // Reset attempts if we made progress
            } else {
                scrollLogs.push(`Height did not change. Retrying...`);
                attempts++;
            }
        }
        
        // 5. Get the final messages from memory
        const msgs = chat.msgs.getModelsArray().filter(msgFilter);
        return {
            logs: scrollLogs,
            count: msgs.length,
            messages: msgs.slice(-limit).map(m => window.WWebJS.getMessageModel(m))
        };
        
    }, chatId, targetLimit);
}

client.on('ready', async () => {
    console.log('\n✅ Connected to WhatsApp.\n');
    console.log('⏳ Waiting 10s for initial sync...');
    await new Promise(r => setTimeout(r, 10000));

    try {
        const result = await scrollAndFetch(sourceChannelId, LIMIT);
        
        if (result.error) {
            console.error('❌ UI Automation Failed:', result.error);
        } else {
            console.log('--- Scrolling Logs ---');
            result.logs.forEach(l => console.log('  ' + l));
            console.log('----------------------');
            console.log(`✅ Success! Extracted ${result.count} messages.`);
            
            if (result.messages.length > 0) {
                const oldest = new Date(result.messages[0].timestamp * 1000).toLocaleString();
                console.log(`   Oldest message timestamp: ${oldest}`);
            }
        }
    } catch (err) {
        console.error('❌ Error executing script:', err);
    }
    
    process.exit(0);
});

client.initialize();
