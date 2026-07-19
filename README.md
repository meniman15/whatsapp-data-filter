# WhatsApp Job Filter Bot 📡➡️🔍➡️🎯

An automated, real-time message forwarding and filtering bot for WhatsApp. It acts as a smart funnel—monitoring a source group, analyzing and filtering postings based on your custom criteria (using Google Gemini AI or local keywords/experience thresholds), and instantly publishing matches to a destination group.

---

## 🎯 Who is this for?
* **Job Seekers**: Wanting to extract only matching job postings from a chaotic, highly-active job board group.
* **Recruiters & Agency Moderators**: Automating the curation and routing of relevant job postings from a "firehose" group to targeted talent pools.
* **Community Managers**: Scaling content curation on WhatsApp groups/channels without manual copy-pasting.

---

## 🚀 How to Use (in 2 Phases)

### 📋 Phase 1: Authentication & Setup Wizard
In this phase, you will connect your WhatsApp account and easily choose your source and destination groups.

1. **Clone & Install Dependencies**:
   ```bash
   git clone https://github.com/meniman15/whatsapp-data-filter.git
   cd whatsapp-data-filter
   npm install
   ```
2. **Start the Setup Wizard**:
   ```bash
   npm run setup
   ```
3. **Authenticate**: A QR Code will display in your terminal. Scan it using your phone's WhatsApp application (*Linked Devices > Link a Device*).
4. **Choose Channels**: The interactive wizard will search your chats. Use it to select:
   * 📡 Your **Source Group** (where the bot reads messages).
   * 🎯 Your **Destination Group** (where the bot forwards matches).
   * The wizard will automatically save these settings to your `.env` configuration file.

---

### 🔍 Phase 2: Configuration & Running the Funnel
In this phase, you customize the filtering rules and launch the active bot.

1. **Configure Rules (`.env`)**:
   Open the generated `.env` file to customize how you filter. You can configure:
   * **`FILTER_MODE`**: `ai` (to use Google Gemini) or `keywords` (to use local keywords).
   * **`WHITELIST_KEYWORDS`**: Comma-separated words the post must contain (e.g., `react,node,backend`).
   * **`BLACKLIST_KEYWORDS`**: Comma-separated words to block (e.g., `devops,cobol,php`).
   * **`MAX_YEARS_EXPERIENCE`**: Set a maximum threshold (e.g., `5`). The bot automatically filters out any job requiring more years of experience.
   * **`GEMINI_API_KEY`**: Paste your Google Gemini API key if using AI mode.

2. **Run the Funnel**:
   ```bash
   node index.js
   ```
   * **On Startup**: The bot will verify access to the destination group (by sending a quick test message) and safely scan the last **3 days of history** to analyze older postings you might have missed.
   * **In Real-Time**: It then stays awake, listening to the source group and forwarding matches **instantly** (within milliseconds) as they arrive.

---

## 🛠️ Local Production Deployment
To leave the bot running permanently in the background (even if you close your terminal or your computer restarts), use **PM2**:

```bash
# Install PM2 globally
npm install -g pm2

# Start the bot
pm2 start index.js --name "whatsapp-filter-bot"

# Save the process list to restart on system boot
pm2 startup
pm2 save
```
