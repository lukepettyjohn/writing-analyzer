const path = require('path');
const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `window.SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || '')};\n` +
    `window.SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || '')};\n`
  );
});

app.get('/vendor/supabase.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
});

app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!supabase) {
  console.warn('Supabase not configured — submissions, feedback, and analytics will be unavailable.');
}

function buildClassCode(institution, year, teacherName) {
  return [institution, year, teacherName]
    .map(part => (part || '').trim().toUpperCase().replace(/\s+/g, '-'))
    .join('-');
}

function toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function normalizePatternKey(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function aggregatePatterns(rows) {
  const occurrences = {};
  const submissionsWithPattern = {};
  const displayNames = {};

  rows.forEach(row => {
    const namesInRow = new Set();
    (row.analyses || []).forEach(analysis => {
      (analysis.patterns || []).forEach(pattern => {
        if (!pattern || !pattern.name) return;
        const key = normalizePatternKey(pattern.name);
        occurrences[key] = (occurrences[key] || 0) + 1;
        namesInRow.add(key);
        if (!displayNames[key]) displayNames[key] = toTitleCase(pattern.name.trim());
      });
    });
    namesInRow.forEach(key => {
      submissionsWithPattern[key] = (submissionsWithPattern[key] || 0) + 1;
    });
  });

  const totalSubmissions = rows.length;
  const table = Object.keys(occurrences)
    .map(key => ({
      name: displayNames[key],
      occurrences: occurrences[key],
      percentOfSubmissions: totalSubmissions
        ? Math.round((submissionsWithPattern[key] / totalSubmissions) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  return { totalSubmissions, table };
}

function computeTrend(rows) {
  if (rows.length < 4) return null;

  const sorted = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const mid = Math.floor(sorted.length / 2);
  const earlier = sorted.slice(0, mid);
  const later = sorted.slice(mid);

  const avgPatterns = subset => {
    if (subset.length === 0) return 0;
    const total = subset.reduce((sum, row) => (
      sum + (row.analyses || []).reduce((s, a) => s + (a.patterns || []).length, 0)
    ), 0);
    return total / subset.length;
  };

  const earlierAvg = avgPatterns(earlier);
  const laterAvg = avgPatterns(later);
  const percentChange = earlierAvg === 0 ? null : Math.round(((laterAvg - earlierAvg) / earlierAvg) * 1000) / 10;

  return {
    earlierAvgPatterns: Math.round(earlierAvg * 10) / 10,
    laterAvgPatterns: Math.round(laterAvg * 10) / 10,
    percentChange,
    direction: laterAvg < earlierAvg ? 'improving' : laterAvg > earlierAvg ? 'worsening' : 'stable',
  };
}

function computePeerComparison(institutionRows, teacherRows, teacherName) {
  const normalizedTeacher = teacherName.trim().toUpperCase();
  const teacherPatternNames = new Set();

  const teacherPatternDisplayNames = {};

  teacherRows.forEach(row => {
    (row.analyses || []).forEach(analysis => {
      (analysis.patterns || []).forEach(pattern => {
        if (!pattern || !pattern.name) return;
        const key = normalizePatternKey(pattern.name);
        teacherPatternNames.add(key);
        if (!teacherPatternDisplayNames[key]) teacherPatternDisplayNames[key] = toTitleCase(pattern.name.trim());
      });
    });
  });

  const results = [];
  teacherPatternNames.forEach(key => {
    const otherTeachers = new Set();
    institutionRows.forEach(row => {
      if ((row.teacher_name || '').trim().toUpperCase() === normalizedTeacher) return;
      const hasPattern = (row.analyses || []).some(analysis => (
        (analysis.patterns || []).some(pattern => pattern && normalizePatternKey(pattern.name) === key)
      ));
      if (hasPattern) otherTeachers.add((row.teacher_name || '').trim().toUpperCase());
    });
    if (otherTeachers.size >= 3) {
      results.push({ pattern: teacherPatternDisplayNames[key], otherTeacherCount: otherTeachers.size });
    }
  });

  return results.sort((a, b) => b.otherTeacherCount - a.otherTeacherCount);
}

async function getAuthedEmail(req) {
  if (!supabase) return null;

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.email || null;
  } catch (error) {
    console.error('Failed to verify auth token:', error);
    return null;
  }
}

function teacherOwnerKey(institution, teacherName) {
  return {
    institution: (institution || '').trim().toLowerCase(),
    teacher_name: (teacherName || '').trim().toLowerCase(),
  };
}

async function getTeacherClaim(institution, teacherName) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('teacher_owners')
    .select('email')
    .match(teacherOwnerKey(institution, teacherName))
    .maybeSingle();

  if (error) {
    console.error('Failed to look up teacher claim:', error);
    return null;
  }

  return data ? data.email : null;
}

async function claimTeacherIfNeeded(institution, teacherName, email) {
  if (!supabase || !institution || !teacherName || !email) return;

  const { error } = await supabase
    .from('teacher_owners')
    .upsert(
      { ...teacherOwnerKey(institution, teacherName), email: email.toLowerCase() },
      { onConflict: 'institution,teacher_name', ignoreDuplicates: true }
    );

  if (error) {
    console.error('Failed to claim teacher identity:', error);
  }
}

async function saveSubmission({ text, institution, teacherName, analysis, teacherEmail }) {
  if (!supabase) return null;
  if (!institution || !teacherName) return null;

  const now = new Date();
  const year = String(now.getFullYear());

  const { data: submission, error: submissionError } = await supabase
    .from('submissions')
    .insert({
      essay_text: text,
      institution,
      year,
      teacher_name: teacherName,
      teacher_email: teacherEmail || null,
      timestamp: now.toISOString(),
    })
    .select()
    .single();

  if (submissionError) {
    console.error('Failed to save submission:', submissionError);
    return null;
  }

  const { error: analysisError } = await supabase
    .from('analyses')
    .insert({
      submission_id: submission.id,
      patterns: analysis.patterns || [],
      summary: analysis.summary || null,
    });

  if (analysisError) {
    console.error('Failed to save analysis:', analysisError);
  }

  if (teacherEmail) {
    await claimTeacherIfNeeded(institution, teacherName, teacherEmail);
  }

  return submission;
}

const systemPrompt = `You are an expert writing teacher analyzing student reasoning patterns.

Analyze the following student writing for reasoning issues.

Look for these patterns:

Unsupported Claims: Assertions made without evidence or reasoning
- Example: "Social media is bad for teenagers"
- Problem: Reader doesn't know why you believe this

Logical Jumps: Missing steps between premise and conclusion
- Example: "Climate change is real, therefore we should ban cars"
- Problem: The connection isn't explained. Why cars specifically?

Unexamined Assumptions: Things taken as true without questioning
- Example: "Everyone knows that X is true"
- Problem: Not everyone knows this. You need to explain and support it

Circular Reasoning: Using the conclusion as evidence for itself
- Example: "Social media is addictive because it keeps people using it"
- Problem: You're just restating, not explaining

Cherry-Picking Evidence: Only using facts that support your view
- Example: Student cites 3 studies supporting their view, ignores 10 contradicting ones
- Problem: Not considering counterarguments or full picture

False Dilemma: Presenting only two options when more exist
- Example: "Either we ban social media or society collapses"
- Problem: Other options exist (regulation, moderation, education)

Appeal to Authority: Using someone's status instead of reasoning
- Example: "This must be true because [famous person] said so"
- Problem: Authority doesn't replace logical reasoning

Overgeneralization: Making broad claims from limited examples
- Example: "My friend got sick from that food, so that restaurant is unsafe"
- Problem: One case doesn't prove a general rule

For EACH pattern you find:
1. Pattern name — must be EXACTLY one of the eight names above, copied verbatim (same spelling, capitalization, and singular/plural form). Do not paraphrase or reformat it.
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

async function getAnalysisFromClaude(text) {
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Analyze this student writing:\n\n${text}`
        }
      ],
    });

    const textBlock = message.content.find(block => block.type === 'text');
    const responseText = textBlock ? textBlock.text : '';

    let clean = responseText.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(clean);
      if (Array.isArray(parsed.patterns)) {
        parsed.patterns.forEach(pattern => {
          if (pattern && pattern.name) {
            pattern.name = toTitleCase(pattern.name.trim());
          }
        });
      }
      return parsed;
    } catch (parseError) {
      lastError = parseError;
      console.error(`JSON.parse failed on Claude response (attempt ${attempt}/${maxAttempts}):`, {
        stopReason: message.stop_reason,
        contentBlockTypes: message.content.map(block => block.type),
        length: responseText.length,
        preview: responseText.slice(0, 300),
        tail: responseText.slice(-300),
      });
    }
  }

  throw lastError;
}

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
    const { text, institution, teacherName } = req.body;

    if (!text || text.trim().length < 50) {
      return res.json({
        error: 'Please provide at least 50 characters of student writing'
      });
    }

    const analysis = await getAnalysisFromClaude(text);

    const teacherEmail = await getAuthedEmail(req);
    const submission = await saveSubmission({ text, institution, teacherName, analysis, teacherEmail });
    if (submission) {
      analysis.submissionId = submission.id;
      analysis.classCode = buildClassCode(institution, submission.year, teacherName);
    }

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

    const { institution, teacherName } = req.body;

    const text = await extractTextFromFile(req.file);

    if (!text) {
      return res.json({ error: 'Only .docx files supported.' });
    }

    if (text.trim().length < 50) {
      return res.json({
        error: 'Document has less than 50 characters of text. Make sure it\'s a real essay.'
      });
    }

    const analysis = await getAnalysisFromClaude(text);

    const teacherEmail = await getAuthedEmail(req);
    const submission = await saveSubmission({ text, institution, teacherName, analysis, teacherEmail });
    if (submission) {
      analysis.submissionId = submission.id;
      analysis.classCode = buildClassCode(institution, submission.year, teacherName);
    }

    res.json(analysis);

  } catch (error) {
    console.error('Upload error:', error);
    res.json({
      error: 'Failed to process file. Try a different file or paste text instead.'
    });
  }
});

