const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const multer = require('multer');
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const systemPrompt = `You are an expert writing teacher analyzing student reasoning patterns.

Analyze the following student writing for reasoning issues.

Look for these patterns:

UNSUPPORTED CLAIMS: Assertions made without evidence or reasoning
- Example: "Social media is bad for teenagers"
- Problem: Reader doesn't know why you believe this

LOGICAL JUMPS: Missing steps between premise and conclusion
- Example: "Climate change is real, therefore we should ban cars"
- Problem: The connection isn't explained. Why cars specifically?

UNEXAMINED ASSUMPTIONS: Things taken as true without questioning
- Example: "Everyone knows that X is true"
- Problem: Not everyone knows this. You need to explain and support it

CIRCULAR REASONING: Using the conclusion as evidence for itself
- Example: "Social media is addictive because it keeps people using it"
- Problem: You're just restating, not explaining

CHERRY-PICKING EVIDENCE: Only using facts that support your view
- Example: Student cites 3 studies supporting their view, ignores 10 contradicting ones
- Problem: Not considering counterarguments or full picture

FALSE DILEMMA: Presenting only two options when more exist
- Example: "Either we ban social media or society collapses"
- Problem: Other options exist (regulation, moderation, education)

APPEAL TO AUTHORITY: Using someone's status instead of reasoning
- Example: "This must be true because [famous person] said so"
- Problem: Authority doesn't replace logical reasoning

OVERGENERALIZATION: Making broad claims from limited examples
- Example: "My friend got sick from that food, so that restaurant is unsafe"
- Problem: One case doesn't prove a general rule

For EACH pattern you find:
1. Pattern name
2. The exact quote/excerpt from the text
3. Why this is a reasoning problem
4. What the student might be thinking (be kind—diagnose, don't judge)

Output ONLY valid JSON, no other text. Format:

{
  "patterns": [
    {
      "name": "Pattern Name",
      "excerpt": "exact text from essay",
      "why_its_a_problem": "explanation",
      "likely_cause": "what student might be thinking"
    }
  ],
  "summary": "1-2 sentence summary of main reasoning issues"
}`;

async function extractTextFromFile(file) {
  try {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.originalname.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return result.value;
    } else {
      return null;
    }
  } catch (error) {
    console.error('File extraction error:', error);
    return null;
  }
}

app.post('/analyze', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length < 50) {
      return res.json({
        error: 'Please provide at least 50 characters of student writing'
      });
    }

    const message = await client.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Analyze this student writing:\n\n${text}`
        }
      ],
    });

    const responseText = message.content[0].type === 'text'
      ? message.content[0].text
      : '';

    const analysis = JSON.parse(responseText);
    res.json(analysis);

  } catch (error) {
    console.error('Error:', error);
    res.json({
      error: 'Failed to analyze. Make sure you have a valid API key.'
    });
  }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ error: 'No file uploaded' });
    }

    const text = await extractTextFromFile(req.file);

    if (!text) {
      return res.json({ error: 'Only .docx files supported.' });
    }

    if (text.trim().length < 50) {
      return res.json({
        error: 'Document has less than 50 characters of text. Make sure it\'s a real essay.'
      });
    }

    const message = await client.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Analyze this student writing:\n\n${text}`
        }
      ],
    });

    const responseText = message.content[0].type === 'text'
      ? message.content[0].text
      : '';

    const analysis = JSON.parse(responseText);
    res.json(analysis);

  } catch (error) {
    console.error('Upload error:', error);
    res.json({
      error: 'Failed to process file. Try a different file or paste text instead.'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
