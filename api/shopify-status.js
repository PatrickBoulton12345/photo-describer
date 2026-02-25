/**
 * shopify-status.js
 * GET /api/shopify-status — Returns the Shopify connection status for the
 * authenticated user.
 *
 * Auth: Bearer token required.
 *
 * Response (200):
 *   { connected: true,  shop: 'mystore.myshopify.com' }
 *   { connected: false, shop: null }
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
  // 2. Fetch the user's Shopify connection details from their profile
  // ------------------------------------------------------------------
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('shopify_access_token, shopify_shop')
    .eq('id', user.id)
    .single();

  if (profileError && profileError.code === 'PGRST116') {
    return res.status(404).json({ error: 'Profile not found' });
  }

  if (profileError) {
    console.error('Error fetching profile for Shopify status:', profileError);
    return res.status(500).json({ error: 'Failed to retrieve profile' });
  }

  // A connection is considered active when both the token and shop are present
  const connected = Boolean(profile.shopify_access_token && profile.shopify_shop);

  return res.status(200).json({
    connected,
    shop: connected ? profile.shopify_shop : null,
  });
};
