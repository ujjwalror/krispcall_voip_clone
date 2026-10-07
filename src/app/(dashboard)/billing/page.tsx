import { redirect } from 'next/navigation';

export default function BillingRootRedirectPage() {
  redirect('/billing/numbers');
}
