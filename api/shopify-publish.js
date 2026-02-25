/**
 * shopify-publish.js
 * POST /api/shopify-publish — Publishes a generated description to Shopify
 * as a new product.
 *
 * Auth: Bearer token required.
 *
 * Request body (JSON):
 *   generationId    {string}   — ID of the generation record (for audit purposes)
 *   title           {string}   — Product title
 *   description     {string}   — Product description (HTML permitted)
 *   tags            {string[]} — Array of product tags
 *   seoTitle        {string}   — SEO / page title meta tag
 *   metaDescription {string}   — SEO meta description
 *
 * Response (200):
 *   { success: true, productId: string, productUrl: string }
 *
 * Env vars required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
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

  const { generationId, title, description, tags, seoTitle, metaDescription } = body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }

  if (tags !== undefined && !Array.isArray(tags)) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }

  // ------------------------------------------------------------------
  // 3. Look up the user's Shopify credentials from their profile
  // ------------------------------------------------------------------
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('shopify_access_token, shopify_shop')
    .eq('id', user.id)
    .single();

  if (profileError) {
    console.error('Error fetching profile for Shopify publish:', profileError);
    return res.status(500).json({ error: 'Failed to retrieve user profile' });
  }

  if (!profile.shopify_access_token || !profile.shopify_shop) {
    return res.status(400).json({ error: 'Shopify not connected' });
  }

  const { shopify_access_token: shopifyToken, shopify_shop: shop } = profile;

  // ------------------------------------------------------------------
  // 4. Build the Shopify product payload
  // ------------------------------------------------------------------
  const metafields = [];

  if (seoTitle && typeof seoTitle === 'string' && seoTitle.trim()) {
    metafields.push({
      namespace: 'global',
      key: 'title_tag',
      value: seoTitle.trim(),
      type: 'single_line_text_field',
    });
  }

  if (metaDescription && typeof metaDescription === 'string' && metaDescription.trim()) {
    metafields.push({
      namespace: 'global',
      key: 'description_tag',
      value: metaDescription.trim(),
      type: 'single_line_text_field',
    });
  }

  const productPayload = {
    product: {
      title: title.trim(),
      body_html: description.trim(),
      tags: Array.isArray(tags) && tags.length > 0 ? tags.join(',') : undefined,
      metafields: metafields.length > 0 ? metafields : undefined,
    },
  };

  // ------------------------------------------------------------------
  // 5. Create the product via the Shopify Admin REST API
  // ------------------------------------------------------------------
  let shopifyProduct;
  try {
    const shopifyResponse = await fetch(
      `https://${shop}/admin/api/2024-01/products.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': shopifyToken,
        },
        body: JSON.stringify(productPayload),
      }
    );

    if (!shopifyResponse.ok) {
      const errText = await shopifyResponse.text();
      console.error(
        `Shopify product creation failed (${shopifyResponse.status}) for shop ${shop}:`,
        errText
      );

      // Surface Shopify's error message when possible
      let shopifyErrors;
      try {
        shopifyErrors = JSON.parse(errText);
      } catch {
        shopifyErrors = null;
      }

      return res.status(502).json({
        error: 'Failed to create product on Shopify',
        details: shopifyErrors?.errors || errText,
      });
    }

    const responseData = await shopifyResponse.json();
    shopifyProduct = responseData.product;

    if (!shopifyProduct || !shopifyProduct.id) {
      console.error('Shopify response did not contain a product object');
      return res.status(502).json({ error: 'Unexpected response from Shopify' });
    }
  } catch (err) {
    console.error('Error communicating with Shopify:', err);
    return res.status(502).json({ error: 'Failed to communicate with Shopify' });
  }

  // ------------------------------------------------------------------
  // 6. Return the new product details
  // ------------------------------------------------------------------
  const productId = String(shopifyProduct.id);
  const productUrl = `https://${shop}/admin/products/${productId}`;

  return res.status(200).json({
    success: true,
    productId,
    productUrl,
  });
};
