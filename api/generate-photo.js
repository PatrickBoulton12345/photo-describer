/**
 * generate-photo.js
 * POST /api/generate-photo
 *
 * Accepts a multipart FormData payload containing an image plus optional
 * product context and brand-voice settings.  Calls the Anthropic Claude
 * vision API and returns platform-specific e-commerce copy as JSON.
 *
 * Auth: Bearer token verified against Supabase.
 * Rate limit: 10 requests per minute per user (in-memory store).
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// In-memory rate-limit store
// Key: userId, Value: { count, windowStart }
// This resets when the serverless instance is recycled, which is acceptable
// for low-volume serverless deployments.
// ---------------------------------------------------------------------------
const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Returns true if the user has exceeded their rate limit.
 */
function isRateLimited(userId) {
  const now = Date.now();
  const entry = rateLimitStore.get(userId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Start a fresh window
    rateLimitStore.set(userId, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }

  entry.count += 1;
  return false;
}

// ---------------------------------------------------------------------------
// Platform-specific Claude instructions
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

/**
 * Builds the system prompt, optionally incorporating brand voice.
 */
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

/**
 * Builds the user message text from provided product context.
 */
function buildContextText(context) {
  if (!context) return '';

  const lines = [];
  if (context.productName) lines.push(`Product Name: ${context.productName}`);
  if (context.category) lines.push(`Category: ${context.category}`);
  if (context.features) lines.push(`Key Features: ${context.features}`);
  if (context.price) lines.push(`Price: ${context.price}`);
  if (context.targetAudience) lines.push(`Target Audience: ${context.targetAudience}`);

  return lines.length > 0 ? `\n\nProduct Context:\n${lines.join('\n')}` : '';
}

/**
 * Parses a multipart form body from a raw buffer.
 * Returns { fields, imageBase64, imageMimeType }.
 *
 * Note: For production you would use a library such as `formidable` or
 * `busboy`.  This lightweight parser handles the common case of a single
 * base64-encoded image field plus JSON text fields.
 */
function parseFormData(body, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) {
    throw new Error('Missing boundary in Content-Type header');
  }

  const boundary = boundaryMatch[1];
  const fields = {};
  let imageBase64 = null;
  let imageMimeType = 'image/jpeg';

  // Split the body on the boundary delimiter
  const parts = body
    .split(new RegExp(`--${boundary}(?:--)?`))
    .filter((p) => p.trim() && p.trim() !== '--');

  for (const part of parts) {
    const [rawHeaders, ...bodyParts] = part.split('\r\n\r\n');
    if (!rawHeaders) continue;

    const bodyContent = bodyParts.join('\r\n\r\n').replace(/\r\n$/, '');

    const nameMatch = rawHeaders.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    const filenameMatch = rawHeaders.match(/filename="([^"]+)"/);
    if (filenameMatch) {
      // This is the file upload — treat as binary/base64
      const mimeMatch = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i);
      if (mimeMatch) imageMimeType = mimeMatch[1].trim();
      // bodyContent may arrive as base64 when sent from the browser
      imageBase64 = bodyContent;
    } else {
      fields[fieldName] = bodyContent;
    }
  }

  return { fields, imageBase64, imageMimeType };
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

  // Verify token and retrieve user
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
  // 3. Parse the form data
  // ------------------------------------------------------------------
  let imageBase64;
  let imageMimeType;
  let platform;
  let context = {};
  let brandVoice = null;

  try {
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Collect body chunks
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const parsed = parseFormData(rawBody, contentType);
      imageBase64 = parsed.imageBase64;
      imageMimeType = parsed.imageMimeType;
      platform = parsed.fields.platform || 'generic';

      // Context and brandVoice arrive as JSON strings in form fields
      if (parsed.fields.context) {
        try { context = JSON.parse(parsed.fields.context); } catch {}
      }
      if (parsed.fields.brandVoice) {
        try { brandVoice = JSON.parse(parsed.fields.brandVoice); } catch {}
      }

      // Individual context fields may also be sent as top-level form fields
      const ctxFields = ['productName', 'category', 'features', 'price', 'targetAudience'];
      for (const f of ctxFields) {
        if (parsed.fields[f] && !context[f]) context[f] = parsed.fields[f];
      }
    } else if (contentType.includes('application/json')) {
      // Accept JSON payload where image is already base64-encoded
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => resolve(JSON.parse(data)));
      });
      imageBase64 = body.image;
      imageMimeType = body.imageMimeType || 'image/jpeg';
      platform = body.platform || 'generic';
      context = {
        productName: body.productName,
        category: body.category,
        features: body.features,
        price: body.price,
        targetAudience: body.targetAudience,
      };
      brandVoice = body.brandVoice || null;
    } else {
      return res.status(400).json({ error: 'Unsupported Content-Type' });
    }
  } catch (parseErr) {
    console.error('Body parse error:', parseErr);
    return res.status(400).json({ error: 'Failed to parse request body' });
  }

  if (!imageBase64) {
    return res.status(400).json({ error: 'No image provided' });
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
  // 5. Call the Anthropic Claude API (vision)
  // ------------------------------------------------------------------
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = buildSystemPrompt(platform, brandVoice);
  const contextText = buildContextText(context);

  // Ensure the MIME type is one Claude supports
  const supportedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const safeMediaType = supportedMimeTypes.includes(imageMimeType)
    ? imageMimeType
    : 'image/jpeg';

  let claudeResponse;
  try {
    claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: safeMediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: `Please analyse this product image and generate ${platform} listing content.${contextText}

Return only valid JSON matching the specified format.`,
            },
          ],
        },
      ],
    });
  } catch (claudeErr) {
    console.error('Anthropic API error:', claudeErr);
    return res.status(502).json({ error: 'Failed to call AI service. Please try again.' });
  }

  // ------------------------------------------------------------------
  // 6. Parse Claude's JSON response
  // ------------------------------------------------------------------
  const rawText = claudeResponse.content[0]?.text || '';
  let generatedContent;

  try {
    // Strip any accidental markdown code fences
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
  // 7. Decrement usage / credits
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
  // 8. Save generation to history
  // ------------------------------------------------------------------
  await supabase.from('generations').insert({
    user_id: user.id,
    platform,
    input_type: 'photo',
    input_context: context,
    output: generatedContent,
  });

  return res.status(200).json({ result: generatedContent });
};
