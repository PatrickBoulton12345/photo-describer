/**
 * stripe-portal.js
 * GET /api/stripe-portal
 *
 * Creates a Stripe Customer Portal session so the user can manage their
 * subscription, update payment details, and view invoices.
 *
 * Returns { url } which the frontend should redirect to.
 * Auth: Bearer token required.
 */

const Stripe = require('stripe');
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
  // 2. Retrieve the user's Stripe customer ID
  // ------------------------------------------------------------------
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  if (!profile.stripe_customer_id) {
    return res.status(400).json({
      error: 'No Stripe customer record found. Please make a purchase first.',
    });
  }

  // ------------------------------------------------------------------
  // 3. Create the Stripe Billing Portal session
  // ------------------------------------------------------------------
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  let portalSession;
  try {
    portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/dashboard`,
    });
  } catch (stripeErr) {
    console.error('Stripe portal session error:', stripeErr);
    return res.status(502).json({ error: 'Failed to create billing portal session' });
  }

  return res.status(200).json({ url: portalSession.url });
};
