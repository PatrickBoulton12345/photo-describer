/**
 * brand-voice.js
 * GET  /api/brand-voice  — Retrieve the authenticated user's brand voice
 * POST /api/brand-voice  — Create or update the user's brand voice
 *
 * The brand_voices table holds one row per user (upserted on POST).
 * Auth: Bearer token required.
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ------------------------------------------------------------------
  // 1. Authenticate the request
  // ------------------------------------------------------------------
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Missing authorisation token' });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // ------------------------------------------------------------------
  // GET — Return the user's existing brand voice (null if none set)
  // ------------------------------------------------------------------
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('brand_voices')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code === 'PGRST116') {
      // No row found — return empty object rather than 404
      return res.status(200).json({ brandVoice: null });
    }

    if (error) {
      console.error('Error fetching brand voice:', error);
      return res.status(500).json({ error: 'Failed to retrieve brand voice' });
    }

    return res.status(200).json({ brandVoice: data });
  }

  // ------------------------------------------------------------------
  // POST — Upsert brand voice
  // ------------------------------------------------------------------
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { toneDescription, exampleDescriptions } = body;

  if (!toneDescription || typeof toneDescription !== 'string') {
    return res.status(400).json({
      error: 'toneDescription is required and must be a string',
    });
  }

  if (exampleDescriptions !== undefined && !Array.isArray(exampleDescriptions)) {
    return res.status(400).json({
      error: 'exampleDescriptions must be an array of strings when provided',
    });
  }

  // Validate individual example strings
  if (Array.isArray(exampleDescriptions)) {
    for (const ex of exampleDescriptions) {
      if (typeof ex !== 'string') {
        return res.status(400).json({
          error: 'Each item in exampleDescriptions must be a string',
        });
      }
    }
  }

  const upsertData = {
    user_id: user.id,
    tone_description: toneDescription.trim(),
    example_descriptions: exampleDescriptions || [],
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('brand_voices')
    .upsert(upsertData, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    console.error('Error upserting brand voice:', error);
    return res.status(500).json({ error: 'Failed to save brand voice' });
  }

  return res.status(200).json({ brandVoice: data });
};
