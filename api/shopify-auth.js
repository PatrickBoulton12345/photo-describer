/**
 * shopify-auth.js
 * GET /api/shopify-auth — Initiates the Shopify OAuth flow for a given shop.
 *
 * Auth: Bearer token required. The user ID is embedded in the OAuth state
 * parameter so it can be retrieved during the callback redirect.
 *
 * Query params:
 *   shop — the merchant's myshopify.com domain, e.g. mystore.myshopify.com
 *
 * -- Database migration required --
 * Run the following SQL against your Supabase database before using this
 * integration:
 *
 *   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS shopify_access_token TEXT;
 *   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS shopify_shop TEXT;
 *
 * Env vars required:
 *   SHOPIFY_API_KEY
 *   SHOPIFY_API_SECRET
 *   NEXT_PUBLIC_APP_URL
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates that a shop string looks like a legitimate myshopify.com domain.
 * This guards against open-redirect attacks via the shop parameter.
 */
function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ------------------------------------------------------------------
  // 1. Authenticate the request
  // Accept token from Authorization header OR query parameter (for browser redirects)
  // ------------------------------------------------------------------
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || req.query.token || '';

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
  // 2. Validate the shop query parameter
  // ------------------------------------------------------------------
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).json({ error: 'shop query parameter is required' });
  }

  if (!isValidShopDomain(shop)) {
    return res.status(400).json({ error: 'Invalid shop domain. Must be a valid myshopify.com domain' });
  }

  // ------------------------------------------------------------------
  // 3. Build the OAuth state: {userId}:{nonce}
  // The nonce provides CSRF protection; the userId lets the callback
  // route know which Supabase user to associate the access token with.
  // ------------------------------------------------------------------
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = `${user.id}:${nonce}`;

  // ------------------------------------------------------------------
  // 4. Store the nonce in a short-lived cookie so the callback can
  //    validate it (CSRF protection).
  // ------------------------------------------------------------------
  res.setHeader(
    'Set-Cookie',
    `shopify_oauth_nonce=${nonce}; HttpOnly; Secure; SameSite=Lax; Max-Age=300; Path=/`
  );

  // ------------------------------------------------------------------
  // 5. Build and redirect to the Shopify OAuth authorisation URL
  // ------------------------------------------------------------------
  const apiKey = process.env.SHOPIFY_API_KEY;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!apiKey || !appUrl) {
    console.error('Missing required env vars: SHOPIFY_API_KEY or NEXT_PUBLIC_APP_URL');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const redirectUri = encodeURIComponent(`${appUrl}/api/shopify-callback`);
  const scopes = 'write_products,read_products';

  const oauthUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${apiKey}` +
    `&scope=${scopes}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(302, oauthUrl);
};
