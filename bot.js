"use strict";

const { Telegraf } = require("telegraf");
const Groq         = require("groq-sdk");
const fs           = require("fs");
const path         = require("path");

// --- Env ---
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT         = process.env.PORT || 3000;
const WEBHOOK_URL  = process.env.WEBHOOK_URL;

if (!BOT_TOKEN || !GROQ_API_KEY || !WEBHOOK_URL) {
  console.error("Missing BOT_TOKEN, GROQ_API_KEY or WEBHOOK_URL");
  process.exit(1);
}

// --- Token config ---
const CA         = "0x2BCb12daBb11f2f4CD3f35CaE22cBdcBf3Fe5413";
const TICKER     = "$\u8D22\u5BCC";
const NAME       = "FURTUNE";
const CHART      = "https://dexscreener.com/bsc/0x2BCb12daBb11f2f4CD3f35CaE22cBdcBf3Fe5413";
const BUY_LINK   = "https://pancakeswap.finance/swap?outputCurrency=0x2BCb12daBb11f2f4CD3f35CaE22cBdcBf3Fe5413";
const TWITTER    = "https://x.com/furtune_bsc";
const IMAGE      = path.join(__dirname, "furtune.jpg");

// --- Groq & bot ---
const groq = new Groq({ apiKey: GROQ_API_KEY });
const bot  = new Telegraf(BOT_TOKEN);

// --- State ---
const lastCaMsgId      = {};
const lastSilenceMsgId = {};
const silenceTimers    = {};
const welcomeMsgIds    = {};
const spamTracker      = {};
let   lastSilenceAngle = -1;

const SILENCE_MS = 30 * 60 * 1000;

// --- Rotating short CA captions (Baby Siren style) ---
const CA_OPENERS = [
  "\u{1F4B0} " + TICKER + " lives here:",
  "\u{1F3AF} The treasure address:",
  "\u26D3\uFE0F Hunt starts here:",
  "\u{1F9E7} Cai Fu\u2019s address:",
  "\u{1F4CD} " + TICKER + " on BNB:",
  "\u{1F511} The key to fortune:",
  "\u{1F30F} Find it. Buy it. Hold it.",
];
const CA_CLOSERS = [
  "Verify on DexScreener. Stay safe fren.",
  "Paste it on PancakeSwap. Ape in.",
  "Cross-check before you connect your wallet.",
  "The hunt is real. The address is verified.",
  "Ancient treasure. Modern chain.",
  "Only trust this address. Nothing else.",
  "Cai Fu doesn\u2019t repeat himself.",
];
let lastCaIdx = -1;

// --- 7 silence breaker angles ---
const SILENCE_ANGLES = [
  "\u8D22\u5BCC stirs in the shadows. The treasure hunt is never over.",
  "Ancient fortune. Modern chain. " + TICKER + " is still here.",
  "Cai Fu chose this chain for a reason. The mission continues.",
  "The quietest rooms hold the biggest treasure. " + TICKER + " on BNB.",
  "Not every fortune announces itself. " + TICKER + " just grows.",
  "In ancient China they searched for years. You found it in one click. " + TICKER,
  "The guardians are patient. So is " + TICKER + ".",
];

// --- AI system prompt ---
const SYSTEM_PROMPT =
  "You are the official community AI for FURTUNE (" + TICKER + "), a meme token on BNB Smart Chain. " +
  "Lore: In ancient China, \u8D22\u5BCC (Cai Fu), the guardian of prosperity, hid treasures across the land. " +
  "Those who find and unite these treasures are granted boundless fortune. The mission is to hunt for \u8D22\u5BCC and unleash its power. " +
  "CA: " + CA + ". Supply: 80,000,000. Max wallet: 4.2%. Tax: 5% buy / 5% sell. Chain: BNB Smart Chain. " +
  "Contract is renounced. LP is locked. Twitter/X is live at @furtune_bsc. " +
  "Personality: calm, confident, warm, real. Never corporate. Never stiff. " +
  "Never use phrases like: vibrant community, feel free to explore, embark on, thrilling quest, do not hesitate. " +
  "Every reply must feel different - vary words, structure, energy every time. " +
  "Short questions = 1-3 lines max. Detailed questions = up to 5 lines max. " +
  "Use minimal emojis. Never place an emoji directly after the contract address. " +
  "NEVER output raw URLs in any reply - the bot handles links separately. " +
  "Never share any Telegram group link. Never volunteer the CA unless directly asked. " +
  "Only answer direct questions about the project. For anything vague or casual respond with exactly: IGNORE";

