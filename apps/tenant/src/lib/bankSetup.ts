// Bank setup component embedded in tenant services page
// Uses Stripe.js for ACH setup — loaded via CDN in index.html
// This is the flow: createSetupIntent → Stripe Elements → confirmSetup → webhook

export const BankSetupScript = `
// Tenant ACH Bank Setup — Stripe Financial Connections
// Called when tenant clicks "Add bank account" in services page
async function initBankSetup(clientSecret, onSuccess, onError) {
  if (!window.Stripe) {
    onError('Stripe.js not loaded. Please refresh the page.');
    return;
  }
  const stripe = Stripe(window.STRIPE_PUBLISHABLE_KEY);
  const elements = stripe.elements({ clientSecret });
  const paymentElement = elements.create('payment', {
    fields: { billingDetails: 'auto' }
  });
  paymentElement.mount('#bank-setup-element');

  document.getElementById('bank-setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });
    if (error) { onError(error.message); return; }
    if (setupIntent.status === 'succeeded') {
      onSuccess(setupIntent.paymentMethod);
    }
  });
}
`
