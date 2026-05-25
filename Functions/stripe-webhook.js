// netlify/functions/stripe-webhook.js
// Handles Stripe events and activates the correct exam per user

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const data = stripeEvent.data.object;

  try {
    switch (stripeEvent.type) {

      // ── Payment succeeded → activate exam ────────────────────
      case 'checkout.session.completed': {
        const userId = data.metadata?.supabase_user_id;
        const exam = data.metadata?.exam; // 'r01' or 'r02'
        if (!userId || !exam) break;

        const subscription = await stripe.subscriptions.retrieve(data.subscription);
        const periodEnd = new Date(subscription.current_period_end * 1000);

        const updateData = {
          [`${exam}_active`]: true,
          [`${exam}_subscription_id`]: data.subscription,
          [`${exam}_subscription_end`]: periodEnd.toISOString(),
          subscription_status: 'active',
          stripe_customer_id: data.customer,
        };

        await supabase.from('profiles').update(updateData).eq('id', userId);
        console.log(`✓ Activated ${exam.toUpperCase()} for user ${userId}`);
        break;
      }

      // ── Subscription renewed ──────────────────────────────────
      case 'invoice.payment_succeeded': {
        const subId = data.subscription;
        if (!subId) break;

        const subscription = await stripe.subscriptions.retrieve(subId);
        const userId = subscription.metadata?.supabase_user_id;
        const exam = subscription.metadata?.exam;
        if (!userId || !exam) break;

        const periodEnd = new Date(subscription.current_period_end * 1000);

        await supabase.from('profiles').update({
          [`${exam}_active`]: true,
          [`${exam}_subscription_end`]: periodEnd.toISOString(),
          subscription_status: 'active',
        }).eq('id', userId);

        console.log(`✓ Renewed ${exam.toUpperCase()} for user ${userId}`);
        break;
      }

      // ── Payment failed ────────────────────────────────────────
      case 'invoice.payment_failed': {
        const subId = data.subscription;
        if (!subId) break;

        const subscription = await stripe.subscriptions.retrieve(subId);
        const userId = subscription.metadata?.supabase_user_id;
        const exam = subscription.metadata?.exam;
        if (!userId) break;

        await supabase.from('profiles')
          .update({ subscription_status: 'past_due' })
          .eq('id', userId);

        console.log(`⚠ Payment failed for ${exam?.toUpperCase()} user ${userId}`);
        break;
      }

      // ── Subscription cancelled ────────────────────────────────
      case 'customer.subscription.deleted': {
        const userId = data.metadata?.supabase_user_id;
        const exam = data.metadata?.exam;
        if (!userId || !exam) break;

        await supabase.from('profiles').update({
          [`${exam}_active`]: false,
          [`${exam}_subscription_id`]: null,
        }).eq('id', userId);

        console.log(`✓ Cancelled ${exam.toUpperCase()} for user ${userId}`);
        break;
      }

      default:
        console.log(`Unhandled event: ${stripeEvent.type}`);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
    return { statusCode: 500, body: 'Internal server error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
