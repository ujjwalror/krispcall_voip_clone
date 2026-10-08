import { LiveQueueDashboard } from '@/components/phone-system/LiveQueueDashboard';

export const metadata = {
  title: 'Live Queue Dashboard - VoIP Hub',
  description: 'Real-time call queue monitoring and agent presence matrix',
};

export default function QueueDashboardPage() {
  return <LiveQueueDashboard />;
}
