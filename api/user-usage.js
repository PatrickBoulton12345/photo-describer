/**
 * user-usage.js
 * GET /api/user-usage
 *
 * Returns a summary of the authenticated user's current usage and quotas:
 *   - plan
 *   - descriptionsUsed  (this billing cycle)
 *   - descriptionsLimit (monthly allowance for current plan)
 *   - creditsBalance
 *   - cycleResetDate    (ISO string — when the monthly counter resets)
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
  // 2. Fetch usage data from the profiles table
  // ------------------------------------------------------------------
  const { data: profile, error } = await supabase
    .from('profiles')
    .select(
      'subscription_plan, subscription_status, descriptions_used_this_cycle, monthly_description_limit, credits_balance, cycle_reset_date'
    )
    .eq('id', user.id)
    .single();

  if (error && error.code === 'PGRST116') {
    return res.status(404).json({ error: 'User profile not found' });
  }

  if (error) {
    console.error('Error fetching usage:', error);
    return res.status(500).json({ error: 'Failed to retrieve usage data' });
  }

  // ------------------------------------------------------------------
  // 3. Return a clean usage summary
  // ------------------------------------------------------------------
  return res.status(200).json({
    plan: profile.subscription_plan || 'none',
    subscriptionStatus: profile.subscription_status || 'inactive',
    descriptionsUsed: profile.descriptions_used_this_cycle || 0,
    descriptionsLimit: profile.monthly_description_limit || 0,
    creditsBalance: profile.credits_balance || 0,
    cycleResetDate: profile.cycle_reset_date || null,
    // Convenience derived values
    descriptionsRemaining: Math.max(
      0,
      (profile.monthly_description_limit || 0) -
        (profile.descriptions_used_this_cycle || 0)
    ),
    totalAvailable:
      Math.max(
        0,
        (profile.monthly_description_limit || 0) -
          (profile.descriptions_used_this_cycle || 0)
      ) + (profile.credits_balance || 0),
  });
};