// --- Helpers ---
async function isAdmin(telegram, chatId, userId) {
  try {
    const m = await telegram.getChatMember(chatId, userId);
    return ["administrator", "creator"].includes(m.status);
  } catch (_) {
    return false;
  }
}

function delMsg(telegram, chatId, msgId, delay) {
  if (!msgId) return;
  const fn = async () => {
    try { await telegram.deleteMessage(chatId, msgId); } catch (_) {}
  };
  if (delay) setTimeout(fn, delay);
  else fn();
}

function resetSilence(telegram, chatId) {
  if (silenceTimers[chatId]) clearTimeout(silenceTimers[chatId]);
  silenceTimers[chatId] = setTimeout(async () => {
    // Pick angle, never repeat back to back
    let angle;
    do { angle = Math.floor(Math.random() * SILENCE_ANGLES.length); }
    while (angle === lastSilenceAngle && SILENCE_ANGLES.length > 1);
    lastSilenceAngle = angle;

    // Delete previous silence message
    if (lastSilenceMsgId[chatId]) {
      delMsg(telegram, chatId, lastSilenceMsgId[chatId]);
      delete lastSilenceMsgId[chatId];
    }

    try {
      const sent = await telegram.sendPhoto(
        chatId,
        { source: fs.createReadStream(IMAGE) },
        { caption: SILENCE_ANGLES[angle] }
      );
      lastSilenceMsgId[chatId] = sent.message_id;
    } catch (_) {}

    resetSilence(telegram, chatId);
  }, SILENCE_MS);
}

async function ai(prompt) {
  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: prompt },
      ],
      max_tokens: 200,
    });
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch (_) {
    return null;
  }
}

// --- Triggers ---
const CA_RE      = /\b(ca|contract|address|addy)\b|^\/ca$/i;
const SOCIALS_RE = /\b(socials|links)\b|^\/socials$|^\/links$/i;
const TWITTER_RE = /\b(twitter)\b|^\/x$|^\/twitter$|^x$/i;
const IGNORE_RE  = /^(gm|gn|lol|nice|wow|ok|based|fr|lfg|wagmi|ngmi|fomo|dyor|nfa|wen|soon|yes|no|pump|dump|moon|hold|hodl|buy|sell|ape|chad|rekt|fud|shill|ez|cope|ser|anon|bro|fam|gg|kek|fire|lit|up only|bullish|bearish|imagine|same|facts|true|this|real|100|sheesh|damn|haha|lmao|legend|goat|king|queen|grind|bless|1000x|100x|x100)$/i;
const HYPE_RE    = /^(let'?s go+!*|lfg+!*|send it+!*|to the moon+!*|we'?re so back|up only!*|this is it!*|we're gonna make it|gm everyone|good morning|good night)$/i;
const QUESTION_RE = /\?|what|who|when|where|why|how|tell me|explain|is there|does|do you|are you|will|should|can you|could you/i;

// --- New member welcome ---
bot.on("new_chat_members", async (ctx) => {
  const chatId = ctx.chat.id;
  resetSilence(ctx.telegram, chatId);

  // Delete service "X joined" message
  try { await ctx.deleteMessage(); } catch (_) {}

  // Delete previous welcome
  if (welcomeMsgIds[chatId]) {
    delMsg(ctx.telegram, chatId, welcomeMsgIds[chatId]);
    delete welcomeMsgIds[chatId];
  }

  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;
    const name = member.first_name || "hunter";
    const prompt =
      "New member '" + name + "' just joined the FURTUNE (" + TICKER + ") Telegram group. " +
      "Write a 1-2 line welcome only. Short, warm, real. Tie in the Cai Fu lore naturally. " +
      "Never start with Hello or Welcome. Never be corporate. Never output any URLs or links. " +
      "Never say: vibrant, embark, thrilling, do not hesitate, feel free. " +
      "No emojis after the name. Vary the opener every single time.";

    const greeting = await ai(prompt);
    if (!greeting || greeting === "IGNORE") continue;

    const welcome =
      greeting + "\n\n" +
      "\u{1F4C8} <a href=\"" + CHART + "\">Chart</a>  |  " +
      "\u{1F95E} <a href=\"" + BUY_LINK + "\">Buy</a>\n" +
      "CA: <code>" + CA + "</code>";

    try {
      const sent = await ctx.telegram.sendMessage(chatId, welcome, { parse_mode: "HTML", disable_web_page_preview: true });
      welcomeMsgIds[chatId] = sent.message_id;
      delMsg(ctx.telegram, chatId, sent.message_id, 60000);
    } catch (_) {}
  }
});

