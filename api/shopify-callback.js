/**
 * shopify-callback.js
 * GET /api/shopify-callback — Handles the Shopify OAuth callback.
 *
 * Shopify redirects here after the merchant grants access. This route:
 *   1. Verifies the HMAC signature to confirm the request is from Shopify
 *   2. Extracts the user ID from the state parameter
 *   3. Validates the nonce from the state against the cookie
 *   4. Exchanges the authorisation code for a permanent access token
 *   5. Persists the access token and shop domain to the user's profile
 *   6. Redirects back to the app
 *
 * Query params (provided by Shopify):
 *   code  — temporary authorisation code
 *   shop  — the merchant's myshopify.com domain
 *   state — the state value set during shopify-auth.js: {userId}:{nonce}
 *   hmac  — HMAC signature for request verification
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
 * Verifies the Shopify HMAC signature on the callback query string.
 * Shopify signs the request using SHOPIFY_API_SECRET; we rebuild the
 * message from every query param except `hmac` and compare digests.
 *
 * @param {object} query — the raw query-string object from the request
 * @param {string} secret — SHOPIFY_API_SECRET
 * @returns {boolean}
 */
function verifyShopifyHmac(query, secret) {
  const { hmac, ...rest } = query;

  if (!hmac) return false;

  // Build the message: sorted key=value pairs joined by &
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'hex'),
      Buffer.from(hmac, 'hex')
    );
  } catch {
    // timingSafeEqual throws if buffers differ in length
    return false;
  }
}

/**
 * Parses the cookie header and returns the value for a given cookie name.
 *
 * @param {string} cookieHeader — the raw Cookie header string
 * @param {string} name — the cookie name to look up
 * @returns {string|null}
 */
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;

  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));

  return match ? match.slice(name.length + 1) : null;
}

/**
 * Validates that a shop string looks like a legitimate myshopify.com domain.
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

  const { code, shop, state, hmac } = req.query;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !apiSecret || !appUrl) {
    console.error('Missing required env vars: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, or NEXT_PUBLIC_APP_URL');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ------------------------------------------------------------------
  // 1. Validate required query parameters
  // ------------------------------------------------------------------
  if (!code || !shop || !state || !hmac) {
    return res.status(400).json({ error: 'Missing required OAuth callback parameters' });
  }

  if (!isValidShopDomain(shop)) {
    return res.status(400).json({ error: 'Invalid shop domain' });
  }

  // ------------------------------------------------------------------
  // 2. Verify the Shopify HMAC signature
  // ------------------------------------------------------------------
  const hmacValid = verifyShopifyHmac(req.query, apiSecret);
  if (!hmacValid) {
    console.warn('Shopify callback HMAC verification failed for shop:', shop);
    return res.status(403).json({ error: 'HMAC verification failed' });
  }

  // ------------------------------------------------------------------
  // 3. Parse and validate the state parameter: {userId}:{nonce}
  // ------------------------------------------------------------------
  const colonIndex = state.indexOf(':');
  if (colonIndex === -1) {
    return res.status(400).json({ error: 'Malformed state parameter' });
  }

  const userId = state.slice(0, colonIndex);
  const nonce = state.slice(colonIndex + 1);

  if (!userId || !nonce) {
    return res.status(400).json({ error: 'Malformed state parameter' });
  }

  // Validate nonce against the cookie set during shopify-auth.js
  const cookieHeader = req.headers['cookie'] || '';
  const storedNonce = parseCookie(cookieHeader, 'shopify_oauth_nonce');

  if (!storedNonce || storedNonce !== nonce) {
    console.warn('Shopify OAuth nonce mismatch — possible CSRF attempt');
    return res.status(403).json({ error: 'Invalid OAuth state — please restart the connection process' });
  }

  // ------------------------------------------------------------------
  // 4. Exchange the authorisation code for a permanent access token
  // ------------------------------------------------------------------
  let accessToken;
  try {
    const tokenResponse = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: apiKey,
          client_secret: apiSecret,
          code,
        }),
      }
    );

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Shopify token exchange failed:', tokenResponse.status, errText);
      return res.status(502).json({ error: 'Failed to obtain Shopify access token' });
    }

    const tokenData = await tokenResponse.json();
    accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('Shopify token exchange returned no access_token');
      return res.status(502).json({ error: 'Shopify did not return an access token' });
    }
  } catch (err) {
    console.error('Error exchanging Shopify auth code:', err);
    return res.status(502).json({ error: 'Failed to communicate with Shopify' });
  }

  // ------------------------------------------------------------------
  // 5. Persist the access token and shop domain to the user's profile
  // ------------------------------------------------------------------
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error: updateError } = await supabase
    .from('profiles')
    .update({
      shopify_access_token: accessToken,
      shopify_shop: shop,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (updateError) {
    console.error('Failed to save Shopify credentials to profile:', updateError);
    return res.status(500).json({ error: 'Failed to save Shopify connection' });
  }

  // Clear the nonce cookie now that it has been consumed
  res.setHeader(
    'Set-Cookie',
    'shopify_oauth_nonce=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/'
  );

  // ------------------------------------------------------------------
  // 6. Redirect back to the app with a success indicator
  // ------------------------------------------------------------------
  return res.redirect(302, `${appUrl}/#shopify-connected`);
};
