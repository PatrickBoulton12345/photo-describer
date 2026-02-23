/**
 * generate-text.js
 * POST /api/generate-text
 *
 * Text-only generation endpoint.  Accepts JSON product details and calls
 * the Groq API (without vision) to produce platform-specific e-commerce copy.
 *
 * Auth: Bearer token verified against Supabase.
 * Rate limit: 10 requests per minute per user (in-memory store).
 */

const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// In-memory rate-limit store (shared concept — each serverless instance
// maintains its own map, which is acceptable for this use case)
// ---------------------------------------------------------------------------
const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function isRateLimited(userId) {
  const now = Date.now();
  const entry = rateLimitStore.get(userId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(userId, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count += 1;
  return false;
}

// ---------------------------------------------------------------------------
// Platform-specific output instructions (mirrors generate-photo.js)
// ---------------------------------------------------------------------------
const PLATFORM_INSTRUCTIONS = {
  ebay: `You are an expert eBay seller and e-commerce copywriter.
Return a JSON object with EXACTLY these keys:
- title: string, max 80 characters, keyword-rich eBay listing title
- subtitle: string, max 55 characters, optional subtitle
- itemSpecifics: object, key-value pairs of relevant item specifics (brand, colour, size, material, etc.)
- description: string, HTML-formatted listing description (use <p>, <ul>, <li>, <b> tags)
- conditionDescription: string, brief condition notes (1-2 sentences)`,

  etsy: `You are an expert Etsy seller and creative copywriter.
Return a JSON object with EXACTLY these keys:
- title: string, max 140 characters, SEO-friendly Etsy title with key descriptors
- description: string, engaging multi-paragraph description with story and details
- tags: array of exactly 13 strings, each max 20 characters, for Etsy tags
- sectionSuggestion: string, suggested shop section name`,

  amazon: `You are an expert Amazon FBA seller and product copywriter.
Return a JSON object with EXACTLY these keys:
- title: string, max 200 characters, Amazon-style title with brand, product, key features
- bulletPoints: array of exactly 5 strings, each a concise benefit-led bullet point (start with ALL CAPS keyword)
- description: string, detailed product description paragraph
- searchTerms: string, comma-separated backend search keywords (max 250 characters total)`,

  shopify: `You are an expert Shopify e-commerce copywriter and SEO specialist.
Return a JSON object with EXACTLY these keys:
- seoTitle: string, max 70 characters, SEO page title
- metaDescription: string, max 160 characters, SEO meta description
- description: string, HTML-formatted product description with headings and bullet points
- tags: array of strings, Shopify product tags for filtering`,

  generic: `You are an expert e-commerce copywriter.
Return a JSON object with EXACTLY this key:
- description: string, a compelling product description suitable for any platform`,
};

function buildSystemPrompt(platform, brandVoice) {
  const platformInstruction =
    PLATFORM_INSTRUCTIONS[platform] || PLATFORM_INSTRUCTIONS.generic;

  let systemPrompt = `${platformInstruction}

IMPORTANT: Your entire response must be valid JSON only — no markdown code fences, no commentary, no additional text.`;

  if (brandVoice && brandVoice.toneDescription) {
    systemPrompt += `\n\nBRAND VOICE:\nTone: ${brandVoice.toneDescription}`;

    if (Array.isArray(brandVoice.examples) && brandVoice.examples.length > 0) {
      systemPrompt += `\n\nExample descriptions to match in style:\n`;
      brandVoice.examples.forEach((ex, i) => {
        systemPrompt += `\nExample ${i + 1}:\n${ex}\n`;
      });
    }
  }

  return systemPrompt;
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
  // 2. Rate limiting
  // ------------------------------------------------------------------
  if (isRateLimited(user.id)) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Maximum 10 requests per minute.',
    });
  }

  // ------------------------------------------------------------------
  // 3. Parse and validate the request body
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
  } catch (parseErr) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const {
    productName,
    category,
    features,
    price,
    targetAudience,
    platform = 'generic',
    brandVoice = null,
  } = body;

  // At least one descriptive field must be present
  if (!productName && !category && !features) {
    return res.status(400).json({
      error: 'Please provide at least a product name, category, or features',
    });
  }

  const validPlatforms = ['ebay', 'etsy', 'amazon', 'shopify', 'generic'];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({
      error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}`,
    });
  }

  // ------------------------------------------------------------------
  // 4. Check user credits / subscription quota
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

  const withinSubscriptionQuota =
    hasActiveSubscription &&
    profile.descriptions_used_this_cycle < profile.monthly_description_limit;

  const hasCredits =
    typeof profile.credits_balance === 'number' && profile.credits_balance > 0;

  if (!withinSubscriptionQuota && !hasCredits) {
    return res.status(402).json({
      error:
        'No remaining descriptions or credits. Please upgrade your plan or purchase more credits.',
    });
  }

  // ------------------------------------------------------------------
  // 5. Build the user message
  // ------------------------------------------------------------------
  const contextLines = [];
  if (productName) contextLines.push(`Product Name: ${productName}`);
  if (category) contextLines.push(`Category: ${category}`);
  if (features) contextLines.push(`Key Features: ${features}`);
  if (price) contextLines.push(`Price: ${price}`);
  if (targetAudience) contextLines.push(`Target Audience: ${targetAudience}`);

  const userMessage = `Please generate ${platform} listing content for the following product:

${contextLines.join('\n')}

Return only valid JSON matching the specified format.`;

  // ------------------------------------------------------------------
  // 6. Call the Groq API (text only)
  // ------------------------------------------------------------------
  const systemPrompt = buildSystemPrompt(platform, brandVoice);

  let groqResponse;
  try {
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
      console.error('Groq API error response:', errBody);
      throw new Error(`Groq API returned ${groqRes.status}`);
    }

    groqResponse = await groqRes.json();
  } catch (groqErr) {
    console.error('Groq API error:', groqErr);
    return res.status(502).json({ error: 'Failed to call AI service. Please try again.' });
  }

  // ------------------------------------------------------------------
  // 7. Parse the Groq JSON response
  // ------------------------------------------------------------------
  const rawText = groqResponse.choices[0]?.message?.content || '';
  let generatedContent;

  try {
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    generatedContent = JSON.parse(cleaned);
  } catch (jsonErr) {
    console.error('Failed to parse Claude response as JSON:', rawText);
    return res.status(502).json({
      error: 'AI returned an unexpected response format. Please try again.',
    });
  }

  // ------------------------------------------------------------------
  // 8. Decrement usage / credits
  // ------------------------------------------------------------------
  if (withinSubscriptionQuota) {
    await supabase
      .from('profiles')
      .update({ descriptions_used_this_cycle: profile.descriptions_used_this_cycle + 1 })
      .eq('id', user.id);
  } else {
    await supabase
      .from('profiles')
      .update({ credits_balance: profile.credits_balance - 1 })
      .eq('id', user.id);
  }

  // ------------------------------------------------------------------
  // 9. Save generation to history
  // ------------------------------------------------------------------
  const inputContext = { productName, category, features, price, targetAudience };
  await supabase.from('generations').insert({
    user_id: user.id,
    platform,
    input_type: 'text',
    input_context: inputContext,
    output: generatedContent,
  });

  return res.status(200).json({ result: generatedContent });
};
