/**
 * stripe-webhook.js
 * POST /api/stripe-webhook
 *
 * Receives and verifies Stripe webhook events, then updates Supabase to
 * reflect the customer's subscription status and credit balance.
 *
 * Handled events:
 *   - checkout.session.completed
 *   - customer.subscription.updated
 *   - customer.subscription.deleted
 *   - invoice.payment_succeeded
 *   - invoice.payment_failed
 *
 * NO user authentication — Stripe calls this endpoint directly.
 * Requests are verified using the STRIPE_WEBHOOK_SECRET signature.
 */

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Helper: map a Stripe plan_id metadata value to monthly description limits
// ---------------------------------------------------------------------------
const PLAN_LIMITS = {
  starter:  100,
  growth:   500,
  business: 2000,
};

// ---------------------------------------------------------------------------
// Helper: retrieve the Supabase user ID from subscription or customer metadata
// ---------------------------------------------------------------------------
async function getUserIdFromCustomer(stripe, customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  return customer.metadata?.supabase_user_id || null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  // Stripe sends POST only — no CORS preflight needed, but set origin header
  // for safety
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ------------------------------------------------------------------
  // 1. Collect the raw body for signature verification
  //    Vercel serverless functions expose req as a Node.js IncomingMessage,
  //    so we read the raw bytes before any JSON parsing.
  // ------------------------------------------------------------------
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks);

  // ------------------------------------------------------------------
  // 2. Verify the Stripe webhook signature
  // ------------------------------------------------------------------
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
  });

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ------------------------------------------------------------------
  // 3. Initialise Supabase with the service role key (bypasses RLS)
  // ------------------------------------------------------------------
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ------------------------------------------------------------------
  // 4. Handle each event type
  // ------------------------------------------------------------------
  try {
    switch (event.type) {

      // ----------------------------------------------------------------
      // checkout.session.completed
      // Fired when a customer finishes the Checkout flow (subscription or
      // one-time credit purchase).
      // ----------------------------------------------------------------
      case 'checkout.session.completed': {
        const session = event.data.object;
        const mode = session.mode; // 'subscription' or 'payment'

        if (mode === 'subscription') {
          // Subscription checkout — retrieve full subscription object to get
          // metadata containing plan_id and supabase_user_id
          const subscription = await stripe.subscriptions.retrieve(
            session.subscription
          );
          const userId =
            subscription.metadata?.supabase_user_id ||
            (await getUserIdFromCustomer(stripe, session.customer));

          if (!userId) break;

          const planId = subscription.metadata?.plan_id || 'starter';
          const periodEnd = new Date(subscription.current_period_end * 1000);

          await supabase
            .from('profiles')
            .update({
              subscription_plan: planId,
              subscription_status: 'active',
              stripe_subscription_id: subscription.id,
              cycle_reset_date: periodEnd.toISOString(),
              descriptions_used_this_cycle: 0,
              monthly_description_limit: PLAN_LIMITS[planId] || 100,
            })
            .eq('id', userId);

        } else if (mode === 'payment') {
          // One-time credit purchase
          const paymentIntent = await stripe.paymentIntents.retrieve(
            session.payment_intent
          );
          const userId =
            paymentIntent.metadata?.supabase_user_id ||
            (await getUserIdFromCustomer(stripe, session.customer));

          if (!userId) break;

          const creditsToAdd = parseInt(
            paymentIntent.metadata?.credits_to_add || '0',
            10
          );

          if (creditsToAdd > 0) {
            // Increment credits_balance using a read-then-write approach
            const { data: profile } = await supabase
              .from('profiles')
              .select('credits_balance')
              .eq('id', userId)
              .single();

            const currentBalance = profile?.credits_balance || 0;
            await supabase
              .from('profiles')
              .update({ credits_balance: currentBalance + creditsToAdd })
              .eq('id', userId);
          }
        }
        break;
      }

      // ----------------------------------------------------------------
      // customer.subscription.updated
      // Fired when a subscription changes plan, status, or renewal date.
      // ----------------------------------------------------------------
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId =
          subscription.metadata?.supabase_user_id ||
          (await getUserIdFromCustomer(stripe, subscription.customer));

        if (!userId) break;

        const planId = subscription.metadata?.plan_id || 'starter';
        const status = subscription.status; // active, past_due, cancelled, etc.
        const periodEnd = new Date(subscription.current_period_end * 1000);

        await supabase
          .from('profiles')
          .update({
            subscription_plan: status === 'active' ? planId : 'none',
            subscription_status: status,
            cycle_reset_date: periodEnd.toISOString(),
            monthly_description_limit: PLAN_LIMITS[planId] || 100,
          })
          .eq('id', userId);
        break;
      }

      // ----------------------------------------------------------------
      // customer.subscription.deleted
      // Fired when a subscription is cancelled and fully ended.
      // ----------------------------------------------------------------
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId =
          subscription.metadata?.supabase_user_id ||
          (await getUserIdFromCustomer(stripe, subscription.customer));

        if (!userId) break;

        await supabase
          .from('profiles')
          .update({
            subscription_plan: 'none',
            subscription_status: 'inactive',
            stripe_subscription_id: null,
          })
          .eq('id', userId);
        break;
      }

      // ----------------------------------------------------------------
      // invoice.payment_succeeded
      // Fired on successful recurring billing.  Resets the monthly usage
      // counter and updates the cycle reset date.
      // ----------------------------------------------------------------
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;

        // Only act on subscription renewals (not the initial invoice, which
        // is handled by checkout.session.completed)
        if (invoice.billing_reason !== 'subscription_cycle') break;

        const subscription = await stripe.subscriptions.retrieve(
          invoice.subscription
        );
        const userId =
          subscription.metadata?.supabase_user_id ||
          (await getUserIdFromCustomer(stripe, invoice.customer));

        if (!userId) break;

        const periodEnd = new Date(subscription.current_period_end * 1000);

        await supabase
          .from('profiles')
          .update({
            descriptions_used_this_cycle: 0,
            cycle_reset_date: periodEnd.toISOString(),
            subscription_status: 'active',
          })
          .eq('id', userId);
        break;
      }

      // ----------------------------------------------------------------
      // invoice.payment_failed
      // Fired when a recurring payment fails.  Mark the subscription as
      // past_due so the frontend can prompt the user to update billing.
      // ----------------------------------------------------------------
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const userId = await getUserIdFromCustomer(stripe, invoice.customer);

        if (!userId) break;

        await supabase
          .from('profiles')
          .update({ subscription_status: 'past_due' })
          .eq('id', userId);
        break;
      }

      default:
        // Unhandled event type — acknowledge receipt and move on
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (handlerErr) {
    console.error(`Error handling Stripe event ${event.type}:`, handlerErr);
    // Return 200 to prevent Stripe from retrying — log the error for
    // investigation instead of causing retry loops
    return res.status(200).json({ received: true, warning: 'Handler error logged' });
  }

  return res.status(200).json({ received: true });
};
