/**
 * stripe-checkout.js
 * POST /api/stripe-checkout
 *
 * Creates a Stripe Checkout session for either a recurring subscription or a
 * one-time credit pack purchase.  Returns the hosted checkout URL.
 *
 * Supported priceType values: 'subscription' | 'credits'
 * Subscription planId: 'starter' | 'growth' | 'business'
 * Credit pack: '50' | '150' | '500'
 *
 * Auth: Bearer token required.
 */

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Pricing catalogue (EUR)
// ---------------------------------------------------------------------------
const SUBSCRIPTION_PRICES = {
  starter:  { amount: 999,  interval: 'month', label: 'Starter Plan'  },  // €9.99/mo
  growth:   { amount: 2499, interval: 'month', label: 'Growth Plan'   },  // €24.99/mo
  business: { amount: 4999, interval: 'month', label: 'Business Plan' },  // €49.99/mo
};

const CREDIT_PRICES = {
  '50':  { amount: 499,  label: '50 Credits',  credits: 50  },  // €4.99
  '150': { amount: 1199, label: '150 Credits', credits: 150 },  // €11.99
  '500': { amount: 2999, label: '500 Credits', credits: 500 },  // €29.99
};

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

  const { priceType, planId, creditPack } = body;

  if (!priceType || !['subscription', 'credits'].includes(priceType)) {
    return res.status(400).json({
      error: "priceType must be 'subscription' or 'credits'",
    });
  }

  if (priceType === 'subscription' && !SUBSCRIPTION_PRICES[planId]) {
    return res.status(400).json({
      error: `Invalid planId. Must be one of: ${Object.keys(SUBSCRIPTION_PRICES).join(', ')}`,
    });
  }

  if (priceType === 'credits' && !CREDIT_PRICES[creditPack]) {
    return res.status(400).json({
      error: `Invalid creditPack. Must be one of: ${Object.keys(CREDIT_PRICES).join(', ')}`,
    });
  }

  // ------------------------------------------------------------------
  // 3. Retrieve or create a Stripe customer for this user
  // ------------------------------------------------------------------
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('stripe_customer_id, full_name')
    .eq('id', user.id)
    .single();

  if (profileError) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
  });

  let customerId = profile.stripe_customer_id;

  if (!customerId) {
    // Create a new Stripe customer and store it
    const customer = await stripe.customers.create({
      email: user.email,
      name: profile.full_name || undefined,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;

    await supabase
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', user.id);
  }

  // ------------------------------------------------------------------
  // 4. Build the Stripe Checkout session
  // ------------------------------------------------------------------
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  let sessionParams;

  if (priceType === 'subscription') {
    const plan = SUBSCRIPTION_PRICES[planId];

    sessionParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: plan.label },
            unit_amount: plan.amount,
            recurring: { interval: plan.interval },
          },
          quantity: 1,
        },
      ],
      // Pass metadata so the webhook can identify the plan
      subscription_data: {
        metadata: {
          supabase_user_id: user.id,
          plan_id: planId,
        },
      },
      success_url: `${appUrl}/dashboard?checkout=success&type=subscription`,
      cancel_url: `${appUrl}/pricing?checkout=cancelled`,
    };
  } else {
    // One-time credit purchase
    const pack = CREDIT_PRICES[creditPack];

    sessionParams = {
      customer: customerId,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: pack.label,
              description: `${pack.credits} AI description credits`,
            },
            unit_amount: pack.amount,
          },
          quantity: 1,
        },
      ],
      // Pass metadata so the webhook can top up credits
      payment_intent_data: {
        metadata: {
          supabase_user_id: user.id,
          credit_pack: creditPack,
          credits_to_add: pack.credits,
        },
      },
      success_url: `${appUrl}/dashboard?checkout=success&type=credits`,
      cancel_url: `${appUrl}/pricing?checkout=cancelled`,
    };
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create(sessionParams);
  } catch (stripeErr) {
    console.error('Stripe session creation error:', stripeErr);
    return res.status(502).json({ error: 'Failed to create checkout session' });
  }

  return res.status(200).json({ url: session.url });
};
