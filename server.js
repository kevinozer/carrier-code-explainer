/**
 * Carrier — Code Explainer (Cloud Run service).
 *
 * Vysvětlení a vizualizace kódu:
 *   POST /api/explain   — srozumitelné vysvětlení co kód dělá
 *   POST /api/document  — vygenerovaná dokumentace (Markdown)
 *   POST /api/diagram   — diagram kódu jako Mermaid (flowchart / sequence / class / callgraph)
 *   GET  /api/health
 *
 * GEMINI_API_KEY je v Cloud Run env (Secret Manager: veo-gemini-api-key). Browser ho nikdy nevidí.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);

const MODEL = 'gemini-2.5-pro';
const MODEL_FAST = 'gemini-2.5-flash';
const MAX_CODE = 120000;

const LANGS = { cs: 'Czech', en: 'English', sk: 'Slovak' };
function outLang(code) {
  return LANGS[code] || 'English';
}

const app = express();
app.use(express.json({ limit: '4mb' }));

async function gen({ apiKey, model, prompt, temperature = 0.3 }) {
  const ai = new GoogleGenAI({ apiKey });
  const models = [model, model === MODEL ? MODEL_FAST : MODEL];
  let lastErr;
  for (const m of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await ai.models.generateContent({
          model: m,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { temperature, maxOutputTokens: 8192 },
        });
        const text =
          resp.text ||
          (resp.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        if (text && text.trim()) return text.trim();
        throw new Error('Empty response');
      } catch (err) {
        lastErr = err;
        const msg = err?.message || '';
        const transient = /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|deadline|overloaded/i.test(msg);
        if (!transient && attempt === 1) break; // permanentní chyba -> rovnou fallback model
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw lastErr || new Error('Generation failed');
}

function validate(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY not configured on Cloud Run' });
    return null;
  }
  const { code } = req.body || {};
  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'code is required' });
    return null;
  }
  if (code.length > MAX_CODE) {
    res.status(400).json({ error: `code too long (max ${MAX_CODE} chars)` });
    return null;
  }
  return apiKey;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'carrier-code-explainer', model: MODEL });
});

// 1) Vysvětlení kódu
app.post('/api/explain', async (req, res) => {
  const apiKey = validate(req, res);
  if (!apiKey) return;
  try {
    const { code, language = 'cs', filename = '' } = req.body;
    const lang = outLang(language);
    const prompt = `You are a senior software engineer explaining code to a colleague. Detect the programming language automatically.
Explain the following code clearly and accurately in ${lang}. Base everything strictly on the code — never invent behavior that is not present.

Structure your answer as clean Markdown:
## Přehled / Overview
One short paragraph: what the code does and its purpose.
## Jak to funguje / How it works
A step-by-step walkthrough of the main logic (numbered or bulleted).
## Klíčové části / Key parts
The important functions / classes / blocks and the role of each.
## Vstupy a výstupy / Inputs and outputs
What it takes in and what it produces.
## Na co si dát pozor / Watch out
Edge cases, risks, side effects, or possible improvements (if any).

Write the headings and all content in ${lang}. Be precise and concise.
${filename ? `File name: ${filename}\n` : ''}
CODE:
\`\`\`
${code}
\`\`\``;
    const text = await gen({ apiKey, model: MODEL, prompt, temperature: 0.3 });
    res.json({ text });
  } catch (err) {
    console.error('[explain]', err);
    res.status(500).json({ error: err?.message || 'Explain failed' });
  }
});

// 2) Dokumentace
app.post('/api/document', async (req, res) => {
  const apiKey = validate(req, res);
  if (!apiKey) return;
  try {
    const { code, language = 'cs', filename = '' } = req.body;
    const lang = outLang(language);
    const prompt = `You are a senior software engineer writing developer documentation. Detect the programming language automatically.
Generate clear, professional documentation for the following code in ${lang}. Base it strictly on the code — do not invent APIs that are not present.

Output as clean Markdown suitable for a README / API reference:
# ${filename || 'Documentation'}
A short overview of the file/module and its responsibility.

For EACH public function / method / class, document:
### name(signature)
- short description of what it does
- **Parameters:** each parameter with type (if inferable) and meaning
- **Returns:** return value and type
- **Throws / errors:** notable error conditions (if any)

End with a short "## Usage" section with a minimal example if it is reasonable to infer one.

Write all prose in ${lang}; keep code identifiers and signatures as-is.
CODE:
\`\`\`
${code}
\`\`\``;
    const text = await gen({ apiKey, model: MODEL, prompt, temperature: 0.25 });
    res.json({ text });
  } catch (err) {
    console.error('[document]', err);
    res.status(500).json({ error: err?.message || 'Document failed' });
  }
});

// 3) Diagram (Mermaid)
const DIAGRAM_SPEC = {
  flowchart:
    "a FLOWCHART of the control flow. Start with 'flowchart TD'. Use rectangles for steps, diamonds {} for conditions/branches, and arrows with short labels for yes/no. Cover the main path, branches and loops.",
  sequence:
    "a SEQUENCE diagram of the interactions/calls between the main components or actors. Start with 'sequenceDiagram'. Use participants and ->> messages in call order.",
  class:
    "a CLASS diagram of the structure. Start with 'classDiagram'. Show classes/types, their key fields and methods, and relationships (inheritance, composition) where present.",
  callgraph:
    "a CALL GRAPH showing which function calls which. Start with 'flowchart LR'. One node per function; arrows from caller to callee.",
};

app.post('/api/diagram', async (req, res) => {
  const apiKey = validate(req, res);
  if (!apiKey) return;
  try {
    const { code, language = 'cs', type = 'flowchart' } = req.body;
    const lang = outLang(language);
    const spec = DIAGRAM_SPEC[type] || DIAGRAM_SPEC.flowchart;
    const prompt = `You are an expert at visualizing code as Mermaid.js diagrams. Detect the programming language automatically.
From the following code, produce ${spec}

STRICT OUTPUT RULES:
- Output ONLY valid Mermaid diagram code. No explanation, no prose, no markdown code fences.
- Keep node/label text SHORT (max ~6 words) and write labels in ${lang}.
- Escape problematic characters: put any node text containing spaces, punctuation, parentheses or quotes inside double quotes, e.g. A["volání funkce"].
- Make sure the syntax parses in Mermaid v10. Do not use unsupported features.
CODE:
\`\`\`
${code}
\`\`\``;
    let text = await gen({ apiKey, model: MODEL_FAST, prompt, temperature: 0.15 });
    // odstranit případné ```mermaid fence
    text = text.replace(/^```(?:mermaid)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    res.json({ mermaid: text, type });
  } catch (err) {
    console.error('[diagram]', err);
    res.status(500).json({ error: err?.message || 'Diagram failed' });
  }
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', index: 'index.html' }));

// Startup key check
const k = process.env.GEMINI_API_KEY;
if (!k) console.error('[server] !!! GEMINI_API_KEY chybi !!!');
else if (k.startsWith('PASTE_')) console.error('[server] !!! GEMINI_API_KEY je placeholder !!!');
else console.log('[server] GEMINI_API_KEY OK (' + k.slice(0, 8) + '...' + k.slice(-4) + ')');

app.listen(PORT, () => console.log(`[server] carrier-code-explainer :${PORT} (model ${MODEL})`));
