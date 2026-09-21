const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimit');
const { isAiEnabled, aiEnvConfigured } = require('../lib/aiConfig');

const router = express.Router();

// The model name lives in an env var on purpose (per the deployment notes in
// render.yaml) so it can be changed - to a newer or cheaper model - without a code
// change or redeploy of anything but the env var itself. Claude Haiku 4.5 is
// Anthropic's current small/fast/low-cost model as of this writing.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// Cost/abuse guardrails (env-configurable, see render.yaml) - read live rather than
// cached at startup, so changing them on Render only ever needs a redeploy, never a
// code change. Character-based because that is what actually drives the Claude API
// bill; request-based on top of it stops a runaway loop of tiny requests from
// slipping under the character limit.
function dailyCharLimit() { return Number(process.env.AI_DAILY_CHAR_LIMIT) || 150000; }
function dailyRequestLimit() { return Number(process.env.AI_DAILY_REQUEST_LIMIT) || 1000; }
// One paragraph's worth of speech, generously - never a whole sermon in a single call.
const MAX_TEXT_LEN = 4000;

let client = null;
function getClient() {
    if (!client && process.env.ANTHROPIC_API_KEY) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
}

const LANG_NAMES = { en: 'English', de: 'German', tw: 'Twi', kri: 'Krio (Sierra Leone)' };
// Claude's Krio and Twi are noticeably less reliable than its English/German - any
// translation touching either of these is always labelled a draft for the user to check.
const LOWER_CONFIDENCE_LANGS = new Set(['kri', 'tw']);

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

async function withinDailyLimit(userId, textLen) {
    const row = await db.prepare('SELECT requests, chars_in FROM ai_usage WHERE user_id = ? AND day = ?').get(userId, todayStr());
    const requests = row ? row.requests : 0;
    const charsIn = row ? row.chars_in : 0;
    return (requests + 1 <= dailyRequestLimit()) && (charsIn + textLen <= dailyCharLimit());
}

async function recordUsage(userId, charsIn, charsOut) {
    await db.prepare(
        `INSERT INTO ai_usage (user_id, day, requests, chars_in, chars_out) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (user_id, day) DO UPDATE SET
           requests = ai_usage.requests + 1,
           chars_in = ai_usage.chars_in + excluded.chars_in,
           chars_out = ai_usage.chars_out + excluded.chars_out`
    ).run(userId, todayStr(), charsIn, charsOut);
}

// One call does both correction and translation when both are wanted, instead of two
// separate API calls - half the requests and, since the model reads the text once,
// noticeably fewer input tokens for the same work. Deliberately plain prompt-and-parse
// rather than the SDK's structured-output helper (which needs a Zod schema) - for a
// two-field response this is simpler and adds no dependency, at the cost of needing
// the defensive parser below.
function buildPrompt({ text, lang, correct, translateTo }) {
    const langName = LANG_NAMES[lang] || lang;
    const wantTranslation = !!(translateTo && translateTo !== 'none' && translateTo !== lang);
    const toName = wantTranslation ? (LANG_NAMES[translateTo] || translateTo) : null;

    const lines = [
        `You are proofreading a live speech-to-text transcript of a church sermon or its typed notes, in ${langName}.`
    ];
    if (correct) {
        lines.push(
            'Task "corrected": produce a corrected version of the text - fix spelling, grammar, punctuation and capitalization; remove accidental repeated words and filler noises ("um", "uh", stutters); fix Bible book names and chapter/verse numbers that a listening error clearly mangled.',
            'Never add ideas or information that are not in the original. Never change the meaning. Never alter the wording of a quoted Bible verse or the spelling of a proper name beyond an obvious mishearing.',
            'If you are not confident a change is correct, leave that part exactly as given.'
        );
    }
    if (wantTranslation) {
        lines.push(`Task "translated": translate ${correct ? 'the corrected text' : 'the text'} into ${toName}, preserving meaning and tone as closely as possible.`);
    }
    lines.push(
        'Respond with ONLY one JSON object and nothing else - no markdown fences, no commentary - with exactly these keys:',
        JSON.stringify({ corrected: correct ? '<corrected text>' : null, translated: wantTranslation ? '<translated text>' : null })
    );
    return lines.join('\n');
}

function safeParseJson(raw) {
    if (!raw) return null;
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
    res.json({ ok: true, enabled: await isAiEnabled() });
}));

router.post('/process', requireAuth, aiLimiter, asyncHandler(async (req, res) => {
    if (!(await isAiEnabled())) {
        return res.status(503).json({ ok: false, error: 'AI features are currently turned off.' });
    }

    const text = String(req.body.text || '').slice(0, MAX_TEXT_LEN);
    const lang = String(req.body.lang || 'en');
    const correct = !!req.body.correct;
    const translateTo = req.body.translateTo ? String(req.body.translateTo) : null;
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'No text given.' });

    const wantTranslation = !!(translateTo && translateTo !== 'none' && translateTo !== lang);
    if (!correct && !wantTranslation) return res.json({ ok: true, corrected: null, translated: null, draft: false });

    if (!(await withinDailyLimit(req.user.id, text.length))) {
        return res.status(429).json({ ok: false, error: "You reached today's limit. The rest of your notes are still saved." });
    }

    const anthropic = getClient();
    if (!anthropic) return res.status(503).json({ ok: false, error: 'AI features are currently turned off.' });

    const system = buildPrompt({ text, lang, correct, translateTo });
    let corrected = null, translated = null, charsOut = 0;
    try {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system,
            messages: [{ role: 'user', content: text }]
        });
        const textBlock = response.content.find(b => b.type === 'text');
        const raw = textBlock ? textBlock.text : '';
        charsOut = raw.length;
        const parsed = safeParseJson(raw);
        if (parsed) {
            if (correct && typeof parsed.corrected === 'string' && parsed.corrected.trim()) corrected = parsed.corrected.trim();
            if (wantTranslation && typeof parsed.translated === 'string' && parsed.translated.trim()) translated = parsed.translated.trim();
        }
    } catch (e) {
        await recordUsage(req.user.id, text.length, 0);
        return res.status(502).json({ ok: false, error: 'The AI service is unavailable right now. Your original text is unchanged.' });
    }

    await recordUsage(req.user.id, text.length, charsOut);
    const draft = !!(translated && (LOWER_CONFIDENCE_LANGS.has(lang) || LOWER_CONFIDENCE_LANGS.has(translateTo)));
    res.json({ ok: true, corrected, translated, draft });
}));

module.exports = router;