// --- All messages ---
bot.on("message", async (ctx) => {
  if (!ctx.message?.text) return;

  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  const text   = ctx.message.text.trim();
  const msgId  = ctx.message.message_id;

  resetSilence(ctx.telegram, chatId);

  const admin = await isAdmin(ctx.telegram, chatId, userId);

  // --- Anti-link ---
  if (!admin) {
    const hasLink =
      /https?:\/\/|t\.me\//.test(text) ||
      (/@[a-zA-Z0-9_]{5,}/.test(text) && !text.startsWith("/"));

    if (hasLink) {
      try { await ctx.deleteMessage(); } catch (_) {}
      try {
        const w = await ctx.reply("External links are not allowed here.");
        delMsg(ctx.telegram, chatId, w.message_id, 10000);
      } catch (_) {}
      return;
    }

    // --- Anti-spam: 5 msgs in 60s ---
    const now   = Date.now();
    const entry = spamTracker[userId] || { count: 0, start: now };
    if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
    entry.count++;
    spamTracker[userId] = entry;

    if (entry.count > 5) {
      try {
        await ctx.telegram.restrictChatMember(chatId, userId, {
          permissions: { can_send_messages: false },
          until_date: Math.floor(now / 1000) + 300,
        });
        try { await ctx.deleteMessage(); } catch (_) {}
        const w = await ctx.reply("Spam detected. Muted for 5 minutes.");
        delMsg(ctx.telegram, chatId, w.message_id, 15000);
      } catch (_) {}
      return;
    }
  }

  // --- CA trigger ---
  if (CA_RE.test(text)) {
    if (lastCaMsgId[chatId]) {
      delMsg(ctx.telegram, chatId, lastCaMsgId[chatId]);
      delete lastCaMsgId[chatId];
    }

    // Pick non-repeating index
    let idx;
    do { idx = Math.floor(Math.random() * CA_OPENERS.length); }
    while (idx === lastCaIdx && CA_OPENERS.length > 1);
    lastCaIdx = idx;

    const cap =
      CA_OPENERS[idx] + "\n\n" +
      CA + "\n\n" +
      CA_CLOSERS[idx];

    try {
      const sent = await ctx.telegram.sendPhoto(
        chatId,
        { source: fs.createReadStream(IMAGE) },
        {
          caption: cap,
          reply_markup: {
            inline_keyboard: [[
              { text: "\u{1F4CB} Copy CA", copy_text: { text: CA } }
            ]]
          }
        }
      );
      lastCaMsgId[chatId] = sent.message_id;
    } catch (_) {}
    return;
  }

  // --- Socials trigger ---
  if (SOCIALS_RE.test(text)) {
    const socials =
      "\u{1F30D} <b>" + TICKER + " Official Links</b>\n\n" +
      "\u{1F426} <a href=\"" + TWITTER + "\">Twitter / X</a>\n" +
      "\u{1F4C8} <a href=\"" + CHART + "\">Chart (DexScreener)</a>\n" +
      "\u{1F95E} <a href=\"" + BUY_LINK + "\">Buy on PancakeSwap</a>\n\n" +
      "Always verify links before connecting your wallet. \u2705";
    try {
      await ctx.telegram.sendMessage(chatId, socials, { parse_mode: "HTML", disable_web_page_preview: true });
    } catch (_) {}
    return;
  }

  // --- X/Twitter trigger ---
  if (TWITTER_RE.test(text)) {
    try {
      await ctx.telegram.sendPhoto(
        chatId,
        { source: fs.createReadStream(IMAGE) },
        { caption: "\u{1F426} Follow the hunt on X\n\n" + TWITTER }
      );
    } catch (_) {}
    return;
  }

  // --- Ignore casual, hype, short messages ---
  if (IGNORE_RE.test(text)) return;
  if (HYPE_RE.test(text)) return;
  if (text.length < 8) return;

  // --- Only reply to genuine project questions ---
  if (!QUESTION_RE.test(text)) return;

  const reply = await ai(text);
  if (!reply || reply === "IGNORE") return;

  try {
    await ctx.reply(reply, { reply_to_message_id: msgId });
  } catch (_) {}
});

// --- Webhook mode + keep-alive on same port ---
bot.launch({
  webhook: {
    domain: WEBHOOK_URL,
    port: PORT,
    hookPath: "/webhook",
  }
}).then(() => {
  console.log(NAME + " bot live (webhook mode) on port " + PORT);
}).catch((err) => {
  console.error("Launch failed:", err.message);
  process.exit(1);
});

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// --- Global crash guard (prevents runtime errors from killing the process) ---
process.on("uncaughtException",  (err) => { console.error("Uncaught:", err.message); });
process.on("unhandledRejection", (err) => { console.error("Unhandled:", err && err.message ? err.message : err); });
