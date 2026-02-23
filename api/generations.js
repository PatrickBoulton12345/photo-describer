/**
 * generations.js
 * GET /api/generations
 *
 * Returns the authenticated user's generation history from the generations
 * table, ordered by creation date descending.
 *
 * Query parameters:
 *   limit    — number of records to return (default 20, max 100)
 *   offset   — records to skip for pagination (default 0)
 *   platform — filter by platform ('ebay', 'etsy', 'amazon', 'shopify', 'generic')
 *
 * Auth: Bearer token required.
 */

const { createClient } = require('@supabase/supabase-js');

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
  // 2. Parse and validate query parameters
  // ------------------------------------------------------------------
  const queryParams = req.query || {};

  // Parse URL query string manually if req.query is not populated (some
  // Vercel configurations forward the full URL in req.url)
  if (!queryParams.limit && req.url && req.url.includes('?')) {
    const urlObj = new URL(req.url, `http://localhost`);
    queryParams.limit = urlObj.searchParams.get('limit');
    queryParams.offset = urlObj.searchParams.get('offset');
    queryParams.platform = urlObj.searchParams.get('platform');
  }

  let limit = parseInt(queryParams.limit, 10) || 20;
  let offset = parseInt(queryParams.offset, 10) || 0;
  const platform = queryParams.platform || null;

  // Enforce sensible bounds
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  if (offset < 0) offset = 0;

  const validPlatforms = ['ebay', 'etsy', 'amazon', 'shopify', 'generic'];
  if (platform && !validPlatforms.includes(platform)) {
    return res.status(400).json({
      error: `Invalid platform filter. Must be one of: ${validPlatforms.join(', ')}`,
    });
  }

  // ------------------------------------------------------------------
  // 3. Query the generations table
  // ------------------------------------------------------------------
  let query = supabase
    .from('generations')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (platform) {
    query = query.eq('platform', platform);
  }

  const { data: generations, error: queryError, count } = await query;

  if (queryError) {
    console.error('Error fetching generations:', queryError);
    return res.status(500).json({ error: 'Failed to retrieve generation history' });
  }

  return res.status(200).json({
    generations: generations || [],
    pagination: {
      total: count || 0,
      limit,
      offset,
      hasMore: offset + limit < (count || 0),
    },
  });
};
