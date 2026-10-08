import { QueueManagement } from '@/components/phone-system/QueueManagement';

export const metadata = {
  title: 'Call Queues - VoIP Hub',
  description: 'Manage organization inbound call queues and agent distribution policies',
};

export default function QueuesPage() {
  return <QueueManagement />;
}
