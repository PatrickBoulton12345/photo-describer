/**
 * generate-bulk.js
 * POST /api/generate-bulk
 *
 * Processes a batch of product rows sequentially through the Groq API to
 * produce platform-specific e-commerce copy for each row.
 *
 * Auth: Bearer token verified against Supabase.
 * Limit: Max 500 rows per request.
 * Usage: Each successfully generated row consumes one credit/description.
 */

const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Platform-specific output instructions
// ---------------------------------------------------------------------------
const PLATFORM_INSTRUCTIONS = {
  ebay: `You are an expert eBay seller and e-commerce copywriter.
Return a JSON object with EXACTLY these keys:
- title: string, max 80 characters, keyword-rich eBay listing title
- subtitle: string, max 55 characters, optional subtitle
- itemSpecifics: object, key-value pairs of relevant item specifics
- description: string, HTML-formatted listing description
- conditionDescription: string, brief condition notes`,

  etsy: `You are an expert Etsy seller and creative copywriter.
Return a JSON object with EXACTLY these keys:
- title: string, max 140 characters
- description: string, engaging multi-paragraph description
- tags: array of exactly 13 strings, each max 20 characters
- sectionSuggestion: string, suggested shop section name`,

  amazon: `You are an expert Amazon FBA seller and product copywriter.
Return a JSON object with EXACTLY these keys:
- title: string, max 200 characters
- bulletPoints: array of exactly 5 strings
- description: string, detailed product description
- searchTerms: string, comma-separated backend keywords (max 250 chars)`,

  shopify: `You are an expert Shopify e-commerce copywriter and SEO specialist.
Return a JSON object with EXACTLY these keys:
- seoTitle: string, max 70 characters
- metaDescription: string, max 160 characters
- description: string, HTML-formatted product description
- tags: array of strings`,

  generic: `You are an expert e-commerce copywriter.
Return a JSON object with EXACTLY this key:
- description: string, a compelling product description`,
};

/**
 * Generates listing content for a single product row.
 * Returns the parsed JSON output or throws on failure.
 */
async function generateForRow(row, platform) {
  const platformInstruction =
    PLATFORM_INSTRUCTIONS[platform] || PLATFORM_INSTRUCTIONS.generic;

  const systemPrompt = `${platformInstruction}

IMPORTANT: Your entire response must be valid JSON only — no markdown code fences, no commentary, no additional text.`;

  const contextLines = [];
  if (row.name) contextLines.push(`Product Name: ${row.name}`);
  if (row.category) contextLines.push(`Category: ${row.category}`);
  if (row.features) contextLines.push(`Key Features: ${row.features}`);
  if (row.price) contextLines.push(`Price: ${row.price}`);

  const userMessage = `Please generate ${platform} listing content for the following product:

${contextLines.join('\n')}

Return only valid JSON matching the specified format.`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    }),
  });

  if (!groqRes.ok) {
    const errBody = await groqRes.text();
    throw new Error(`Groq API returned ${groqRes.status}: ${errBody}`);
  }

  const groqResponse = await groqRes.json();
  const rawText = groqResponse.choices[0]?.message?.content || '';
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
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
  // 2. Parse and validate the request body
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

  const { rows, platform = 'generic' } = body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }

  if (rows.length > 500) {
    return res.status(400).json({ error: 'Maximum 500 rows per bulk request' });
  }

  const validPlatforms = ['ebay', 'etsy', 'amazon', 'shopify', 'generic'];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({
      error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}`,
    });
  }

  // ------------------------------------------------------------------
  // 3. Check user has enough credits / subscription quota for all rows
  // ------------------------------------------------------------------
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select(
      'subscription_plan, subscription_status, descriptions_used_this_cycle, monthly_description_limit, credits_balance'
    )
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  const hasActiveSubscription =
    profile.subscription_status === 'active' &&
    profile.subscription_plan !== 'none';

  // Calculate how many descriptions are available from the subscription
  const subscriptionRemaining = hasActiveSubscription
    ? Math.max(0, profile.monthly_description_limit - profile.descriptions_used_this_cycle)
    : 0;

  const creditsRemaining =
    typeof profile.credits_balance === 'number' ? profile.credits_balance : 0;

  const totalAvailable = subscriptionRemaining + creditsRemaining;

  if (totalAvailable < rows.length) {
    return res.status(402).json({
      error: `Insufficient credits. You need ${rows.length} but have ${totalAvailable} available.`,
    });
  }

  // ------------------------------------------------------------------
  // 4. Process rows sequentially
  // ------------------------------------------------------------------
  const results = [];
  let succeeded = 0;
  let failed = 0;

  // Track how many subscription descriptions we've used in this batch
  let subscriptionUsed = 0;
  let creditsUsed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    try {
      const output = await generateForRow(row, platform);

      results.push({ row, output, success: true });
      succeeded += 1;

      // Determine whether to charge subscription or credits
      if (subscriptionUsed < subscriptionRemaining) {
        subscriptionUsed += 1;
      } else {
        creditsUsed += 1;
      }

      // Save individual generation record
      await supabase.from('generations').insert({
        user_id: user.id,
        platform,
        input_type: 'bulk',
        input_context: row,
        output,
      });
    } catch (rowErr) {
      console.error(`Bulk generation error for row ${i}:`, rowErr.message);
      results.push({
        row,
        output: null,
        success: false,
        error: rowErr.message || 'Generation failed',
      });
      failed += 1;
    }
  }

  // ------------------------------------------------------------------
  // 5. Update usage counters in a single write
  // ------------------------------------------------------------------
  const profileUpdates = {};
  if (subscriptionUsed > 0) {
    profileUpdates.descriptions_used_this_cycle =
      profile.descriptions_used_this_cycle + subscriptionUsed;
  }
  if (creditsUsed > 0) {
    profileUpdates.credits_balance = creditsRemaining - creditsUsed;
  }
  if (Object.keys(profileUpdates).length > 0) {
    await supabase.from('profiles').update(profileUpdates).eq('id', user.id);
  }

  // ------------------------------------------------------------------
  // 6. Return results with summary
  // ------------------------------------------------------------------
  return res.status(200).json({
    results,
    summary: {
      total: rows.length,
      succeeded,
      failed,
    },
  });
};
