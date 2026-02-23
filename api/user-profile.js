/**
 * user-profile.js
 * GET /api/user-profile — Returns the authenticated user's profile
 * PUT /api/user-profile — Updates the user's full_name
 *
 * Auth: Bearer token required.
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!['GET', 'PUT'].includes(req.method)) {
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
  // GET — Return the user's profile
  // ------------------------------------------------------------------
  if (req.method === 'GET') {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error && error.code === 'PGRST116') {
      return res.status(404).json({ error: 'Profile not found' });
    }

    if (error) {
      console.error('Error fetching profile:', error);
      return res.status(500).json({ error: 'Failed to retrieve profile' });
    }

    // Exclude sensitive internal fields from the response
    const safeProfile = {
      id: profile.id,
      email: user.email,
      full_name: profile.full_name,
      subscription_plan: profile.subscription_plan,
      subscription_status: profile.subscription_status,
      credits_balance: profile.credits_balance,
      descriptions_used_this_cycle: profile.descriptions_used_this_cycle,
      monthly_description_limit: profile.monthly_description_limit,
      cycle_reset_date: profile.cycle_reset_date,
      created_at: profile.created_at,
    };

    return res.status(200).json({ profile: safeProfile });
  }

  // ------------------------------------------------------------------
  // PUT — Update the user's full_name
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

  const { full_name } = body;

  if (full_name === undefined) {
    return res.status(400).json({ error: 'full_name is required' });
  }

  if (typeof full_name !== 'string') {
    return res.status(400).json({ error: 'full_name must be a string' });
  }

  const trimmedName = full_name.trim();

  if (trimmedName.length === 0) {
    return res.status(400).json({ error: 'full_name cannot be empty' });
  }

  if (trimmedName.length > 200) {
    return res.status(400).json({ error: 'full_name must not exceed 200 characters' });
  }

  const { data: updatedProfile, error: updateError } = await supabase
    .from('profiles')
    .update({ full_name: trimmedName, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating profile:', updateError);
    return res.status(500).json({ error: 'Failed to update profile' });
  }

  return res.status(200).json({
    profile: {
      id: updatedProfile.id,
      email: user.email,
      full_name: updatedProfile.full_name,
      subscription_plan: updatedProfile.subscription_plan,
      subscription_status: updatedProfile.subscription_status,
      credits_balance: updatedProfile.credits_balance,
      descriptions_used_this_cycle: updatedProfile.descriptions_used_this_cycle,
      monthly_description_limit: updatedProfile.monthly_description_limit,
      cycle_reset_date: updatedProfile.cycle_reset_date,
      created_at: updatedProfile.created_at,
    },
  });
};