app.post('/feedback', async (req, res) => {
  try {
    if (!supabase) {
      return res.json({ error: 'Feedback storage is not configured yet.' });
    }

    const { submissionId, accurate, useful, comments, suggestions } = req.body;

    const { error } = await supabase
      .from('feedback')
      .insert({
        submission_id: submissionId || null,
        accurate: accurate === null || accurate === undefined ? null : Boolean(accurate),
        useful: useful === null || useful === undefined ? null : Boolean(useful),
        comments: comments || null,
        suggestions: suggestions || null,
      });

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Feedback error:', error);
    res.json({ error: 'Failed to save feedback.' });
  }
});

app.get('/analytics', async (req, res) => {
  try {
    if (!supabase) {
      return res.json({ error: 'Analytics storage is not configured yet.' });
    }

    const institution = (req.query.institution || '').trim();
    const year = (req.query.year || '').trim();
    const teacherName = (req.query.teacherName || '').trim();

    if (!institution) {
      return res.json({ error: 'Institution is required.' });
    }

    const { data, error } = await supabase
      .from('submissions')
      .select('id, institution, year, teacher_name, created_at, analyses(patterns, summary)')
      .ilike('institution', institution);

    if (error) throw error;

    const institutionRows = data || [];
    const yearRows = year
      ? institutionRows.filter(row => (row.year || '').trim().toUpperCase() === year.toUpperCase())
      : [];
    const teacherRows = (year && teacherName)
      ? yearRows.filter(row => (row.teacher_name || '').trim().toUpperCase() === teacherName.toUpperCase())
      : [];

    const response = {
      institution: { name: institution, ...aggregatePatterns(institutionRows) },
    };

    if (year) {
      response.year = { institution, year, ...aggregatePatterns(yearRows) };
    }

    if (year && teacherName) {
      const claimEmail = await getTeacherClaim(institution, teacherName);
      const authedEmail = claimEmail ? await getAuthedEmail(req) : null;
      const isOwner = !claimEmail || (authedEmail && authedEmail.toLowerCase() === claimEmail.toLowerCase());

      if (!isOwner) {
        response.teacherLocked = true;
      } else {
        response.teacherLocked = false;

        const teacherAgg = aggregatePatterns(teacherRows);
        const totalPatternCount = teacherRows.reduce((sum, row) => (
          sum + (row.analyses || []).reduce((s, a) => s + (a.patterns || []).length, 0)
        ), 0);

        response.teacher = {
          institution,
          year,
          teacherName,
          classCode: buildClassCode(institution, year, teacherName),
          ...teacherAgg,
          avgPatternsPerSubmission: teacherAgg.totalSubmissions
            ? Math.round((totalPatternCount / teacherAgg.totalSubmissions) * 10) / 10
            : 0,
          trend: computeTrend(teacherRows),
        };

        response.peerComparison = computePeerComparison(institutionRows, teacherRows, teacherName);
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Analytics error:', error);
    res.json({ error: 'Failed to load analytics.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
